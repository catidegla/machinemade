import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'machinemade.mjs');

async function mm(args, cwd) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd, windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function repo(t) {
  const dir = await mkdtemp(join(tmpdir(), 'machinemade-cli-'));
  const git = (...args) => exec('git', args, { cwd: dir, windowsHide: true });

  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');

  t.after(() => rm(dir, { recursive: true, force: true }));

  return { dir, git };
}

const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

test('version and help answer without needing a repository', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'machinemade-bare-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.match((await mm(['--version'], dir)).stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.match((await mm([], dir)).stdout, /attestable to somebody who does not trust you/);
});

test('outside a repository it says so instead of failing obscurely', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'machinemade-bare2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await mm(['report'], dir);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /not inside a git repository/);
});

test('the whole flow: mark, record, blame, report, attest, verify', async (t) => {
  const r = await repo(t);

  await writeFile(join(r.dir, 'a.txt'), numbered(10));
  await r.git('add', 'a.txt');
  await r.git('commit', '-q', '-m', 'first');

  /* Declare. The generator does this, or a person does. */
  const marked = await mm(['mark', 'a.txt', '--lines', '3-5', '--generator', 'claude-code', '--model', 'claude-opus-5'], r.dir);
  assert.equal(marked.code, 0, marked.stderr);
  assert.match(marked.stdout, /3 line\(s\)/);

  /* Capture it onto the commit. The hook calls this. */
  const recorded = await mm(['record'], r.dir);
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.match(recorded.stdout, /Recorded 1 declaration/);

  /* Read it back per line. */
  const blamed = await mm(['blame', 'a.txt', '--json'], r.dir);
  const attribution = JSON.parse(blamed.stdout);

  assert.equal(attribution.counts.machine, 3);
  assert.equal(attribution.counts.unknown, 7);
  assert.equal(attribution.lines[2].generator, 'claude-code');

  /* Totals. */
  const reported = await mm(['report', '--json'], r.dir);
  assert.equal(JSON.parse(reported.stdout).totals.machine, 3);

  /* Attest, then verify. */
  const attested = await mm(['attest', '--out', 'statement.json'], r.dir);
  assert.equal(attested.code, 0, attested.stderr);

  const verified = await mm(['verify', 'statement.json'], r.dir);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  assert.match(verified.stdout, /matches this repository/);
});

test('a tampered statement fails verification with a non-zero exit', async (t) => {
  const r = await repo(t);

  await writeFile(join(r.dir, 'a.txt'), numbered(6));
  await r.git('add', 'a.txt');
  await r.git('commit', '-q', '-m', 'first');

  await mm(['mark', 'a.txt', '--lines', '1-3', '--generator', 'g'], r.dir);
  await mm(['record'], r.dir);
  await mm(['attest', '--out', 'statement.json'], r.dir);

  const statement = JSON.parse(await readFile(join(r.dir, 'statement.json'), 'utf8'));
  statement.predicate.files[0].evidence[0].lineHash = 'f'.repeat(64);
  await writeFile(join(r.dir, 'statement.json'), JSON.stringify(statement));

  const result = await mm(['verify', 'statement.json'], r.dir);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /problem/);
});

test('the pending file is cleared once recorded, so nothing is counted twice', async (t) => {
  const r = await repo(t);

  await writeFile(join(r.dir, 'a.txt'), numbered(6));
  await r.git('add', 'a.txt');
  await r.git('commit', '-q', '-m', 'first');

  await mm(['mark', 'a.txt', '--lines', '1-2'], r.dir);
  await mm(['record'], r.dir);

  const second = await mm(['record'], r.dir);
  assert.match(second.stdout, /Nothing pending/);

  assert.equal(JSON.parse((await mm(['blame', 'a.txt', '--json'], r.dir)).stdout).counts.machine, 2);
});

test('mark refuses a range it cannot read rather than guessing', async (t) => {
  const r = await repo(t);
  await writeFile(join(r.dir, 'a.txt'), numbered(4));
  await r.git('add', 'a.txt');
  await r.git('commit', '-q', '-m', 'first');

  const result = await mm(['mark', 'a.txt', '--lines', 'ten to twelve'], r.dir);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /could not read/);
});

test('mark without lines is refused', async (t) => {
  const r = await repo(t);
  await writeFile(join(r.dir, 'a.txt'), numbered(4));
  await r.git('add', 'a.txt');
  await r.git('commit', '-q', '-m', 'first');

  assert.equal((await mm(['mark', 'a.txt'], r.dir)).code, 2);
});

test('a repository nobody has marked reports unknown rather than nothing', async (t) => {
  const r = await repo(t);
  await writeFile(join(r.dir, 'a.txt'), numbered(5));
  await r.git('add', 'a.txt');
  await r.git('commit', '-q', '-m', 'first');

  const result = await mm(['report'], r.dir);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Nothing has been declared yet/);
  assert.match(result.stdout, /correct reading of a repository nobody has marked/);
});

test('the undeclared gate fails a run that is mostly undeclared', async (t) => {
  // The realistic policy is not "use less AI", it is "declare what you use".
  const r = await repo(t);
  await writeFile(join(r.dir, 'a.txt'), numbered(10));
  await r.git('add', 'a.txt');
  await r.git('commit', '-q', '-m', 'first');

  await mm(['mark', 'a.txt', '--lines', '1-2'], r.dir);
  await mm(['record'], r.dir);

  const strict = await mm(['report', '--require-declared', '50'], r.dir);
  assert.equal(strict.code, 1);
  assert.match(strict.stderr, /undeclared/);

  const lenient = await mm(['report', '--require-declared', '95'], r.dir);
  assert.equal(lenient.code, 0);
});

test('install writes the hook and prints the refspecs rather than setting them', async (t) => {
  const r = await repo(t);
  const result = await mm(['install'], r.dir);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Notes do not travel with a normal push/);
  assert.match(result.stdout, /remote\.origin\.push/);

  const hook = await readFile(join(r.dir, '.git', 'hooks', 'post-commit'), 'utf8');
  assert.match(hook, /machinemade record/);
});

test('log lists what each commit declared', async (t) => {
  const r = await repo(t);
  await writeFile(join(r.dir, 'a.txt'), numbered(8));
  await r.git('add', 'a.txt');
  await r.git('commit', '-q', '-m', 'first');

  const empty = await mm(['log'], r.dir);
  assert.match(empty.stdout, /No commit carries a declaration yet/);

  await mm(['mark', 'a.txt', '--lines', '1-4', '--generator', 'claude-code'], r.dir);
  await mm(['record'], r.dir);

  const listed = await mm(['log'], r.dir);
  assert.match(listed.stdout, /4 machine/);
  assert.match(listed.stdout, /claude-code/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { headCommit, writeNote, readNote } from '../src/git.mjs';
import { Origin } from '../src/origin.mjs';
import { declaration, notePayload } from '../src/declare.mjs';
import { attributeFile, tally, byGenerator } from '../src/attribute.mjs';

const exec = promisify(execFile);

/** A throwaway repository, configured enough to commit without a global config. */
async function repo(t) {
  const dir = await mkdtemp(join(tmpdir(), 'machinemade-'));
  const run = (...args) => exec('git', args, { cwd: dir, windowsHide: true });

  await run('init', '-q', '-b', 'main');
  await run('config', 'user.email', 'test@example.invalid');
  await run('config', 'user.name', 'Test');
  await run('config', 'commit.gpgsign', 'false');

  t.after(() => rm(dir, { recursive: true, force: true }));

  return {
    dir,
    run,
    async commit(path, content, message = 'change') {
      await writeFile(join(dir, path), content);
      await run('add', path);
      await run('commit', '-q', '-m', message);
      return headCommit(dir);
    },
  };
}

const numbered = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => `line ${i + from}`).join('\n');

test('a declaration attributes exactly the lines it names', async (t) => {
  const r = await repo(t);
  const commit = await r.commit('a.txt', numbered(10));

  await writeNote(commit, notePayload(commit, [
    declaration({ path: 'a.txt', ranges: [[3, 5]], generator: 'claude-code', model: 'claude-opus-5' }),
  ]), r.dir);

  const { lines } = await attributeFile(commit, 'a.txt', { cwd: r.dir });
  const machine = lines.filter((l) => l.origin === Origin.Machine).map((l) => l.line);

  assert.deepEqual(machine, [3, 4, 5]);
  assert.equal(lines[2].generator, 'claude-code');
  assert.equal(lines[0].origin, Origin.Unknown);
});

test('the attribution survives lines being inserted above it', async (t) => {
  // This is the test the whole design exists for. A tool that stores line
  // numbers and reads them back literally passes the test above and fails
  // this one, which means it is wrong from the first edit onwards.
  const r = await repo(t);
  const first = await r.commit('a.txt', numbered(10));

  await writeNote(first, notePayload(first, [
    declaration({ path: 'a.txt', ranges: [[3, 5]], generator: 'claude-code' }),
  ]), r.dir);

  // Two new lines at the top. The declared code is now at 5 to 7.
  await r.commit('a.txt', 'new one\nnew two\n' + numbered(10), 'insert above');
  const head = await headCommit(r.dir);

  const { lines } = await attributeFile(head, 'a.txt', { cwd: r.dir });
  const machine = lines.filter((l) => l.origin === Origin.Machine).map((l) => l.line);

  assert.deepEqual(machine, [5, 6, 7], 'the declaration must follow the code, not the line number');

  // And the new lines are unknown, because nobody declared them.
  assert.equal(lines[0].origin, Origin.Unknown);
  assert.equal(lines[1].origin, Origin.Unknown);
});

test('the attribution survives lines being removed above it', async (t) => {
  const r = await repo(t);
  const first = await r.commit('a.txt', numbered(10));

  await writeNote(first, notePayload(first, [
    declaration({ path: 'a.txt', ranges: [[6, 8]] }),
  ]), r.dir);

  // Drop the first three lines. The declared code moves to 3 to 5.
  await r.commit('a.txt', numbered(7, 4), 'delete above');
  const head = await headCommit(r.dir);

  const { lines } = await attributeFile(head, 'a.txt', { cwd: r.dir });

  assert.deepEqual(lines.filter((l) => l.origin === Origin.Machine).map((l) => l.line), [3, 4, 5]);
});

test('a declared line that was later deleted simply stops being counted', async (t) => {
  const r = await repo(t);
  const first = await r.commit('a.txt', numbered(10));

  await writeNote(first, notePayload(first, [
    declaration({ path: 'a.txt', ranges: [[1, 10]] }),
  ]), r.dir);

  await r.commit('a.txt', numbered(3), 'shrink');
  const head = await headCommit(r.dir);

  const counts = tally((await attributeFile(head, 'a.txt', { cwd: r.dir })).lines);

  assert.equal(counts.total, 3);
  assert.equal(counts[Origin.Machine], 3);
});

test('declarations from two commits both land on the same file', async (t) => {
  const r = await repo(t);
  const first = await r.commit('a.txt', numbered(5));

  await writeNote(first, notePayload(first, [
    declaration({ path: 'a.txt', ranges: [[1, 2]], generator: 'copilot' }),
  ]), r.dir);

  await r.commit('a.txt', numbered(5) + '\nsix\nseven', 'append');
  const second = await headCommit(r.dir);

  await writeNote(second, notePayload(second, [
    declaration({ path: 'a.txt', ranges: [[6, 7]], generator: 'claude-code' }),
  ]), r.dir);

  const { lines } = await attributeFile(second, 'a.txt', { cwd: r.dir });
  const counts = tally(lines);

  assert.equal(counts[Origin.Machine], 4);
  assert.deepEqual(
    byGenerator(lines).map((g) => [g.generator, g.count]).sort(),
    [['claude-code', 2], ['copilot', 2]],
  );
});

test('a hand declaration is recorded as hand, not folded into machine', async (t) => {
  const r = await repo(t);
  const commit = await r.commit('a.txt', numbered(6));

  await writeNote(commit, notePayload(commit, [
    declaration({ path: 'a.txt', ranges: [[1, 2]], origin: Origin.Machine }),
    declaration({ path: 'a.txt', ranges: [[3, 4]], origin: Origin.Hand }),
  ]), r.dir);

  const counts = tally((await attributeFile(commit, 'a.txt', { cwd: r.dir })).lines);

  assert.equal(counts[Origin.Machine], 2);
  assert.equal(counts[Origin.Hand], 2);
  assert.equal(counts[Origin.Unknown], 2);
});

test('an undeclared file is entirely unknown and never guessed at', async (t) => {
  const r = await repo(t);
  const commit = await r.commit('a.txt', numbered(4));

  const counts = tally((await attributeFile(commit, 'a.txt', { cwd: r.dir })).lines);

  assert.equal(counts[Origin.Unknown], 4);
  assert.equal(counts[Origin.Machine], 0);
  assert.equal(counts.share[Origin.Unknown], 1);
});

test('shares are over the whole file, never over the declared part', async (t) => {
  // Two declared lines in a hundred is two percent machine. A tool dividing by
  // the declared subset would call it a hundred percent, which is the number
  // that ends up in a procurement answer.
  const r = await repo(t);
  const commit = await r.commit('a.txt', numbered(100));

  await writeNote(commit, notePayload(commit, [
    declaration({ path: 'a.txt', ranges: [[1, 2]] }),
  ]), r.dir);

  const counts = tally((await attributeFile(commit, 'a.txt', { cwd: r.dir })).lines);

  assert.equal(counts.share[Origin.Machine], 0.02);
  assert.equal(counts.share[Origin.Unknown], 0.98);
});

test('a note on a commit that never touched the file changes nothing', async (t) => {
  const r = await repo(t);
  await r.commit('a.txt', numbered(4));
  const second = await r.commit('b.txt', numbered(4), 'other file');

  await writeNote(second, notePayload(second, [
    declaration({ path: 'b.txt', ranges: [[1, 4]] }),
  ]), r.dir);

  const counts = tally((await attributeFile(second, 'a.txt', { cwd: r.dir })).lines);

  assert.equal(counts[Origin.Machine], 0);
});

test('a commit with no note is read as unknown rather than as an error', async (t) => {
  const r = await repo(t);
  const commit = await r.commit('a.txt', numbered(3));

  assert.equal(await readNote(commit, r.dir), null);

  const counts = tally((await attributeFile(commit, 'a.txt', { cwd: r.dir })).lines);
  assert.equal(counts[Origin.Unknown], 3);
});

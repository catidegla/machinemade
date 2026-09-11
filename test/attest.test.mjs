import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { headCommit, writeNote } from '../src/git.mjs';
import { Origin } from '../src/origin.mjs';
import { declaration, notePayload } from '../src/declare.mjs';
import { attest, verify, gitBlobHash, STATEMENT_TYPE, PREDICATE_TYPE } from '../src/attest.mjs';

const exec = promisify(execFile);

async function repo(t) {
  const dir = await mkdtemp(join(tmpdir(), 'machinemade-attest-'));
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

const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

async function declared(t) {
  const r = await repo(t);
  const commit = await r.commit('a.txt', numbered(10));

  await writeNote(commit, notePayload(commit, [
    declaration({ path: 'a.txt', ranges: [[3, 5]], generator: 'claude-code', model: 'claude-opus-5' }),
  ]), r.dir);

  return { r, commit };
}

/* ------------------------------------------------------- the blob hash */

test('the blob hash is the one git itself computes', async (t) => {
  // If this drifts from git, a verifier using git hash-object gets a
  // different answer and every attestation reads as tampered.
  const r = await repo(t);
  await r.commit('a.txt', 'hello\n');

  const { stdout } = await exec('git', ['hash-object', 'a.txt'], { cwd: r.dir, windowsHide: true });

  assert.equal(gitBlobHash('hello\n'), stdout.trim());
});

test('an empty file hashes to git\'s empty blob', async () => {
  assert.equal(gitBlobHash(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

/* ------------------------------------------------------- the statement */

test('the statement is an in-toto envelope with a machinemade predicate', async (t) => {
  const { r, commit } = await declared(t);
  const statement = await attest(commit, { cwd: r.dir });

  assert.equal(statement._type, STATEMENT_TYPE);
  assert.equal(statement.predicateType, PREDICATE_TYPE);
  assert.equal(statement.predicate.commit, commit);
});

test('every subject carries the hash a stranger can recompute', async (t) => {
  const { r, commit } = await declared(t);
  const statement = await attest(commit, { cwd: r.dir });

  assert.equal(statement.subject.length, 1);
  assert.equal(statement.subject[0].name, 'a.txt');
  assert.equal(statement.subject[0].digest.gitBlob, gitBlobHash(numbered(10)));
});

test('the totals count unknown lines rather than hiding them', async (t) => {
  const { r, commit } = await declared(t);
  const { totals } = (await attest(commit, { cwd: r.dir })).predicate;

  assert.equal(totals.machine, 3);
  assert.equal(totals.unknown, 7);
  assert.equal(totals.machineShare, 0.3);
});

test('the statement says in words what its numbers do not mean', async (t) => {
  // A number without this sentence beside it gets read as "the rest is human"
  // by the first person who quotes it in a procurement answer.
  const { r, commit } = await declared(t);
  const { interpretation } = (await attest(commit, { cwd: r.dir })).predicate;

  assert.match(interpretation, /not a statement that a person wrote them/);
  assert.match(interpretation, /never infers/);
});

test('a file nobody declared appears as a subject but carries no evidence', async (t) => {
  const r = await repo(t);
  const commit = await r.commit('plain.txt', numbered(4));
  const statement = await attest(commit, { cwd: r.dir });

  assert.equal(statement.subject.length, 1);
  assert.equal(statement.predicate.files.length, 0);
  assert.equal(statement.predicate.totals.unknown, 4);
});

/* ---------------------------------------------------------- verification */

test('a statement made from this repository verifies against it', async (t) => {
  const { r, commit } = await declared(t);
  const statement = await attest(commit, { cwd: r.dir });

  const result = await verify(statement, { cwd: r.dir });

  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.ok(result.checked.subjects > 0);
  assert.ok(result.checked.evidence > 0);
});

test('editing a declared line makes the claim fail to verify', async (t) => {
  // The whole point. Somebody hands you a statement saying a model wrote
  // lines 3 to 5. You check, and those lines are not the lines that were
  // claimed. Without the line hash this is undetectable.
  const { r, commit } = await declared(t);
  const statement = await attest(commit, { cwd: r.dir });

  // Tamper with the statement rather than the repository, which is the
  // direction an attacker would actually go.
  statement.predicate.files[0].evidence[0].lineHash = 'f'.repeat(64);

  const result = await verify(statement, { cwd: r.dir });

  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.kind === 'evidence' && /do not hash to the claim/.test(p.message)));
});

test('a subject hash that does not match is caught', async (t) => {
  const { r, commit } = await declared(t);
  const statement = await attest(commit, { cwd: r.dir });

  statement.subject[0].digest.gitBlob = '0'.repeat(40);

  const result = await verify(statement, { cwd: r.dir });

  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.kind === 'subject'));
});

test('a statement naming a file the tree does not have is caught', async (t) => {
  const { r, commit } = await declared(t);
  const statement = await attest(commit, { cwd: r.dir });

  statement.subject.push({ name: 'invented.txt', digest: { gitBlob: '0'.repeat(40) } });

  const result = await verify(statement, { cwd: r.dir });

  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /not in the tree/.test(p.message)));
});

test('a statement about a different repository is refused rather than half checked', async (t) => {
  const { r } = await declared(t);
  const other = await repo(t);
  await other.commit('z.txt', 'unrelated\n');

  const statement = await attest(await headCommit(r.dir), { cwd: r.dir });
  const result = await verify(statement, { cwd: other.dir });

  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.kind === 'commit'));
});

test('a wrong envelope is reported rather than parsed hopefully', async (t) => {
  const { r } = await declared(t);

  const result = await verify({ _type: 'something else', predicate: {} }, { cwd: r.dir });

  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.kind === 'envelope'));
});

test('every problem is collected rather than thrown on the first', async (t) => {
  const { r, commit } = await declared(t);
  const statement = await attest(commit, { cwd: r.dir });

  statement.subject[0].digest.gitBlob = '0'.repeat(40);
  statement.predicate.files[0].evidence[0].lineHash = 'f'.repeat(64);

  const result = await verify(statement, { cwd: r.dir });

  assert.ok(result.problems.length >= 2, 'the reader wants the whole list, not one round trip each');
});

test('a verified statement survives the file moving on afterwards', async (t) => {
  // The claim is about the commit it names. Later commits changing the file
  // must not invalidate a statement about an earlier release.
  const { r, commit } = await declared(t);
  const statement = await attest(commit, { cwd: r.dir });

  await r.commit('a.txt', 'completely different\n', 'rewrite');

  assert.equal((await verify(statement, { cwd: r.dir })).ok, true);
});

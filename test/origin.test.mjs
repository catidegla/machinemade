import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Origin, strongest, normaliseRanges, rangesContain, countLines, toRuns, isOrigin } from '../src/origin.mjs';
import { declaration, notePayload, hashLines, declarationsFor } from '../src/declare.mjs';

/* --------------------------------------------------------------- origins */

test('unknown is a real state, not a missing one', () => {
  // The whole honesty of the tool rests here. Undeclared is not human.
  assert.equal(isOrigin(Origin.Unknown), true);
  assert.equal(strongest(Origin.Unknown, Origin.Unknown), Origin.Unknown);
});

test('a declaration always beats silence', () => {
  assert.equal(strongest(Origin.Unknown, Origin.Machine), Origin.Machine);
  assert.equal(strongest(Origin.Unknown, Origin.Hand), Origin.Hand);
});

test('machine beats hand, so later editing cannot erase authorship', () => {
  // A line a generator wrote and a person then touched is still a line a
  // generator wrote. The conservative answer for an audit is the one where
  // machine authorship does not disappear behind an edit.
  assert.equal(strongest(Origin.Hand, Origin.Machine), Origin.Machine);
  assert.equal(strongest(Origin.Machine, Origin.Hand), Origin.Machine);
});

/* ---------------------------------------------------------------- ranges */

test('ranges are inclusive and one-based, like every tool people compare against', () => {
  assert.equal(countLines([[10, 10]]), 1);
  assert.equal(countLines([[10, 24]]), 15);
});

test('touching and overlapping runs are merged, so nothing double counts', () => {
  assert.deepEqual(normaliseRanges([[1, 3], [4, 6]]), [[1, 6]]);
  assert.deepEqual(normaliseRanges([[1, 5], [3, 9]]), [[1, 9]]);
  assert.deepEqual(normaliseRanges([[10, 12], [1, 3]]), [[1, 3], [10, 12]]);
});

test('nonsense ranges are dropped rather than stored', () => {
  assert.deepEqual(normaliseRanges([[5, 2]]), []);
  assert.deepEqual(normaliseRanges([[0, 3]]), []);
  assert.deepEqual(normaliseRanges([['x', 'y']]), []);
  assert.deepEqual(normaliseRanges(null), []);
});

test('a bare number is a single line', () => {
  assert.deepEqual(normaliseRanges([7]), [[7, 7]]);
});

test('containment is exact at both edges', () => {
  const ranges = [[10, 24]];

  assert.equal(rangesContain(ranges, 9), false);
  assert.equal(rangesContain(ranges, 10), true);
  assert.equal(rangesContain(ranges, 24), true);
  assert.equal(rangesContain(ranges, 25), false);
});

test('per-line origins collapse back into runs for display', () => {
  const runs = toRuns([Origin.Unknown, Origin.Machine, Origin.Machine, Origin.Hand]);

  assert.deepEqual(runs, [
    { origin: Origin.Unknown, start: 1, end: 1 },
    { origin: Origin.Machine, start: 2, end: 3 },
    { origin: Origin.Hand, start: 4, end: 4 },
  ]);
});

/* ---------------------------------------------------------- declarations */

test('a declaration needs a path, lines and a real origin', () => {
  assert.throws(() => declaration({ path: '', ranges: [[1, 2]] }), /path/);
  assert.throws(() => declaration({ path: 'a.ts', ranges: [] }), /covers no lines/);
  assert.throws(() => declaration({ path: 'a.ts', ranges: [[1, 2]], origin: 'maybe' }), /origin/);
});

test('declaring something unknown is refused, since that is not a declaration', () => {
  assert.throws(() => declaration({ path: 'a.ts', ranges: [[1, 2]], origin: Origin.Unknown }), /origin/);
});

test('windows separators are stored the way git stores them', () => {
  assert.equal(declaration({ path: 'src\\a.ts', ranges: [[1, 2]] }).path, 'src/a.ts');
});

/* ---------------------------------------------------------------- hashes */

test('the line hash covers exactly the declared lines', () => {
  const content = 'one\ntwo\nthree\nfour\nfive';

  assert.equal(hashLines(content, [[2, 3]]), hashLines('two\nthree', [[1, 2]]));
  assert.notEqual(hashLines(content, [[2, 3]]), hashLines(content, [[2, 4]]));
});

test('changing an undeclared line does not change the hash', () => {
  // Which is the point: the claim is about those lines, not about the file.
  const before = 'one\ntwo\nthree';
  const after = 'ONE\ntwo\nthree';

  assert.equal(hashLines(before, [[2, 3]]), hashLines(after, [[2, 3]]));
});

test('changing a declared line does change the hash', () => {
  assert.notEqual(hashLines('one\ntwo', [[2, 2]]), hashLines('one\nTWO', [[2, 2]]));
});

test('a range running off the end of the file cannot be faked into matching', () => {
  // Emitting empty strings for missing lines would let a short file hash the
  // same as a longer claim, which is a hole a verifier would never see.
  assert.notEqual(hashLines('one\ntwo', [[1, 5]]), hashLines('one\ntwo\n\n\n', [[1, 5]]));
});

/* ----------------------------------------------------------------- notes */

test('two claims about the same file and generator merge into one', () => {
  const note = notePayload('abc', [
    declaration({ path: 'a.ts', ranges: [[1, 3]], generator: 'claude-code' }),
    declaration({ path: 'a.ts', ranges: [[4, 6]], generator: 'claude-code' }),
  ]);

  assert.equal(note.declarations.length, 1);
  assert.deepEqual(note.declarations[0].ranges, [[1, 6]]);
  assert.equal(note.declarations[0].lines, 6);
});

test('a merged claim drops its line hash rather than carrying a stale one', () => {
  // Neither original hash describes the merged run, and keeping one would make
  // verification fail for a reason that has nothing to do with the code.
  const note = notePayload('abc', [
    { ...declaration({ path: 'a.ts', ranges: [[1, 3]], generator: 'g' }), hash: 'aaa' },
    { ...declaration({ path: 'a.ts', ranges: [[4, 6]], generator: 'g' }), hash: 'bbb' },
  ]);

  assert.equal(note.declarations[0].hash, null);
});

test('different generators stay separate, because which tool wrote it matters', () => {
  const note = notePayload('abc', [
    declaration({ path: 'a.ts', ranges: [[1, 3]], generator: 'claude-code' }),
    declaration({ path: 'a.ts', ranges: [[10, 12]], generator: 'copilot' }),
  ]);

  assert.equal(note.declarations.length, 2);
});

test('machine and hand claims on one file stay apart', () => {
  const note = notePayload('abc', [
    declaration({ path: 'a.ts', ranges: [[1, 3]], origin: Origin.Machine }),
    declaration({ path: 'a.ts', ranges: [[10, 12]], origin: Origin.Hand }),
  ]);

  assert.equal(note.declarations.length, 2);
});

test('declarations are found by path and nothing else is returned', () => {
  const note = notePayload('abc', [
    declaration({ path: 'a.ts', ranges: [[1, 3]] }),
    declaration({ path: 'b.ts', ranges: [[1, 3]] }),
  ]);

  assert.equal(declarationsFor(note, 'a.ts').length, 1);
  assert.equal(declarationsFor(note, 'b.ts').length, 1);
  assert.equal(declarationsFor(note, 'c.ts').length, 0);
  assert.deepEqual(declarationsFor(null, 'a.ts'), []);
});

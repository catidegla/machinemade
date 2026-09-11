/**
 * Resolving a file, as it stands now, to an origin per line.
 *
 * The whole correctness of this tool lives in one decision here: a declaration
 * is looked up against the line number the line had **in the commit that
 * introduced it**, not the line number it has today.
 *
 * Without that, the tool is wrong within a day of being installed. Declare
 * lines 10 to 24 on Monday, insert an import at the top on Tuesday, and the
 * same code is at 11 to 25 while the note still says 10 to 24. A naive reader
 * now attributes one line that a model did not write and misses one it did,
 * and the error compounds with every edit above.
 *
 * git blame already carries the mapping, so this asks blame where each line
 * came from and what it was called there, then looks the declaration up in
 * that commit's own coordinates. The answer stays right no matter how far the
 * code has since moved.
 */

import { blame, readNote, fileAt } from './git.mjs';
import { Origin, strongest, rangesContain, toRuns } from './origin.mjs';
import { declarationsFor } from './declare.mjs';

/**
 * Per-line origin for one file at one ref.
 *
 * @returns {Promise<{path: string, lines: Array<{line: number, origin: string, commit: string, generator: ?string, model: ?string}>}>}
 */
export async function attributeFile(ref, path, { cwd = process.cwd(), noteCache = new Map() } = {}) {
  const lines = await blame(ref, path, cwd);
  const out = [];

  for (const entry of lines) {
    if (!noteCache.has(entry.commit)) {
      noteCache.set(entry.commit, await readNote(entry.commit, cwd));
    }

    const note = noteCache.get(entry.commit);
    let origin = Origin.Unknown;
    let generator = null;
    let model = null;

    for (const declaration of declarationsFor(note, path)) {
      // entry.originalLine, not entry.line. This is the line.
      if (!rangesContain(declaration.ranges, entry.originalLine)) continue;

      origin = strongest(origin, declaration.origin);
      generator ??= declaration.generator;
      model ??= declaration.model;
    }

    out.push({ line: entry.line, origin, commit: entry.commit, generator, model });
  }

  out.sort((a, b) => a.line - b.line);

  return { path, lines: out };
}

/**
 * A file's declaration history also has to follow renames.
 *
 * blame reports the commit a line came from, and a declaration is recorded
 * against the path as it was in that commit. When a file has been moved since,
 * the note is filed under the old name and looking it up under the new one
 * finds nothing. Asking blame to follow the rename and then checking both
 * names covers it, at the cost of one more lookup per commit.
 */
export async function attributeFileFollowingRenames(ref, path, { cwd = process.cwd(), noteCache = new Map() } = {}) {
  const direct = await attributeFile(ref, path, { cwd, noteCache });

  const unresolved = direct.lines.filter((l) => l.origin === Origin.Unknown);
  if (unresolved.length === 0) return direct;

  // Only pay for the rename walk when something is actually unattributed.
  const renames = await pathHistory(ref, path, cwd);
  if (renames.length === 0) return direct;

  for (const line of direct.lines) {
    if (line.origin !== Origin.Unknown) continue;

    const note = noteCache.get(line.commit);
    if (!note) continue;

    for (const oldPath of renames) {
      for (const declaration of declarationsFor(note, oldPath)) {
        const blamed = (await blame(ref, path, cwd)).find((b) => b.line === line.line);
        if (!blamed || !rangesContain(declaration.ranges, blamed.originalLine)) continue;

        line.origin = strongest(line.origin, declaration.origin);
        line.generator ??= declaration.generator;
        line.model ??= declaration.model;
      }
    }
  }

  return direct;
}

/** Every name a path has had, newest first, excluding the current one. */
async function pathHistory(ref, path, cwd) {
  const { git } = await import('./git.mjs');

  try {
    const out = await git(['log', '--follow', '--name-only', '--format=%x00', ref, '--', path], { cwd });
    const names = new Set(
      out.split('\n').map((l) => l.trim()).filter((l) => l && l !== '\0' && l !== path),
    );
    return [...names];
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------- totals */

export function tally(lines) {
  const counts = { [Origin.Machine]: 0, [Origin.Hand]: 0, [Origin.Unknown]: 0 };
  for (const line of lines) counts[line.origin] += 1;

  const total = lines.length;

  return {
    ...counts,
    total,
    // Shares are over the whole file, never over the declared subset. Dividing
    // machine by declared would turn a repository with two declared lines into
    // one that is "100 percent machine written", which is the exact shape of
    // the lie this tool is built to avoid.
    share: {
      [Origin.Machine]: total ? counts[Origin.Machine] / total : 0,
      [Origin.Hand]: total ? counts[Origin.Hand] / total : 0,
      [Origin.Unknown]: total ? counts[Origin.Unknown] / total : 0,
    },
  };
}

export function mergeTallies(tallies) {
  const summed = tallies.reduce(
    (acc, t) => ({
      [Origin.Machine]: acc[Origin.Machine] + t[Origin.Machine],
      [Origin.Hand]: acc[Origin.Hand] + t[Origin.Hand],
      [Origin.Unknown]: acc[Origin.Unknown] + t[Origin.Unknown],
      total: acc.total + t.total,
    }),
    { [Origin.Machine]: 0, [Origin.Hand]: 0, [Origin.Unknown]: 0, total: 0 },
  );

  return {
    ...summed,
    share: {
      [Origin.Machine]: summed.total ? summed[Origin.Machine] / summed.total : 0,
      [Origin.Hand]: summed.total ? summed[Origin.Hand] / summed.total : 0,
      [Origin.Unknown]: summed.total ? summed[Origin.Unknown] / summed.total : 0,
    },
  };
}

/** The per-line view collapsed into runs, which is what a reader wants. */
export function runsFor(attribution) {
  return toRuns(attribution.lines.map((l) => l.origin));
}

/**
 * Which generators appear, and how much each accounts for.
 *
 * Worth reporting separately from the totals. "Forty percent machine" and
 * "forty percent machine, all of it from one tool we have since stopped using"
 * are different facts about a codebase.
 */
export function byGenerator(lines) {
  const counts = new Map();

  for (const line of lines) {
    if (line.origin !== Origin.Machine) continue;
    const key = line.generator ?? '(undeclared generator)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([generator, count]) => ({ generator, count }))
    .sort((a, b) => b.count - a.count);
}

/** Read the file so callers can show the code next to its origin. */
export async function sourceOf(ref, path, cwd = process.cwd()) {
  const content = await fileAt(ref, path, cwd);
  return content === null ? [] : content.split('\n');
}

/**
 * What a line's origin can be, and what it can never be.
 *
 * Three states, and the third is the one every other tool in this space gets
 * wrong. They report a percentage of AI-authored code, which quietly turns
 * everything undeclared into human-written, and the number goes into a
 * procurement answer as if it were measured. It was not measured. Nobody
 * declared it, and nobody declaring something is not evidence about what
 * happened.
 *
 * So a line is machine-made when something said so, hand-written when
 * somebody said so, and unknown otherwise. Unknown is not a failure state and
 * it is not rounded away. On a repository that adopted this yesterday, almost
 * everything is unknown, and a report saying 3 percent machine, 1 percent
 * hand, 96 percent unknown is the truth. A report saying 3 percent machine and
 * 97 percent human is a lie with a decimal point in it.
 */

export const Origin = Object.freeze({
  /** A generator declared it. */
  Machine: 'machine',
  /** A person declared it, explicitly. */
  Hand: 'hand',
  /** Nobody said. The default, and the honest one. */
  Unknown: 'unknown',
});

export const ORIGINS = [Origin.Machine, Origin.Hand, Origin.Unknown];

export function isOrigin(value) {
  return ORIGINS.includes(value);
}

/**
 * Merge two claims about the same line.
 *
 * Can happen when a commit carries overlapping declarations, usually because
 * two tools both wrote one. A declaration always beats Unknown, since somebody
 * knowing something beats nobody saying anything. Machine beats Hand, because
 * a line a generator produced and a person then touched is still a line a
 * generator produced, and the conservative answer for an audit is the one that
 * does not let machine authorship disappear behind a later edit.
 */
export function strongest(a, b) {
  if (a === Origin.Machine || b === Origin.Machine) return Origin.Machine;
  if (a === Origin.Hand || b === Origin.Hand) return Origin.Hand;
  return Origin.Unknown;
}

/**
 * A run of lines with one origin.
 *
 * Ranges are inclusive on both ends and one-based, matching how git, editors
 * and every person talking about line 40 all count. Zero-based half-open would
 * be tidier and would be wrong in every bug report.
 */
export function normaliseRanges(ranges) {
  const cleaned = [];

  for (const range of ranges ?? []) {
    const [rawStart, rawEnd] = Array.isArray(range) ? range : [range, range];
    const start = Number(rawStart);
    const end = Number(rawEnd ?? rawStart);

    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 1 || end < start) continue;

    cleaned.push([start, end]);
  }

  cleaned.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // Merge touching and overlapping runs, so [[1,3],[4,6]] is stored as [[1,6]]
  // and two notes describing the same lines do not double count.
  const merged = [];

  for (const [start, end] of cleaned) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  return merged;
}

export function rangesContain(ranges, line) {
  // Linear rather than binary: declarations per commit are a handful of runs,
  // and the clarity is worth more than the microseconds.
  for (const [start, end] of ranges) {
    if (line < start) return false;
    if (line <= end) return true;
  }
  return false;
}

export function countLines(ranges) {
  return ranges.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
}

/** Turn a list of per-line origins back into runs, for display. */
export function toRuns(origins) {
  const runs = [];

  origins.forEach((origin, index) => {
    const line = index + 1;
    const last = runs.at(-1);

    if (last && last.origin === origin && last.end === line - 1) last.end = line;
    else runs.push({ origin, start: line, end: line });
  });

  return runs;
}

/**
 * The statement you hand to somebody who does not trust you.
 *
 * This is the point of the whole tool. Every other approach to this problem
 * produces a percentage, and a percentage is a claim: it says what the tool
 * believes and gives the reader no way to check it. The question an auditor
 * actually asks is not "what does your tool say", it is "how do I know your
 * tool is not lying to me".
 *
 * So an attestation here carries three things that make it checkable by a
 * stranger with nothing but a copy of the repository:
 *
 *   the git blob hash of every file it describes, which git itself computes
 *   and anybody can recompute with `git hash-object`
 *
 *   the sha256 of the exact declared lines, so a claim about lines 10 to 24
 *   can be tested against the lines that are actually there
 *
 *   the commit each declaration came from, so the claim can be traced to the
 *   note that made it rather than to this file
 *
 * A verifier who distrusts everything can take the statement, check out the
 * ref, recompute all three, and either the numbers match or they do not. That
 * is the difference between a report and an attestation.
 *
 * The envelope is in-toto's Statement shape rather than a bespoke one, because
 * the supply chain tooling people already run knows how to carry, sign and
 * store that, and inventing a format would mean asking them to build for it.
 */

import { createHash } from 'node:crypto';

import { resolve, filesAt, fileAt, readNote, blame, git } from './git.mjs';
import { Origin, strongest } from './origin.mjs';
import { declarationsFor, hashLines } from './declare.mjs';
import { attributeFile, tally, mergeTallies, byGenerator } from './attribute.mjs';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PREDICATE_TYPE = 'https://machinemade.dev/authorship/v1';

/** Git's own object id for a blob: sha1 over "blob <len>\0<content>". */
export function gitBlobHash(content) {
  const body = Buffer.from(content ?? '', 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest('hex');
}

const isText = (content) => content !== null && !content.includes('\0');

/**
 * Build a statement describing every tracked file at a ref.
 *
 * `include` narrows the subject to paths matching a prefix, because a monorepo
 * releasing one package should attest that package rather than everything
 * beside it.
 */
export async function attest(ref, { cwd = process.cwd(), include = null, now = () => new Date().toISOString() } = {}) {
  const commit = await resolve(ref, cwd);
  const all = await filesAt(commit, cwd);
  const paths = include ? all.filter((p) => p.startsWith(include)) : all;

  const subject = [];
  const files = [];
  const noteCache = new Map();
  const tallies = [];
  const skipped = [];

  for (const path of paths) {
    const content = await fileAt(commit, path, cwd);

    if (!isText(content)) {
      // Binary files have no lines to attribute. Listed rather than dropped,
      // so the statement covers the tree it claims to cover.
      skipped.push(path);
      continue;
    }

    const attribution = await attributeFile(commit, path, { cwd, noteCache });
    const counts = tally(attribution.lines);
    tallies.push(counts);

    subject.push({ name: path, digest: { gitBlob: gitBlobHash(content) } });

    const declared = attribution.lines.filter((l) => l.origin !== Origin.Unknown);

    if (declared.length === 0) continue;

    files.push({
      path,
      lines: counts.total,
      machine: counts[Origin.Machine],
      hand: counts[Origin.Hand],
      unknown: counts[Origin.Unknown],
      generators: byGenerator(attribution.lines),
      // The evidence a verifier recomputes. One entry per commit that
      // contributed declared lines, each carrying the hash of exactly those
      // lines as that commit left them.
      evidence: await evidenceFor(commit, path, attribution, cwd, noteCache),
    });
  }

  const totals = mergeTallies(tallies);

  return {
    _type: STATEMENT_TYPE,
    subject,
    predicateType: PREDICATE_TYPE,
    predicate: {
      commit,
      ref,
      generatedAt: now(),
      // Said in the document itself, because a number without this sentence
      // beside it will be read as "the rest is human".
      interpretation:
        'Counts describe declared authorship only. Lines counted as unknown were never declared ' +
        'by anything, which is not a statement that a person wrote them. This tool records ' +
        'declarations and never infers authorship from the shape of code.',
      totals: {
        files: subject.length,
        skippedBinary: skipped.length,
        lines: totals.total,
        machine: totals[Origin.Machine],
        hand: totals[Origin.Hand],
        unknown: totals[Origin.Unknown],
        machineShare: totals.share[Origin.Machine],
        handShare: totals.share[Origin.Hand],
        unknownShare: totals.share[Origin.Unknown],
      },
      files,
    },
  };
}

/**
 * The per-commit line hashes backing one file's declarations.
 *
 * Grouped by the commit that introduced the lines, because that is the commit
 * whose note made the claim and whose blob a verifier has to read to check it.
 */
async function evidenceFor(ref, path, attribution, cwd, noteCache) {
  const byCommit = new Map();

  for (const line of attribution.lines) {
    if (line.origin === Origin.Unknown) continue;
    if (!byCommit.has(line.commit)) byCommit.set(line.commit, []);
    byCommit.get(line.commit).push(line.line);
  }

  const evidence = [];

  for (const [commit, lines] of byCommit) {
    const note = noteCache.get(commit) ?? await readNote(commit, cwd);
    const declarations = declarationsFor(note, path);

    for (const declaration of declarations) {
      const atCommit = await fileAt(commit, path, cwd);
      if (atCommit === null) continue;

      evidence.push({
        commit,
        origin: declaration.origin,
        generator: declaration.generator,
        model: declaration.model,
        ranges: declaration.ranges,
        // Recomputable: read this blob out of the object store, take these
        // ranges, hash them, compare.
        lineHash: hashLines(atCommit, declaration.ranges),
        blobAtCommit: gitBlobHash(atCommit),
      });
    }
  }

  return evidence;
}

/* ---------------------------------------------------------------- verify */

/**
 * Check a statement against the repository it describes.
 *
 * Every failure is collected rather than thrown on the first, because the
 * person running this wants the whole list, and because a statement failing in
 * one place and passing everywhere else is a different situation from one that
 * does not describe this repository at all.
 */
export async function verify(statement, { cwd = process.cwd() } = {}) {
  const problems = [];
  const note = (kind, message, detail = {}) => problems.push({ kind, message, ...detail });

  if (statement?._type !== STATEMENT_TYPE) {
    note('envelope', `not an in-toto statement: _type was ${statement?._type ?? 'absent'}`);
  }

  if (statement?.predicateType !== PREDICATE_TYPE) {
    note('envelope', `not a machinemade predicate: predicateType was ${statement?.predicateType ?? 'absent'}`);
  }

  const commit = statement?.predicate?.commit;

  if (!commit) {
    note('envelope', 'the statement names no commit, so there is nothing to check it against');
    return { ok: false, problems, checked: { subjects: 0, evidence: 0 } };
  }

  try {
    await resolve(commit, cwd);
  } catch {
    note('commit', `commit ${String(commit).slice(0, 12)} is not in this repository`);
    return { ok: false, problems, checked: { subjects: 0, evidence: 0 } };
  }

  let subjects = 0;
  let evidenceChecked = 0;

  for (const entry of statement.subject ?? []) {
    const content = await fileAt(commit, entry.name, cwd);

    if (content === null) {
      note('subject', `${entry.name} is in the statement but not in the tree at that commit`);
      continue;
    }

    const actual = gitBlobHash(content);
    subjects += 1;

    if (actual !== entry.digest?.gitBlob) {
      note('subject', `${entry.name} does not hash to what the statement claims`, {
        path: entry.name, claimed: entry.digest?.gitBlob, actual,
      });
    }
  }

  for (const file of statement.predicate?.files ?? []) {
    for (const evidence of file.evidence ?? []) {
      const atCommit = await fileAt(evidence.commit, file.path, cwd);
      evidenceChecked += 1;

      if (atCommit === null) {
        note('evidence', `${file.path} is not present at ${evidence.commit.slice(0, 8)}, which the statement says declared it`);
        continue;
      }

      if (gitBlobHash(atCommit) !== evidence.blobAtCommit) {
        note('evidence', `${file.path} at ${evidence.commit.slice(0, 8)} is not the blob the statement describes`, { path: file.path });
        continue;
      }

      const recomputed = hashLines(atCommit, evidence.ranges);

      if (recomputed !== evidence.lineHash) {
        note('evidence', `the declared lines of ${file.path} at ${evidence.commit.slice(0, 8)} do not hash to the claim`, {
          path: file.path, claimed: evidence.lineHash, actual: recomputed,
        });
      }
    }
  }

  // The counts, recomputed rather than read.
  //
  // Everything above proves the declared lines are the lines that are there.
  // None of it proves the numbers printed beside them are the numbers those
  // declarations produce, and the numbers are what somebody quotes. A
  // statement whose hashes all check out and whose totals say nought percent
  // machine would otherwise verify cleanly, which is precisely the lie this
  // format exists to make impossible.
  //
  // Recomputed from the evidence in the statement rather than from git notes,
  // so a verifier needs the tree and nothing else. The notes are how the
  // declarations got here; they are not required to check the arithmetic.
  const counted = countsFromEvidence(statement);

  for (const [path, expected] of counted.files) {
    const claimed = (statement.predicate?.files ?? []).find((f) => f.path === path);
    if (!claimed) continue;

    for (const field of ['machine', 'hand']) {
      if (claimed[field] !== expected[field]) {
        note('counts', `${path} claims ${claimed[field]} ${field} line(s) and its own evidence declares ${expected[field]}`, {
          path, field, claimed: claimed[field], actual: expected[field],
        });
      }
    }
  }

  const totals = statement.predicate?.totals;

  for (const field of ['machine', 'hand']) {
    if (totals && totals[field] !== counted.totals[field]) {
      note('counts', `the statement totals ${totals[field]} ${field} line(s) and its own evidence declares ${counted.totals[field]}`, {
        field, claimed: totals[field], actual: counted.totals[field],
      });
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    checked: { subjects, evidence: evidenceChecked, counts: counted.files.size },
  };
}

/**
 * What the declarations in a statement add up to, ignoring what it says they do.
 *
 * Overlapping ranges are resolved the way the attributor resolves them, so a
 * line claimed twice is counted once and the stronger claim wins.
 */
function countsFromEvidence(statement) {
  const files = new Map();
  const totals = { [Origin.Machine]: 0, [Origin.Hand]: 0 };

  for (const file of statement.predicate?.files ?? []) {
    const lines = new Map();

    for (const evidence of file.evidence ?? []) {
      for (const [from, to] of evidence.ranges ?? []) {
        for (let line = from; line <= to; line += 1) {
          lines.set(line, strongest(lines.get(line) ?? Origin.Unknown, evidence.origin));
        }
      }
    }

    const counts = { machine: 0, hand: 0 };
    for (const origin of lines.values()) {
      if (origin === Origin.Machine) counts.machine += 1;
      if (origin === Origin.Hand) counts.hand += 1;
    }

    files.set(file.path, counts);
    totals[Origin.Machine] += counts.machine;
    totals[Origin.Hand] += counts.hand;
  }

  return { files, totals: { machine: totals[Origin.Machine], hand: totals[Origin.Hand] } };
}

/**
 * A statement is not signed here, and that is deliberate.
 *
 * Signing belongs to whatever already holds your keys: cosign, gitsign, a
 * release pipeline with an OIDC identity. Rolling key management into a
 * provenance tool would mean asking people to trust a second implementation of
 * the hardest part, and the in-toto envelope exists precisely so that this
 * output drops into the signer they already run.
 */
export function signingHint() {
  return 'cosign attest-blob --predicate machinemade.json --type custom <artifact>';
}

#!/usr/bin/env node
/**
 * machinemade
 *
 * Which lines a machine wrote, recorded where git keeps it, in a form somebody
 * who does not trust you can check.
 */

import { readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

import { isRepository, repoRoot, resolve, headCommit, filesAt, fileAt, readNote, writeNote, notedCommits, REFSPECS, NOTES_REF } from '../src/git.mjs';
import { Origin } from '../src/origin.mjs';
import { declaration, addPending, readPending, clearPending, notePayload, hashLines, PENDING } from '../src/declare.mjs';
import { attributeFile, tally, mergeTallies, byGenerator, runsFor, sourceOf } from '../src/attribute.mjs';
import { attest, verify, signingHint } from '../src/attest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const rest = argv.slice(1).filter((a) => !a.startsWith('--'));
const has = (n) => argv.includes(`--${n}`);
const value = (n, fallback = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? fallback : argv[i + 1];
};

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: (s) => paint('1', s), dim: (s) => paint('2', s),
  green: (s) => paint('32', s), red: (s) => paint('31', s),
  yellow: (s) => paint('33', s), blue: (s) => paint('34', s),
};

const EXIT = { OK: 0, FAILED: 1, USAGE: 2 };

const MARK = { [Origin.Machine]: 'M', [Origin.Hand]: 'H', [Origin.Unknown]: ' ' };
const TINT = { [Origin.Machine]: c.blue, [Origin.Hand]: c.green, [Origin.Unknown]: c.dim };

function usage() {
  console.log(`
${c.bold('machinemade')} ${pkg.version}
Which lines a machine wrote, recorded in git notes, attestable to somebody who does not trust you.

  ${c.bold('install')}    add the commit hook and print the refspecs notes need
  ${c.bold('mark')}       declare lines as machine made or hand written
  ${c.bold('record')}     write pending declarations onto HEAD, what the hook calls
  ${c.bold('blame')}      per-line origin for a file
  ${c.bold('report')}     totals by path
  ${c.bold('attest')}     emit an in-toto statement for a ref
  ${c.bold('verify')}     check a statement against this repository
  ${c.bold('log')}        commits carrying declarations

Marking
  machinemade mark src/a.ts --lines 10-24 --generator claude-code --model claude-opus-5
  machinemade mark src/a.ts --lines 3,10-24,40 --origin hand

Options
  --lines <spec>        line ranges, one-based and inclusive: 10-24, or 3,10-24,40
  --origin <o>          machine or hand (default: machine)
  --generator <name>    what produced it: claude-code, copilot, a script
  --model <name>        the model behind the generator
  --session <id>        ties several marks to one sitting
  --ref <ref>           which commit to read (default: HEAD)
  --path <prefix>       narrow to paths under a prefix
  --out <file>          write the statement here instead of stdout
  --require-declared <n>  fail when more than n percent of lines are undeclared
  --json                machine readable output

Notes do not travel with a normal push. After install, see what it prints.
`);
}

async function needRepo() {
  if (!await isRepository()) {
    console.error(c.red('not inside a git repository.'));
    process.exit(EXIT.USAGE);
  }
  return repoRoot();
}

/** "3,10-24,40" into [[3,3],[10,24],[40,40]]. */
function parseLines(spec) {
  if (!spec) return [];

  return spec.split(',').map((part) => {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) {
      console.error(c.red(`--lines could not read "${part.trim()}". Use 10, or 10-24, or 3,10-24,40.`));
      process.exit(EXIT.USAGE);
    }
    return [Number(m[1]), Number(m[2] ?? m[1])];
  });
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

function printTotals(counts, label) {
  console.log(`  ${c.bold(label)}`);
  console.log(`    ${c.blue('machine')}  ${String(counts[Origin.Machine]).padStart(7)}  ${pct(counts.share[Origin.Machine]).padStart(7)}`);
  console.log(`    ${c.green('hand')}     ${String(counts[Origin.Hand]).padStart(7)}  ${pct(counts.share[Origin.Hand]).padStart(7)}`);
  console.log(`    ${c.dim('unknown')}  ${String(counts[Origin.Unknown]).padStart(7)}  ${pct(counts.share[Origin.Unknown]).padStart(7)}`);
  console.log(`    ${c.dim('total')}    ${String(counts.total).padStart(7)}`);
}

const commands = {
  async install() {
    const root = await needRepo();
    const hook = join(root, '.git', 'hooks', 'post-commit');

    const script = `#!/bin/sh
# machinemade: turn declarations staged before the commit into a note on it.
# Removing this file stops recording. It never rewrites a commit and never
# touches the working tree.
command -v machinemade >/dev/null 2>&1 && machinemade record --quiet || true
`;

    await writeFile(hook, script);
    await chmod(hook, 0o755).catch(() => {});

    console.log(`\n  Hook written to ${c.dim(relative(root, hook))}`);
    console.log('');
    console.log(`  ${c.bold('Notes do not travel with a normal push.')} To share the record:`);
    console.log('');
    console.log(`    git config --add remote.origin.push '${REFSPECS.push}'`);
    console.log(`    git config --add remote.origin.fetch '${REFSPECS.fetch}'`);
    console.log('');
    console.log(c.dim(`  Printed rather than set, because editing your git config without asking is not this tool's business.\n`));
  },

  async mark() {
    const root = await needRepo();
    const path = rest[0];

    if (!path) {
      console.error(c.red('mark needs a file: machinemade mark src/a.ts --lines 10-24'));
      process.exit(EXIT.USAGE);
    }

    const relativePath = relative(root, resolvePath(process.cwd(), path)).replace(/\\/g, '/');
    const ranges = parseLines(value('lines'));

    if (ranges.length === 0) {
      console.error(c.red('mark needs --lines, for example --lines 10-24'));
      process.exit(EXIT.USAGE);
    }

    let entry;
    try {
      entry = declaration({
        path: relativePath,
        ranges,
        origin: value('origin', Origin.Machine),
        generator: value('generator'),
        model: value('model'),
        session: value('session'),
      });
    } catch (error) {
      console.error(c.red(error.message));
      process.exit(EXIT.USAGE);
    }

    // Hashed against the working tree now, so the claim is pinned to the code
    // as it was when the generator produced it rather than to whatever it
    // becomes before the commit lands.
    const content = await readFile(join(root, relativePath), 'utf8').catch(() => null);
    if (content !== null) entry.hash = hashLines(content, entry.ranges);

    const pending = await addPending(root, entry);

    if (!has('quiet')) {
      console.log(`  ${TINT[entry.origin](MARK[entry.origin])} ${relativePath} ${c.dim(`${entry.lines} line(s), ${pending.length} declaration(s) pending`)}`);
    }
  },

  async record() {
    const root = await needRepo();
    const pending = await readPending(root);

    if (pending.length === 0) {
      if (!has('quiet')) console.log('  Nothing pending.');
      return;
    }

    const commit = await headCommit();
    const existing = await readNote(commit);
    const merged = notePayload(commit, [...(existing?.declarations ?? []), ...pending]);

    await writeNote(commit, merged);
    await clearPending(root);

    if (!has('quiet')) {
      console.log(`\n  Recorded ${pending.length} declaration(s) on ${c.dim(commit.slice(0, 8))}\n`);
    }
  },

  async blame() {
    await needRepo();
    const path = rest[0];

    if (!path) {
      console.error(c.red('blame needs a file'));
      process.exit(EXIT.USAGE);
    }

    const ref = await resolve(value('ref', 'HEAD'));
    const attribution = await attributeFile(ref, path);
    const counts = tally(attribution.lines);

    if (has('json')) {
      return console.log(JSON.stringify({ ...attribution, counts, runs: runsFor(attribution) }, null, 2));
    }

    const source = await sourceOf(ref, path);
    const width = String(attribution.lines.length).length;

    console.log('');
    for (const line of attribution.lines) {
      const text = source[line.line - 1] ?? '';
      const tag = line.origin === Origin.Machine && line.generator ? c.dim(` ${line.generator}`) : '';
      console.log(
        `  ${TINT[line.origin](MARK[line.origin])} ${c.dim(String(line.line).padStart(width))}  ${text}${tag}`,
      );
    }

    console.log('');
    printTotals(counts, path);
    console.log('');
  },

  async report() {
    await needRepo();
    const ref = await resolve(value('ref', 'HEAD'));
    const prefix = value('path');
    const all = await filesAt(ref);
    const paths = prefix ? all.filter((p) => p.startsWith(prefix)) : all;

    const noteCache = new Map();
    const rows = [];

    for (const path of paths) {
      const content = await fileAt(ref, path);
      if (content === null || content.includes('\0')) continue;

      const attribution = await attributeFile(ref, path, { noteCache });
      const counts = tally(attribution.lines);

      rows.push({ path, counts, generators: byGenerator(attribution.lines) });
    }

    const totals = mergeTallies(rows.map((r) => r.counts));

    if (has('json')) {
      console.log(JSON.stringify({ ref, totals, files: rows }, null, 2));
    } else {
      const declared = rows.filter((r) => r.counts[Origin.Machine] + r.counts[Origin.Hand] > 0);

      console.log('');
      if (declared.length === 0) {
        console.log(c.dim('  Nothing has been declared yet, so every line is unknown.'));
        console.log(c.dim('  That is the correct reading of a repository nobody has marked, not a bug.'));
      } else {
        const width = Math.max(...declared.map((r) => r.path.length));
        for (const row of declared) {
          console.log(
            `  ${row.path.padEnd(width)}  ${c.blue(String(row.counts[Origin.Machine]).padStart(6))}` +
            `  ${c.green(String(row.counts[Origin.Hand]).padStart(6))}` +
            `  ${c.dim(String(row.counts[Origin.Unknown]).padStart(7))}`,
          );
        }
        console.log(c.dim(`  ${''.padEnd(width)}  machine    hand  unknown`));
      }

      console.log('');
      printTotals(totals, `${rows.length} file(s) at ${ref.slice(0, 8)}`);
      console.log('');
      console.log(c.dim('  Unknown means nobody declared it. It is not a count of hand written lines.'));
      console.log('');
    }

    const limit = value('require-declared');

    if (limit !== null) {
      const undeclared = totals.share[Origin.Unknown] * 100;

      if (undeclared > Number(limit)) {
        console.error(c.red(`  ${pct(totals.share[Origin.Unknown])} of lines are undeclared, above the ${limit}% this run allows.`));
        process.exit(EXIT.FAILED);
      }
    }
  },

  async attest() {
    await needRepo();
    const ref = value('ref', 'HEAD');
    const statement = await attest(ref, { include: value('path') });
    const json = JSON.stringify(statement, null, 2);
    const out = value('out');

    if (out) {
      await writeFile(out, json + '\n');
      console.log(`\n  Wrote ${out}`);
      console.log(c.dim(`  ${statement.subject.length} file(s), ${statement.predicate.totals.lines} line(s)`));
      console.log(c.dim(`  Sign it with whatever already holds your keys:\n    ${signingHint()}\n`));
    } else {
      console.log(json);
    }
  },

  async verify() {
    await needRepo();
    const file = rest[0] ?? value('in');

    if (!file) {
      console.error(c.red('verify needs a statement: machinemade verify machinemade.json'));
      process.exit(EXIT.USAGE);
    }

    let statement;
    try {
      statement = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      console.error(c.red(`${file} is not readable JSON: ${error.message}`));
      process.exit(EXIT.USAGE);
    }

    const result = await verify(statement);

    if (has('json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('');
      if (result.ok) {
        console.log(`  ${c.green('The statement matches this repository.')}`);
        console.log(c.dim(`  ${result.checked.subjects} file hash(es) and ${result.checked.evidence} line claim(s) recomputed.`));
      } else {
        console.log(`  ${c.red(`${result.problems.length} problem(s):`)}`);
        for (const p of result.problems) console.log(`    ${c.red('x')} ${p.message}`);
      }
      console.log('');
    }

    process.exit(result.ok ? EXIT.OK : EXIT.FAILED);
  },

  async log() {
    await needRepo();
    const commits = await notedCommits();

    if (commits.length === 0) {
      return console.log(`\n  No commit carries a declaration yet. ${c.dim(`Notes live on ${NOTES_REF}.`)}\n`);
    }

    console.log('');
    for (const commit of commits) {
      const note = await readNote(commit);
      if (!note) continue;

      const machine = note.declarations.filter((d) => d.origin === Origin.Machine);
      const hand = note.declarations.filter((d) => d.origin === Origin.Hand);
      const generators = [...new Set(machine.map((d) => d.generator).filter(Boolean))];

      console.log(
        `  ${c.dim(commit.slice(0, 8))}  ${String(machine.reduce((s, d) => s + d.lines, 0)).padStart(5)} machine` +
        `  ${String(hand.reduce((s, d) => s + d.lines, 0)).padStart(5)} hand` +
        `  ${c.dim(generators.join(', '))}`,
      );
    }
    console.log('');
  },
};

if (has('version')) {
  console.log(pkg.version);
} else if (!command || has('help') || command === 'help') {
  usage();
} else if (commands[command]) {
  try {
    await commands[command]();
  } catch (error) {
    console.error(`machinemade: ${error.message}`);
    process.exit(EXIT.USAGE);
  }
} else {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(EXIT.USAGE);
}

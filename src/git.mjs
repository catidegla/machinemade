/**
 * Git, through its plumbing rather than its porcelain.
 *
 * Every command here is one git would consider stable: rev-parse, cat-file,
 * blame with --line-porcelain, notes. The porcelain commands change their
 * output between versions to suit humans, and a provenance record that
 * silently mis-parses a newer git is worse than one that refuses to run.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(message, { command = null, code = null } = {}) {
    super(message);
    this.name = 'GitError';
    this.command = command;
    this.code = code;
  }
}

/**
 * Run git and return stdout.
 *
 * maxBuffer is raised because blaming a large file through --line-porcelain
 * produces roughly a dozen lines of metadata per source line, and the default
 * one megabyte truncates silently at around eight hundred lines, which would
 * quietly under-report provenance on exactly the files worth auditing.
 */
export async function git(args, { cwd = process.cwd(), maxBuffer = 64 * 1024 * 1024 } = {}) {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer, windowsHide: true });
    return stdout;
  } catch (error) {
    throw new GitError(
      `git ${args[0]} failed: ${String(error.stderr ?? error.message).trim()}`,
      { command: args.join(' '), code: error.code ?? null },
    );
  }
}

export async function isRepository(cwd = process.cwd()) {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], { cwd })).trim() === 'true';
  } catch {
    return false;
  }
}

export async function repoRoot(cwd = process.cwd()) {
  return (await git(['rev-parse', '--show-toplevel'], { cwd })).trim();
}

export async function resolve(ref, cwd = process.cwd()) {
  return (await git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd })).trim();
}

export async function headCommit(cwd = process.cwd()) {
  return resolve('HEAD', cwd);
}

/** Files tracked at a ref, as repository-relative paths. */
export async function filesAt(ref, cwd = process.cwd()) {
  const out = await git(['ls-tree', '-r', '--name-only', '-z', ref], { cwd });
  return out.split('\0').filter(Boolean);
}

/**
 * The path as git names it, asked of git rather than computed.
 *
 * Deriving this by taking the difference between the working directory and
 * the repository root looks equivalent and is not. On Windows the two can be
 * spelled differently for the same directory: git reports the long name while
 * the environment hands you the 8.3 short one, so `C:/Users/runneradmin/...`
 * and `C:\Users\RUNNER~1\...` are one place and subtracting one from the other
 * yields a path made of `..` segments. Every declaration then files itself
 * under a name no blame lookup will ever match, and the tool records nothing
 * while reporting success.
 *
 * ls-files answers in git's own vocabulary, which is the vocabulary the notes
 * and blame both use.
 */
export async function toRepoPath(path, cwd = process.cwd()) {
  for (const args of [
    ['ls-files', '--full-name', '-z', '--', path],
    ['ls-files', '--others', '--full-name', '-z', '--', path],
  ]) {
    try {
      const out = (await git(args, { cwd })).split('\0').filter(Boolean);
      if (out.length > 0) return out[0];
    } catch {
      // Fall through to the next attempt, then to the caller's own fallback.
    }
  }

  return null;
}

/** The blob at a path and ref, or null when the path is not there. */
export async function fileAt(ref, path, cwd = process.cwd()) {
  try {
    return await git(['show', `${ref}:${path}`], { cwd });
  } catch {
    return null;
  }
}

/**
 * Who last touched every line, and which line it was when they did.
 *
 * The second half is the part that makes this tool correct rather than
 * approximately correct. A declaration recorded against lines 10 to 24 of a
 * commit does not stay at lines 10 to 24: insert a line above it tomorrow and
 * the same code is at 11 to 25. Storing line numbers and reading them back
 * literally is how every naive version of this becomes wrong within a day.
 *
 * blame already solves it. For each line in the file as it stands now, it
 * reports the commit that introduced the line and the line number it had in
 * that commit. Look the declaration up against that original number and the
 * answer stays right no matter how much the file moved afterwards.
 *
 * @returns {Promise<Array<{commit: string, originalLine: number, line: number}>>}
 */
export async function blame(ref, path, cwd = process.cwd()) {
  const out = await git(['blame', '--line-porcelain', '-w', ref, '--', path], { cwd });
  const lines = out.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    // The header of each entry: <sha> <original-line> <final-line> [count]
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(lines[i]);
    if (!header) continue;

    result.push({
      commit: header[1],
      originalLine: Number(header[2]),
      line: Number(header[3]),
    });
  }

  return result;
}

/* ----------------------------------------------------------------- notes */

/**
 * Notes live on their own ref and never touch the working tree.
 *
 * The alternative designs are worse in ways that show up later. A file in the
 * repository conflicts on every branch that touches the same code, and it
 * turns a record about history into part of the history it describes. Commit
 * trailers are visible but cannot carry line ranges, and rewriting one means
 * rewriting the commit.
 *
 * Notes are the thing git built for exactly this: data attached to a commit,
 * addressed by its hash, pushable and fetchable on request and invisible
 * otherwise.
 */
export const NOTES_REF = 'refs/notes/machinemade';

export async function readNote(commit, cwd = process.cwd()) {
  try {
    const raw = await git(['notes', '--ref', NOTES_REF, 'show', commit], { cwd });
    return JSON.parse(raw);
  } catch (error) {
    // No note is the normal case for most commits and must not be an error.
    if (error instanceof GitError) return null;
    // Malformed JSON is different: somebody wrote something we cannot read,
    // and pretending the commit has no provenance would hide that.
    throw new GitError(`the note on ${commit.slice(0, 8)} is not readable JSON: ${error.message}`);
  }
}

export async function writeNote(commit, payload, cwd = process.cwd()) {
  await git(
    ['notes', '--ref', NOTES_REF, 'add', '-f', '-m', JSON.stringify(payload), commit],
    { cwd },
  );
}

/** Every commit carrying a note, newest first. */
export async function notedCommits(cwd = process.cwd()) {
  try {
    const out = await git(['notes', '--ref', NOTES_REF, 'list'], { cwd });
    return out.trim().split('\n').filter(Boolean).map((line) => line.split(' ')[1]);
  } catch {
    return [];
  }
}

/**
 * The push and fetch refspecs, printed rather than configured silently.
 *
 * Notes do not travel with a normal push, which surprises people and is the
 * single most common way a provenance record is lost. Saying so is better than
 * editing somebody's git config behind their back.
 */
export const REFSPECS = {
  push: `${NOTES_REF}:${NOTES_REF}`,
  fetch: `+${NOTES_REF}:${NOTES_REF}`,
};

<div align="center">

# machinemade

Your git history says who committed it. It says nothing about what wrote it.

[![CI](https://github.com/catidegla/machinemade/actions/workflows/ci.yml/badge.svg)](https://github.com/catidegla/machinemade/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

```bash
npx @catidegla/machinemade install
npx @catidegla/machinemade mark src/parser.ts --lines 40-88 --generator claude-code --model claude-opus-5
git commit -m "parse the header"
npx @catidegla/machinemade blame src/parser.ts
```

```
    39  function parse(input) {
  M 40    const header = input.slice(0, 8);          claude-code
  M 41    if (!header.startsWith(MAGIC)) {           claude-code
  M 42      throw new MalformedHeader(header);       claude-code
    43    }

  src/parser.ts
    machine       49    32.7%
    hand           0     0.0%
    unknown      101    67.3%
```

## The one thing this does differently

Three tools already exist for this and all of them produce a **percentage**. A percentage is a claim: it tells the reader what the tool believes and gives them no way to check it.

The question an auditor actually asks is not *what does your tool say*. It is **how do I know your tool is not lying to me**.

So an attestation here carries the evidence to answer that:

- the **git blob hash** of every file it describes, which git itself computes and anyone can recompute with `git hash-object`
- the **sha256 of the exact declared lines**, so a claim about lines 40 to 88 can be tested against the lines that are actually there
- the **commit each declaration came from**, so the claim traces back to the note that made it rather than to this file

```bash
machinemade attest --out machinemade.json
machinemade verify machinemade.json
```

```
  The statement matches this repository.
  312 file hash(es) and 47 line claim(s) recomputed.
```

Change one declared line and it stops verifying. That is the difference between a report and an attestation.

## Unknown is not human

Every other tool in this space reports "40% AI-authored", which quietly turns everything undeclared into human-written. **Nobody measured that.** Nobody declaring something is not evidence about what happened.

So a line here is one of three things:

| | |
| :--- | :--- |
| `machine` | A generator declared it. |
| `hand` | A person declared it, explicitly. |
| `unknown` | Nobody said. The default, and the honest one. |

On a repository that adopted this yesterday, almost everything is unknown. A report saying *3% machine, 1% hand, 96% unknown* is the truth. A report saying *3% machine, 97% human* is a lie with a decimal point in it.

Shares are always over the whole file, never over the declared subset. Two declared lines in a hundred is two percent, not a hundred.

**Nothing here ever guesses.** There are heuristics that claim to spot machine-written code from its shape. They are wrong often enough that an audit built on them is worse than no audit, because it is confidently wrong in a document somebody signed.

## Line numbers move. This survives it.

Declare lines 10 to 24 on Monday. Insert an import at the top on Tuesday. The same code is now at 11 to 25, and a tool that stored line numbers and read them back literally is now attributing one line a model did not write and missing one it did. The error compounds with every edit above.

`git blame` already solves this: for every line it reports the commit that introduced it **and the line number it had in that commit**. Declarations are looked up in the introducing commit's own coordinates, so the answer stays right however far the code has since moved.

There is a test for exactly this. It declares lines 3 to 5, inserts two lines above, and asserts the attribution reports 5 to 7.

## Where the record lives

Git notes, on `refs/notes/machinemade`. Never a file in your tree.

The alternatives fail in ways that show up later. A file in the repository conflicts on every branch that touches the same code, and turns a record *about* history into part of the history it describes. Commit trailers are visible but cannot carry line ranges, and rewriting one means rewriting the commit.

**Notes do not travel with a normal push.** This is the single most common way a provenance record is lost, so `install` prints the refspecs rather than editing your git config behind your back:

```bash
git config --add remote.origin.push 'refs/notes/machinemade:refs/notes/machinemade'
git config --add remote.origin.fetch '+refs/notes/machinemade:refs/notes/machinemade'
```

## Who declares

Whoever actually knows: the agent, the harness, a wrapper script, or a person typing the command.

```bash
machinemade mark src/a.ts --lines 3,10-24,40 --generator copilot
machinemade mark src/b.ts --lines 1-12 --origin hand
```

Marks stage until the commit exists, which is the only moment both the claim and the commit hash are known. The `post-commit` hook writes them onto it. Delete the hook and recording stops; it never rewrites a commit and never touches your working tree.

## In CI

```yaml
- uses: catidegla/machinemade@v0.2.0
  with:
    attestation: machinemade.json
```

It fetches the notes ref first, which a normal checkout does not carry. Without
that step the tool finds no declarations, reports everything as undeclared and
exits clean, which reads exactly like a repository nobody has marked.

It then verifies the statement it just wrote, against the repository, the way a
consumer would. A statement that does not check out never leaves the build.

The realistic policy is not "use less AI". It is **declare what you use**:

```yaml
- run: npx @catidegla/machinemade report --require-declared 20
```

Fails when more than 20% of lines carry no declaration.

## Signing

Deliberately not done here. The output is an [in-toto](https://in-toto.io) Statement, so it drops into whatever already holds your keys:

```bash
cosign attest-blob --predicate machinemade.json --type custom <artifact>
```

Rolling key management into a provenance tool would mean asking people to trust a second implementation of the hardest part.

## What it cannot do

It cannot tell you what was AI-written before you installed it. There is no signal to recover; those lines are unknown and honestly so.

It cannot stop somebody declaring falsely. It records what was declared and makes the claim checkable against the code, which is a different guarantee and the only one available without watching the keyboard.

It cannot attribute binary files. They appear as subjects with their hashes and are counted as skipped.

## Testing

```bash
npm test    # 57 tests, nothing to install
```

Every git test runs against a real throwaway repository rather than a mock, because the behaviour being relied on is git's and a mock would only prove this code agrees with itself. The blob hash is asserted against `git hash-object` for the same reason.

## Requirements

Node 20 or later, and git. No other dependency.

## License

MIT.

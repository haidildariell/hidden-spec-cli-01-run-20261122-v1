# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/haidildariell/hidden-spec-cli-01-run-20261122-v1/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/haidildariell/hidden-spec-cli-01-run-20261122-v1/reward.svg)](https://make.fun)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. Each format is read as `SPEC.md` says, and every file is changed or
nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the
  checks from the env, runs `node main.ts` on each one in a fresh directory,
  and posts what it did.
- `check.ts`: the practice set on your own machine:
  `node check.ts ../program/generator/practice.json`
- `SPEC.md`: the whole specification.
- `LICENSE`: MIT.

## How it works

Each edit names old lines `O` that are replaced by new lines `N`. `O` is
found in the file's current lines at the first of three tiers at which it
occurs at least once: exact lines, lines equal once trailing spaces and tabs
are removed, lines equal once leading and trailing spaces and tabs are
removed. Context lines are written as the file's own matched lines, and at
tier 2 the other new lines are re-indented to the file's indentation. Edits
apply in the patch's order to the tree as earlier edits left it; a failed
edit changes nothing and the edits after it still run, so every failure is
reported; when any edit failed, no file is written.

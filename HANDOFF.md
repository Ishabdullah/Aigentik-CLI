# Handoff

Read this first if you are picking up this project cold — a new coding agent, a new session, or a human who wasn't here for the last round of changes. It is not a status report. It contains no facts about the current state of the code, on purpose: any fact written here ("last worked on X", "N tests passing", "currently mid-way through Y") would be wrong within a day and nobody would remember to fix it. Instead this doc points at where the real, currently-true answer lives and how to go get it. That's what makes it safe to never update: it has nothing in it that can go stale.

If you are the user reading this: don't add status updates to this file. If something is worth remembering long-term, it belongs in `CLAUDE.md` (durable rules/architecture) or a `docs/` page (a subsystem's behavior), not here.

## 1. Read order

1. **`CLAUDE.md`** (repo root) — read this first, always. It's the durable reference: what the project is, every command, the module map, the design decisions that aren't inferable from the code, and a "Known dead ends" section listing things that look like bugs but aren't. Claude Code loads it automatically at the start of every session in this repo.
2. **`docs/README.md`** — the index of deeper docs, one row per subsystem. Don't rely on this handoff doc (or your memory) to know what pages exist — open the index itself, since new pages get added as new rows there, not listed here.
3. **The specific page for whatever you're about to touch** — e.g. `docs/scheduling.md` before changing the appointment flow, `docs/customer-crm.md` before changing customer intake. If you're about to touch a subsystem and no doc page covers it, that's a gap worth closing (see §5), not a sign there's nothing to know.

## 2. Find out what's actually going on (don't trust anyone's summary, including a past agent's)

Run these — they're the ground truth, and they're accurate no matter how long it's been since anyone wrote this file:

```bash
git log --oneline -20        # what's landed recently, and in what order
git status                    # is there uncommitted work sitting in the working tree
git diff                      # what, exactly, is uncommitted
npm test                      # does the suite currently pass — see §4 for what it does and doesn't cover
ps aux | command grep node    # is a live `node index.js` already running on this machine
```

That last one matters more than it looks: if an instance is already running, it has its own `llama-server` and is watching a real Gmail inbox. Restarting it sends real email (an "online" notification, or an onboarding request if identity is unset) to the configured `admin_email`. Don't kill/restart it without knowing that's what you're doing.

If you want the story behind *why* something is the way it is — not just what it currently does — that's what `docs/` and CLAUDE.md's "Known dead ends" section are for. Check there before assuming something is a bug.

## 3. Environment landmines (stable — these won't go stale)

- **`grep` is broken in this Bash environment** (routes through a missing `ugrep` binary and errors). Use `command grep`, `awk`, `python3`, or the Grep/Explore tool instead of bare `grep`.
- **`find` is similarly broken** in some environments here (missing shared library) — same workaround: `python3`, `ls`, or the dedicated search tools.
- **Top-level shell scripts** (`install.sh`, `start.sh`, `stop.sh`) use a `#!/bin/sh`-that-re-execs-into-bash pattern, because Termux has no `/usr/bin/env` and no bash at `/bin/bash`. Preserve that pattern in any new top-level script — a plain `#!/bin/bash` shebang breaks under Termux.
- **`config.json` and everything under `data/` are gitignored.** A fresh clone has neither. `config.json.example` is the template; `data/` gets created on first run.
- **Some modules are deliberately not covered by the Jest suite**: file-backed operations on `contacts.js`, `queue.js`, and calendar booking/slot-finding read `paths.data_dir` from the *real* `config.json`, so testing them through Jest would write into live `data/`. Verify changes to those manually against an isolated sandbox config — and note that a symlinked module's relative imports resolve against the real file it points to, not the symlink's location, so a "sandboxed" test can still silently hit live `data/` if you're not careful. CLAUDE.md has the full explanation under "Testing against the live model."

## 4. Verification loop

There is no linter or type checker in this repo. The entire automated gate is:

```bash
node --check <file>.js                                                                    # syntax-check one file
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.mjs      # full suite
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.mjs -t "name"   # one test by name
```

Run `node --check` on every file you touch, and the full suite before calling anything done. For a UI-adjacent or behavioral change that Jest can't reach (see §3), say explicitly that it's untested rather than claiming it works.

## 5. Keeping this doc permanently accurate

This file stays correct for the life of the project only if nobody edits it to add facts. The only edits it should ever need are structural ones — e.g. renumbering a section, or adding a pointer if some *new kind* of read-order or landmine category appears (a second broken shell built-in, a second live-process warning). When a new subsystem is added to the codebase:

- Add its doc page under `docs/`, and add its row to `docs/README.md`.
- Add its module to CLAUDE.md's module-responsibilities list if it's a top-level source file.
- Do **not** add anything about it here — §1 already tells the next reader to open the index and find it.

If you ever find yourself wanting to write "as of [date], X is true" in this file, that sentence belongs in a commit message, a `docs/` page, or nowhere — not here.

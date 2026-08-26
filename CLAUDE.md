# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Picking this project up fresh, or asked "where are we at"?** Read [`HANDOFF.md`](HANDOFF.md) first — it points at the commands and docs that give the current, ground-truth answer, rather than a status snapshot that would go stale.

## What this is

Aigentik is a personal AI assistant built to run entirely on-device in Termux (Android), though the Node.js application itself isn't Android-specific and also runs on regular Linux (useful for development). It watches a Gmail inbox over IMAP IDLE, drafts/sends replies via a local LLM (Qwen served by `llama.cpp`), and is controlled entirely through natural language — either by texting a Google Voice number or emailing the monitored inbox directly. There is no cloud AI, no external API key, and no server component; the model and all data live on the phone (or dev machine). `README.md` is now a short pitch/quick-start page; full behavioral documentation lives under `docs/` (see `docs/architecture.md`, `docs/commands.md`, `docs/scheduling.md`, etc.) — read the relevant doc before making non-trivial changes, since a lot of the "why" here isn't inferrable from the code alone.

## Commands

```bash
./install.sh              # one-shot setup: system packages, llama.cpp build, model download, npm install,
                           # starter config.json — idempotent, safe to re-run, skips whatever already exists
npm test                  # full Jest suite with coverage (tests/*.test.js)
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.mjs   # same, no coverage
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.mjs -t "test name"   # run a single test by name
node --check <file>.js    # syntax-check a single file (no bundler/linter in this repo)
./start.sh                 # starts llama-server if needed, then `node index.js` in the background, logs to aigentik.log
./stop.sh                   # stops it
tail -f aigentik.log        # watch live logs
```

`install.sh`, `start.sh`, and `stop.sh` all use a `#!/bin/sh`-based shebang that re-execs into bash — Termux has no `/usr/bin/env` and no bash at `/bin/bash` (it lives under Termux's own sandboxed prefix), so a plain `#!/usr/bin/env bash` or `#!/bin/bash` shebang breaks there. Preserve that pattern in any new top-level shell script.

There is no build step, linter, or type checker configured — `node --check` and the Jest suite are the only automated verification available. Tests cover `email-provider.js`, `gmail.js`, `calendar.js` (IMAP lifecycle/parsing, `.ics` invite building, deterministic date-phrase parsing), and `subcontractor-form.js`/`trades.js` (lead-form field parsing, trade normalization — pure functions, no file I/O). File-backed operations on `contacts.js`, `queue.js`, and calendar booking/slot-finding are **not** covered by Jest — they read `paths.data_dir` from the real `config.json`, so exercising them through the test suite would write into the live `data/` directory. Verify changes to those manually against an isolated sandbox config, not a symlinked one — a symlinked module's relative imports (e.g. `./config.json`) resolve against the real file it points to, not the symlink's location, so a "sandboxed" test can silently write into live `data/` anyway. See "Testing against the live model" below.

## Runtime state — not what you'd assume from git

- `config.json` and everything under `data/` (including `data/profile.json`, `data/contacts.json`, `data/calendar.json`, logs) are gitignored. A fresh clone has none of this — `config.json.example` is the template, and `index.js`'s `loadProfile()` creates a fresh `data/profile.json` on first run if one doesn't exist, deliberately leaving `owner_name`/`business_name`/`business_description` unset (see "First-run onboarding" below) rather than defaulting them to any particular deployment's values.
- The live app on this machine may already be running as a background `node index.js` process with its own `llama-server` — check `ps aux` before assuming you can freely restart it; doing so sends real email (the "online" notification or, if identity is unset, an onboarding request) to the configured `admin_email`.
- The shell's `grep` is wrapped by a broken function in this environment (routes through a missing `ugrep` binary and fails with `-G: error while loading shared libraries`). Use `command grep`, `awk`, `python3`, or the `Grep`/`Explore` tooling instead of bare `grep` in Bash.

## Architecture

**Everything flows through Gmail.** There is no direct SMS send/receive on the device — an earlier version polled Termux:API directly, but that path was removed. Google Voice forwards incoming texts as email (from an address under `txt.voice.google.com`); `email-provider.js` recognizes and parses these into SMS-shaped objects, and *replying* to that forwarded email is what turns back into a real outgoing text. This means Aigentik can reply to an existing text thread but can never originate a new, unprompted text conversation.

**Two identical command channels.** A Google Voice text from `owner.admin_number`, or an email from `owner.admin_email`, are both normalized into the same `{ address, body, subject, _id }` shape in `index.js` and handed to `owner-command.js`'s `handleOwnerCommand` — every owner command works identically from either channel. Everyone else's messages go through the normal auto-reply/queue path instead.

**Module responsibilities:**
- `index.js` — entry point and orchestrator. Starts `llama-server`, warms it up, loads the profile, syncs Android contacts, connects Gmail, and contains the top-level routing (`handleNewEmail`, `handleGoogleVoiceText`) plus the appointment-negotiation state machine (`handleSchedulingMessage`, `sendIntakeForm`, `confirmAndClose`).
- `email-provider.js` — the real IMAP/SMTP client (`imapflow`/`nodemailer`): IDLE loop, reconnection, message parsing, send/delete/archive/spam/search, Google Voice email parsing, `.ics` invite/cancellation building.
- `gmail.js` — thin compatibility wrapper around `email-provider.js` so nothing else imports `imapflow` directly.
- `owner-command.js` — parses/executes every owner command (shorthand phrases first, then `llama.interpretCommand` for everything else), regardless of which channel it arrived on.
- `llama.js` — the only module that talks to an LLM: reply generation, command interpretation, scheduling-intent classification, contact-detail extraction (including freeform subcontractor details via `extractSubcontractorDetails`), subcontractor application acknowledgment replies (`generateSubcontractorAck`), tone detection, business-persona prompt injection (`businessContext()`). Every one of those goes through the single `chat()` function, which routes to either the local `llama-server` (default) or Google's Gemini (OpenAI-compatible endpoint) based on `config.llm.provider` — see [Configuration reference](docs/configuration.md). `getLlmProvider()`/`setLlmProvider()` read/flip that at runtime (same in-memory-only pattern as `config.behavior.paused`); "use gemini"/"use local" are exact-match owner-command shorthand specifically so switching away from a broken provider doesn't itself depend on an AI call succeeding.
- `calendar.js` — appointment slot-finding/booking/reschedule/cancel and deterministic (`chrono-node`-backed) date/time parsing; scheduling math is intentionally kept out of the LLM since the model isn't reliable at date arithmetic.
- `contacts.js` / `contacts-sync.js` — the contact directory and its one-way merge from Android's real contacts (`contacts-sync.js` imports its file I/O helpers from `contacts.js` rather than duplicating them). Contacts can be `type: "subcontractor"`, carrying trade/license/insurance/crew/references fields (`applySubcontractorDetails`, `findSubcontractorsByTrade`); they also carry an accumulating `roles` array and `active_role`, maintained by `role-router.js`, which never overwrite `type`.
- `role-router.js` — resolves an inbound sender into a `person` (identity, known subcontractor/customer CRM record, accumulated `roles`) and classifies the message's role/intent/workflow, deterministic pattern matching first, an LLM call as fallback for anything not caught by a pattern. Decides which of the subcontractor flow, the customer flow, an ambiguity-clarification reply, or a plain AI reply handles the message; called from `index.js`'s `handleGoogleVoiceText`/`handleNewEmail` after the scheduling check (a fresh appointment request from a message that reads as being from a known subcontractor is left to this module rather than the scheduling flow) and before reply generation.
- `subcontractor-recruiter.js` / `customer-module.js` — the subcontractor and customer CRMs role-router dispatches into: lead/customer record creation and lookup, qualification/intake-detail extraction, and (customer side) emergency/escalation keyword detection.
- `subcontractor-form.js` / `trades.js` — deterministic parser for "Subcontractor Application" lead-form emails (label/synonym lookup, same reasoning as `calendar.js` keeping date math out of the model) and the shared trade-name taxonomy/normalizer used by both `contacts.js` and this parser.
- `email-rules.js` / `sms-rules.js` — independent rule engines (spam/auto-reply/review) per channel.
- `queue.js` — the pending-review queue for drafts not auto-sent.
- `tone.js` — wraps `llama.js`'s tone detection with a fallback.
- `logger.js` — structured JSON file logging (`data/logs/aigentik-YYYY-MM-DD.log`) plus console mirroring; importing it also creates `data/` if missing (side effect relied on elsewhere).

**Owner identity and business persona** (`data/profile.json`, loaded into `config.owner_name`/`config.aigentik_name`/`config.business_name`/`config.business_description` at startup): Aigentik defaults to a generic personal assistant. Once `business_name` is set, `llama.js`'s `businessContext()` injects a persona clause into every customer-facing prompt (email/SMS replies, intake acknowledgment) and reply signatures switch from "Personal Agent of `<Owner>`" to "`<Agent> | <Business>`", dropping the owner's personal name from customer-facing text. On a fresh install missing `owner_name`/`business_name`, `index.js`'s `sendOnboardingEmail()` emails `admin_email` asking for them (once per install, tracked via `onboarding_sent`); the freeform reply is interpreted by the same `interpretCommand` pipeline as any other admin command (`set_business_info` with an optional `owner_name` field, or `set_owner_name` alone) — this was a deliberate design choice over a separate blind extractor, because routing through the full action-classifier avoids misinterpreting ordinary commands that happen to contain a name (e.g. "add contact Sarah...") as onboarding answers.

**Natural-language command interpretation is centralized in one place**: `llama.js`'s `interpretCommand` returns `{action, target, content, item_id, rule_type, rule_description, contact_field, contact_value, owner_name, confirm_required}` for a fixed set of actions, and `owner-command.js`'s `executeInterpretedCommand` switches on `action`. Adding a new owner-facing capability generally means: add the action name + describe its field usage + give an example in `interpretCommand`'s prompt (all in one long string — search for the `actions` and `systemMsg` variables), then add a `case` in `executeInterpretedCommand`. A handful of exact-match shorthand phrases (e.g. `status`, `list`, `sync contacts`) are handled before the AI call in `handleOwnerCommand` to avoid the round-trip.

**Confirmation-gated destructive actions** (`delete_all_emails`, `archive_all_emails`, `spam_all_promotional`, `delete_contact`, appointment cancellation) don't execute immediately — they're stored in an in-memory `pendingConfirmations` map and only run if the next message is `yes`/`confirm`.

**Scheduling flow**: inbound messages are classified by `llama.classifySchedulingIntent` (works even without the word "appointment" — an estimate/quote request counts) before falling through to the normal reply path. A fresh request gets a single combined intake form (name/address/phone/call-vs-in-person/preferred time) rather than one question per turn; date/time phrases from the intake reply are parsed deterministically via `calendar.js` (`chrono-node`), never by the LLM. `index.js`'s `closingReassurance()` and the intake form wording are currently hardcoded for a home-improvement-style business and don't adapt to `business_description` — a business in an unrelated trade would need those edited directly.

## Known dead ends / things that look like bugs but aren't (yet)

- `config.sms.*` and `data/conversations.json`/`data/seen-sms-ids.json` are vestigial from a removed direct-SMS-polling code path; nothing reads or writes them.
- `behavior.require_confirmation_for_destructive` and `behavior.tone_matching` in `config.json` describe intended behavior that isn't actually gated by those flags — the confirmation flow and tone detection always run regardless of their value.

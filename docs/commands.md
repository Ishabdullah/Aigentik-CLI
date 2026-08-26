> [← Back to README](../README.md) · [All documentation](README.md)

# Owner command reference

Say/text/email any of these to the admin number or `admin_email`. A handful of exact phrases are handled directly (fast, no AI call); everything else goes through the local LLM to interpret intent, so you don't need to match these verbatim — "what's pending" works the same as "list".

## Table of Contents

- [Direct phrases (no AI needed)](#direct-phrases-no-ai-needed)
- [Natural-language commands](#natural-language-commands)
- [Confirmation-gated (destructive) commands](#confirmation-gated-destructive-commands)
- [Do-not-contact list](#do-not-contact-list)
- [What Aigentik can't do](#what-aigentik-cant-do)
- [The review queue](#the-review-queue)

## Direct phrases (no AI needed)

| Say | Does |
|---|---|
| `list` / `pending` / `queue` | Show everything waiting in the review queue |
| `status` / `ping` | Health check: paused state, pending count, per-channel status |
| `email rules` / `list email rules` | List saved email rules |
| `sms rules` / `list sms rules` | List saved Google Voice rules |
| `contacts` / `list contacts` | List the contact directory |
| `sync contacts` / `refresh contacts` / `sync` | Re-sync from your phone's Android contacts |
| `email [name] about [topic]` / `email [name] re [topic]` | Draft and send a fresh email to a saved contact |
| `block [name/email/phone]` | Adds them to the do-not-contact list — see [Do-not-contact list](#do-not-contact-list) |
| `unblock [name/email/phone]` | Removes them from the do-not-contact list |
| `blocked` / `do not contact list` / `dnc list` | Show everyone on the do-not-contact list |
| `rename [name]` | Change what Aigentik calls itself |
| `business info` / `company info` / `who do you work for` | Show the currently set business name/description |
| `use gemini` / `switch to gemini` | Switch the AI backend to Gemini (fails with a clear message if no API key is configured) — see [Configuration reference](configuration.md) |
| `use local` / `switch to local` / `use qwen` | Switch the AI backend back to the local model |
| `ai status` / `llm status` / `which ai` | Show which AI provider (`local` or `gemini`) is currently active |

## Natural-language commands

Everything else is sent to the local model with a short JSON schema to fill in, then executed. Roughly:

| Intent | Example phrasing | What happens |
|---|---|---|
| Approve a queued reply | `reply 3` | Sends the queued draft for item #3, via email or (for Google Voice items) by replying to the original forwarded email |
| Edit a queued draft | `edit 3 tell them I'll call tomorrow` | Replaces the draft text for item #3 |
| Dismiss a queued item | `skip 3` | Removes item #3 without sending anything |
| Spam a queued item | `spam 3` | Moves that exact message to Gmail Spam (by its IMAP UID) and removes it from the queue |
| Add a rule | `add email rule: spam anything from amazon.com` | Parses the description into a structured rule and saves it |
| Remove a rule | `remove rule spam anything from amazon` | Finds a saved rule by id or matching description and deletes it |
| List rules | `list rules` / `list sms rules` | Same as the direct-phrase versions |
| Find a contact | `find Sarah` | Looks up and returns saved info for a contact |
| List subcontractors by trade | `list my plumbers` / `who are my painters` | Returns every `subcontractor`-type contact whose trade matches (recognizes trade synonyms — "electrician" finds `electrical`), or says there are none for that trade |
| Add a subcontractor | `add subcontractor Bob's Plumbing, plumber, phone 5551234567, licensed, has GL and WC insurance, crew of 3` | Creates (or upgrades an existing) contact as `type: "subcontractor"`, extracting trade/phone/email/license/insurance/crew/capacity from the description |
| Per-contact instructions | `always reply to Mom` / `never reply to spam caller` / `for my boss, always mention I'm in meetings until 3` | Sets that contact's reply behavior (`always` / `never` / `auto`) and optional standing instructions |
| Add a contact | `add contact Sarah phone 5551234567` | Creates the contact if it doesn't exist yet, or adds the phone/email to an existing one |
| Update a contact | `save email john@x.com to Mike` / `change Mike's name to Michael` | Adds a phone/email/relationship/notes, or overwrites the name, on an existing contact |
| Send an email | `email boss@company.com about the meeting` (or with a saved contact name) | Drafts content via AI and sends, asking for confirmation first if the model flags it as needing one |
| Pause/resume | `pause` / `pause email` / `pause sms` / `resume` / `resume email` / `resume sms` | Globally or per-channel stop/start processing |
| Generate content | `write a birthday message for my daughter` | Returns AI-generated text without sending it anywhere |
| Book an appointment | `book John for next tuesday at 2pm` (or `book jane@example.com for...` directly) | Finds the nearest available slot at/after that time within working hours, books it, and emails a calendar invite to the other party and to you. Never books *today* unless you say "today"/"tonight" |
| Move an appointment | `move John's appointment to friday 3pm` | Reschedules John's nearest upcoming appointment and resends an updated invite |
| Cancel an appointment | `cancel John's appointment` | Confirmation-gated — see below |
| List appointments | `what's on my calendar` / `what's on my calendar today` / `... for next tuesday` / `... this week` | Shows upcoming appointments, or just the day/range you asked about |
| Set working hours | `set working hours 9am to 5pm monday through friday` | Updates the hours Aigentik will book appointments within |
| Set duration by role | `lawyers get 60 minute appointments` | Sets a default appointment length for contacts with that relationship label |
| Set business identity | `the business name is Acme Restoration and we do home improvement, specializing in water damage restoration` | Sets `business_name`/`business_description` — see [Business identity and persona](onboarding.md#business-identity-and-persona). Can also set the owner's name in the same message, e.g. `my name is Sarah, the business is Acme Restoration...` |
| Set owner's name only | `my name is Sarah` | Sets `owner_name` without touching business info — used when no business is being set |
| Anything unrecognized | — | Falls back to a plain conversational reply from the model |

See [Appointment scheduling](scheduling.md) for the full booking/reschedule/cancel negotiation flow, and [Rule engines](rules.md) for how `add rule`/`remove rule` map to `email-rules.js`/`sms-rules.js`.

## Confirmation-gated (destructive) commands

These never run immediately — Aigentik describes what it's about to do and waits for you to reply `yes`/`confirm` or `no`/`cancel` before touching anything:

| Say | Does, once confirmed |
|---|---|
| `delete all emails` | Permanently deletes (moves to Trash) every message in the inbox |
| `archive all emails` / `clean inbox` | Archives (moves to All Mail) every message in the inbox |
| `spam all promotional emails` | Scans every inbox message, evaluates each one against the same promotional-content check used for auto-detection, and moves only the matches to Spam — reports back how many were scanned vs. actually moved |
| `delete contact [name]` | Permanently removes that contact from `contacts.json` |
| `cancel [name]'s appointment` | Cancels the appointment and emails a cancellation notice (matching `.ics` `CANCEL`) to both the contact and you |

Only one confirmation can be pending at a time; if you say anything other than yes/no while one is outstanding, the pending action is discarded and your new message is processed as a fresh command.

## Do-not-contact list

`do-not-contact.js` maintains a permanent block list at `data/do-not-contact.json` — like everything under `data/`, it's gitignored and never leaves this install. Anyone on it is never auto-replied to, queued, or messaged again on either channel (email or Google Voice), and no rule or per-contact `always` setting overrides it.

Entries get added two ways:

- **You block them explicitly** — `block hello@contractorplus.app`, `block Sarah` (resolves to her saved email/phone), or naturally, `never contact Sarah again`.
- **They ask to be removed** — Aigentik checks every inbound email/text body (quoted reply chains stripped first) for first-person opt-out phrasing ("stop texting me", "remove me from your list", "unsubscribe me", etc., matched deterministically, not by the model) *before* drafting any reply. Deliberately narrow and first-person-only — bare "unsubscribe"/"opt out" are excluded since those show up constantly in marketing-footer boilerplate (see `email-rules.js`'s promotional detector) and a false positive here is a permanent, silent block. A real match blocks them on the spot — no reply is ever sent to the message that triggered it.

Either way, you get an admin notification reporting exactly what happened (who, which channel, their message, why they were added). If a blocked contact reaches out again later, you get a short notification each time noting Aigentik stayed silent — so the block isn't invisible, it's just never acted on. The block is also checked before `reply [#]` sends a queued draft, so a block that lands after a reply was already drafted still stops it.

`unblock [name/email/phone]` reverses it. `blocked` / `do not contact list` shows the current list.

## What Aigentik can't do

- **Start a brand-new text conversation.** `send_sms` and the old `text [name] [message]` shorthand are gone — see [The two communication channels](architecture.md#the-two-communication-channels) for why. Use email instead, or reply to a text that's already in the queue.
- **Target one message when spamming an item that predates this feature.** Every item queued now carries the exact message's IMAP UID, so `spam [#]` moves only that message. Items already sitting in the queue from before this existed have no stored UID and fall back to spamming everything from that sender.

## The review queue

Anything not auto-replied lands in `data/pending.json` with a small integer `display_id` (starting at 1 and always increasing, so IDs never get reused even after items are removed). Each item records the sender, subject/body preview, the AI-drafted reply, which saved contact it's linked to (if any), and — for email and Google Voice items — enough information (message UID, and for Google Voice, the forwarding email's address/subject) to act on the *exact* original message later, not just "whoever sent this."

`reply [#]`, `edit [#] [...]`, `skip [#]`, and `spam [#]` all operate against this queue. There's no expiry — items sit there until you act on them.

---

[← Back to README](../README.md) · [All documentation](README.md)

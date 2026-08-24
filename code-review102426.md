# Aigentik-CLI Code Audit & Remediation Plan (2026-08-24)

This document tracks all identified bugs, logical inconsistencies, performance bottlenecks, security improvements, and architectural optimizations in the Aigentik-CLI codebase, along with their resolution status.

---

## 1. Critical Bugs & Runtime Crashes

- [x] **1.1. `contacts.deleteContact` & `contacts.renameContact` Fail on Contact ID**
  - **Files:** `contacts.js`, `owner-command.js`
  - **Issue:** `contacts.deleteContact(contact.id)` and `contacts.renameContact(contact.id, value)` pass `contact.id` to `findContact(identifier)`. `findContact` matches by phone, email, name, or alias, but does not match `c.id === identifier`. This causes `deleteContact` to fail silently and `renameContact` to crash with `TypeError: Cannot read properties of null (reading 'id')`.
  - **Fix:** Update `findContact` (and `getContactById` lookups in `deleteContact`, `renameContact`, and `setContactInstructions`) to support matching directly by `c.id`.

- [x] **1.2. `contacts-sync.js` Crashes Owner Commands on Zero/Failed Contacts**
  - **Files:** `contacts-sync.js`, `owner-command.js`
  - **Issue:** If 0 contacts are found (or on Linux / when Termux:API is unavailable), `syncContacts()` returns `undefined`. `owner-command.js` attempts to access `result.added`, throwing an unhandled `TypeError`.
  - **Fix:** Return `{ android: 0, added: 0, updated: 0, total: aigentikContacts.length }` in all execution and failure paths.

- [x] **1.3. `contacts-sync.js` Incomplete Schema Initialization**
  - **Files:** `contacts-sync.js`
  - **Issue:** Creating contacts directly in `contacts-sync.js` omits schema fields initialized by `contacts.js:createContact` (`address`, `business_name`, `trade`, `trade_raw`, `licensed`, `license_number`, `gl_insurance`, `wc_insurance`, `has_tools`, `crew_size`, `weekly_capacity`, `references`).
  - **Fix:** Align contact creation with `createContact` schema defaults.

- [x] **1.4. Unhandled Async Promises and Global Reply Target State in `owner-command.js`**
  - **Files:** `owner-command.js`
  - **Issue:** `reply(...)` is async, but synchronous helper functions (`handleRename`, `handleBlockContact`, `handleUnblockContact`, `handleSetBusinessInfo`, `handleSetOwnerName`) call it without `await`. Module-level globals `currentReplyTarget` and `currentReplySubject` risk race conditions under concurrent requests.
  - **Fix:** Make helper functions `async`, `await reply(...)`, and ensure reply routing is safely handled.

- [x] **1.5. Missing Asset Error Handling in Nodemailer**
  - **Files:** `email-provider.js`
  - **Issue:** Nodemailer throws `ENOENT` if `SIGNATURE_ICON_PATH` is missing when sending HTML emails.
  - **Fix:** Check `fs.existsSync(SIGNATURE_ICON_PATH)` before attaching the signature icon image.

---

## 2. Logic & Behavioral Inconsistencies

- [x] **2.1. `reply_behavior === 'never'` Ignored for Incoming Emails**
  - **Files:** `index.js`
  - **Issue:** `handleGoogleVoiceText` checks `contact?.reply_behavior === 'never'`, but `handleNewEmail` does not, causing emails from ignored contacts to still trigger AI replies.
  - **Fix:** Add `if (contact?.reply_behavior === 'never') return;` check in `handleNewEmail`.

- [x] **2.2. Inverted SMS Auto-Reply Rule Logic**
  - **Files:** `index.js`
  - **Issue:** `contact?.reply_behavior === 'auto'` evaluated to true for every contact, bypassing `behavior.default_unmatched_sms_action: "review"`.
  - **Fix:** Update logic to `contact?.reply_behavior === 'always' || (contact?.reply_behavior !== 'review' && action === 'auto-reply')`.

- [x] **2.3. Resilient LLM JSON Extraction**
  - **Files:** `llama.js`, `owner-command.js`
  - **Issue:** `raw.replace(/```json|```/g, '').trim()` breaks if the model outputs conversational preamble or postamble text.
  - **Fix:** Use regex matcher `raw.match(/\{[\s\S]*\}/)` before `JSON.parse`.

- [x] **2.4. Double Notification on Multi-Field Onboarding / Rename Commands**
  - **Files:** `owner-command.js`
  - **Issue:** Setting `agent_name` alongside another action sent duplicate reply messages.
  - **Fix:** Consolidate responses or avoid duplicate reply dispatch.

- [x] **2.5. Stale Negotiation State on Appointment Reschedule**
  - **Files:** `calendar.js`
  - **Issue:** Direct reschedule in `rescheduleAppointment` didn't reset `rsvp_status` or clear `pending_reschedule`.
  - **Fix:** Reset `rsvp_status = 'pending'` and clear `pending_reschedule` on reschedule.

- [x] **2.6. Missing Radix Parameters in `parseInt`**
  - **Files:** `calendar.js`, `contacts.js`, `contacts-sync.js`, `queue.js`, `subcontractor-form.js`
  - **Issue:** Inconsistent radix in `parseInt` calls across the codebase.
  - **Fix:** Add explicit radix `10` to all `parseInt` invocations.

---

## 3. Performance & Resource Optimization

- [x] **3.1. Precise 15-Minute Epoch Chunking in `calendar.js`**
  - **Files:** `calendar.js`
  - **Issue:** Slot rounding using minute ceiling with non-zero seconds/milliseconds could result in slots starting in the past.
  - **Fix:** Implement epoch timestamp chunking (`Math.ceil(time / (15 * 60 * 1000)) * (15 * 60 * 1000)`).

- [x] **3.2. EmailProvider Management Connection Stale Socket Protection**
  - **Files:** `email-provider.js`
  - **Issue:** Idle pooled IMAP connections could disconnect, causing subsequent management tasks to fail.
  - **Fix:** Add connection validation and automatic retry with a fresh client on disconnect errors.

- [x] **3.3. Tone Detection Config Guarding**
  - **Files:** `index.js`, `tone.js`
  - **Issue:** Tone detection calls the local LLM on every SMS, adding latency even when disabled in configuration.
  - **Fix:** Respect `config.behavior.tone_matching` configuration.

- [x] **3.4. Log File Pruning and Retention**
  - **Files:** `logger.js`
  - **Issue:** `data/logs/` creates daily logs without an automatic cleanup/rotation mechanism.
  - **Fix:** Add a log retention cleanup function to prune logs older than 30 days.

---

## 4. Security & Data Integrity

- [x] **4.1. Structural Message Delimiters for Prompt Injection Defense**
  - **Files:** `llama.js`
  - **Issue:** Direct concatenation of user text into prompts could allow prompt injection.
  - **Fix:** Use clear XML / delimiter boundaries for untrusted incoming email and SMS content.

- [x] **4.2. Safe Null/Undefined Handling for Sender Names & Numbers**
  - **Files:** `llama.js`, `index.js`
  - **Issue:** Potential `"null"` or `"undefined"` string literals in prompts when name is absent.
  - **Fix:** Safely format sender labels with proper fallbacks.

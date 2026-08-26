> [← Back to README](../README.md) · [All documentation](README.md)

# Subcontractor recruitment pipeline

`subcontractor-recruiter.js` is a separate, fuller CRM from the applicant-intake path described in [The contact directory](contacts.md) (the "Subcontractor applications" section): that path handles someone who already submitted a structured "Subcontractor Application" lead form, while this module runs an outbound-style recruitment *conversation* — qualifying a trade contractor over several messages, tracking onboarding documents, and never auto-approving anyone. Records live in `data/subcontractors.json`. [role-router.js](architecture.md#dynamic-role--workflow-routing) hands a message here whenever it classifies the sender as `SUBCONTRACTOR`.

## Record lifecycle

`createOrUpdateSubcontractorLead` matches an existing record by ID, then phone/email/name, so a reply from an already-known number updates the same record rather than creating a duplicate; `syncWithContacts` immediately mirrors the trade/license/insurance-relevant fields onto the linked `contacts.json` entry (creating one with `type: "subcontractor"` if none exists yet), which is what makes `find [name]` and `list my [trade]` in the [contact directory](contacts.md) show current recruitment standing.

Two independent state machines track progress on every write:

- **`qualification_status`** (`determineQualificationStatus`) — `NEW_LEAD` → `CONTACTED` → `QUALIFICATION_IN_PROGRESS` → `QUALIFIED_PENDING_DOCUMENTS` → `DOCUMENTS_REQUESTED`/`PARTIALLY_RECEIVED`/`MSA_PENDING` → `DOCUMENTS_UNDER_REVIEW`, with `DECLINED` and `DO_NOT_CONTACT` as absorbing states reachable from anywhere. Critically, **`APPROVED_ONBOARDING` and `ONBOARDING_COMPLETE` are never set by this function** — once a record reaches one of those two, `determineQualificationStatus` just returns it unchanged on every subsequent recalculation. Only an explicit owner command (`approve subcontractor`) can move a candidate into either status; nothing in the conversational qualification flow is allowed to self-approve someone.
- **`recruitment_step`** (`determineNextRecruitmentStep`) — a linear checklist (company info → trade → trade-specific questions → experience → service area → availability → licensing → insurance → MSA willingness → document request) computed fresh from whatever fields are still `null`, which is what tells the LLM reply generator which one or two questions to ask next rather than re-asking something already answered.

A record separates **company/trade identity** (`company_name`/`legal_name`/`dba`, `contact_name`/`title`, `primary_trade` normalized via `trades.js`, `secondary_trades`, `service_area`, `years_in_business`, `crew_size`, residential/commercial experience, `typical_project_size`, `availability`) from **compliance standing** (`license_required`/`license_type`/`license_number`/`license_status`, `general_liability`/`workers_comp`/`coi_received`, `w9_received`/`msa_sent`/`msa_signed`) and **references/portfolio**. `getMissingDocuments` derives the outstanding-paperwork list (W-9, signed MSA, certificate of insurance, workers' comp or an exemption, license/HIC registration, references or a portfolio) straight from those compliance fields rather than storing it separately, so it's always in sync with whatever's actually on file.

## How a message gets here

Both `handleGoogleVoiceText` and `handleNewEmail` in `index.js` follow the same shape once role-router routes to the subcontractor workflow:

1. `llama.extractRecruiterQualification(text, existingRecord)` pulls structured qualification fields out of the free-text reply, seeded with the existing record so a later message fills gaps instead of overwriting known answers.
2. `createOrUpdateSubcontractorLead` (new lead) or the merged update (existing lead) persists the result and recalculates both `qualification_status` and, indirectly, what `determineNextRecruitmentStep` will ask next.
3. `llama.generateRecruiterReply` drafts the reply from `buildRecruiterSystemPrompt` (see below) plus the current record.

## The system prompt and its guardrails

`buildRecruiterSystemPrompt` is, like the customer module's prompt, written specifically for Restoricon's pre-launch positioning (building a subcontractor network ahead of a planned January 2027 ramp-up) — adapting this to a different business or timeline means editing the constants in this file directly, not `business_description`.

The guardrails here exist because a recruitment conversation is exactly where an LLM is tempted to oversell: the prompt hardcodes a mandatory framing sentence ("We're currently building our subcontractor network ahead of our planned January 2027 ramp-up"), a list of phrases it must never say (guaranteeing work or income, "You are approved," promising a specific project volume), and explicit bans on inventing pay rates or giving legal/insurance advice. `RECRUITER_FAQS` (matched by substring against known question phrasings) and `RECRUITER_OBJECTIONS` (already-busy, doesn't need work, asks how you got their number, questions whether you're really a contractor, etc.) give the model pre-approved answers for the recruitment-specific questions and pushback that come up repeatedly, the same reasoning as `APPROVED_FAQS`/`APPROVED_OBJECTIONS` in the customer module.

## Owner commands

See [Owner command reference](commands.md) for the full list; the recruitment-specific ones are:

| Say | Does |
|---|---|
| `pipeline` / `subcontractor pipeline` / `subcontractor leads` / `subcontractors` | `formatPipelineReport()` — counts by qualification status plus up to 10 recent active candidates |
| `show subcontractor profile [x]` / find by trade in [contacts.md](contacts.md) | `formatSubcontractorSummary()` — full profile including missing-document list |
| `qualify subcontractor [x]` | Advances `qualification_status` to `QUALIFICATION_IN_PROGRESS` |
| `approve subcontractor [x]` | **The only path** to `APPROVED_ONBOARDING` — always an explicit owner action |
| `decline subcontractor [x]` | Sets `DECLINED` |
| `request subcontractor docs [x]` | Sets `DOCUMENTS_REQUESTED` and reports the current missing-document list |
| `subcontractor followups` / `sub followups` / `pending followups` | `formatFollowupList()` — candidates in `FOLLOW_UP_REQUESTED`, `CONTACTED`, `DOCUMENTS_REQUESTED`, or `QUALIFIED_PENDING_DOCUMENTS` |

## Storage path — a known inconsistency

Every other data file in this codebase (`contacts.json`, `customers.json`, `calendar.json`, etc.) is written under `config.paths.data_dir`. `subcontractor-recruiter.js` instead computes its own path — `path.join(__dirname, 'data', 'subcontractors.json')`, i.e. always relative to wherever this source file lives on disk — and never reads `config.paths.data_dir` at all. In the default install these resolve to the same directory, so it isn't currently causing visible problems, but a `data_dir` pointed anywhere else (e.g. external storage) would silently split subcontractor records into a different location than every other CRM/contact file. Worth fixing to use `config.paths.data_dir` like `customer-module.js` and `contacts.js` do, if `data_dir` is ever configured away from the default.

---

[← Back to README](../README.md) · [All documentation](README.md)

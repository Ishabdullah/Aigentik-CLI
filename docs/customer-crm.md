> [← Back to README](../README.md) · [All documentation](README.md)

# Customer intake, sales & support CRM

`customer-module.js` is the customer-facing counterpart to the [subcontractor recruitment pipeline](subcontractor-recruitment.md): a lightweight CRM that tracks a homeowner from first inquiry through estimate, decision, and support, storing everything in `data/customers.json`. [role-router.js](architecture.md#dynamic-role--workflow-routing) hands a message here whenever it classifies the sender as `CUSTOMER`; the module itself doesn't decide *whether* a message is customer-shaped, only what to do once it's been routed one.

## Record lifecycle

`createOrUpdateCustomer` is the single entry point for both creating and updating a record — it matches on `customer_id`, then phone, then email, so a returning customer's second message updates the same record instead of creating a duplicate. Every write recalculates `lead_score` (`calculateLeadScore`) from project clarity, ownership status, service-area match, urgency/insurance involvement, contact-info completeness, and appointment interest, bucketing the customer into `HOT` / `WARM` / `COLD` / `UNQUALIFIED`. `lead_status` moves through `LEAD_STATUSES` (`NEW` → `QUALIFICATION` → `QUALIFIED` → `APPOINTMENT_REQUESTED`/`SCHEDULED` → `ESTIMATE_PENDING`/`COMPLETED` → `PROPOSAL_SENT` → `WON`/`LOST`, plus `FOLLOW_UP`, `CUSTOMER_NOT_READY`, `OUT_OF_SERVICE_AREA`, `HUMAN_REVIEW`, `DNC`) — nothing in this module advances that status automatically beyond the initial `NEW`; every status change after that comes from an owner command or `escalate_customer`.

A record captures identity (name, phone, email, property address/city/state/zip, property type, owner/occupancy status), project details (`customer_category`, `project_category`/`project_type` from the `PROJECT_CATEGORIES`/`PROJECT_SUBTYPES` taxonomy, description, rooms affected, urgency, budget, desired dates), insurance-claim fields when relevant (carrier, claim number, adjuster, incident date), and freeform `customer_notes`.

## How a message gets here

Both `handleGoogleVoiceText` and `handleNewEmail` in `index.js` follow the same shape once role-router routes to the customer workflow:

1. `checkEmergencyKeywords`, `checkEscalationKeywords`, and `checkSwearing` scan the raw message against their respective keyword lists (flooding, structural collapse, fire/gas, lawyer/BBB, profanity, etc.) — deterministic substring matching, not an LLM call, so these can never be talked around by phrasing.
2. `llama.extractCustomerIntake(text, existingRecord)` asks the model to pull structured fields (name, address, project type/description, urgency, insurance involvement, etc.) out of the free-text message, seeded with whatever's already on file so a second message fills gaps rather than overwriting known answers.
3. `createOrUpdateCustomer` persists the merged result.
4. `llama.generateCustomerReply` drafts the actual reply, built from `buildCustomerSystemPrompt` (see below) plus the extracted intake data. However, if emergency, escalation, or swearing flags are set, this normal reply falls through: emergencies and standard escalations send an owner notification, while swearing additionally replies to the customer with a professional warning and permanently adds them to the Do-Not-Contact list so Aigentik ignores them until an admin intervenes.

## The system prompt and its guardrails

`buildCustomerSystemPrompt` assembles the persona and safety rules injected into every customer-facing LLM call. It's written specifically for Restoricon (a CT remodeling/restoration/general-contracting business in a pre-launch phase ahead of a January 2027 ramp-up) — company positioning, service area, and the `RESTORICON_INFO`/`APPROVED_FAQS`/`APPROVED_OBJECTIONS` reference text are hardcoded, not generated from `business_description`. Adapting this module to a different business means editing those constants directly, the same caveat CLAUDE.md already notes for the intake-form wording in `index.js`.

The guardrails matter more than the persona copy: the prompt explicitly forbids inventing pricing or phone estimates, remote-diagnosing structural/mold/roofing issues, guaranteeing insurance claim approval, declaring a structure safe after fire/flood/storm damage, promising repairs or admitting liability on a quality complaint, and authorizing change orders or cancellations — each is a place where an LLM improvising past its knowledge would create real liability, so they're spelled out as hard "never" rules rather than left to the model's judgment. An `EMERGENCY PROTOCOL` block tells the model to direct the customer to safety/911 first and switch tone to `EMERGENCY_REVIEW` before anything else, matching the deterministic emergency-keyword check in `index.js`.

## Human handoff

`formatHandoffSummary` builds the structured notification sent to the owner whenever a message needs a human — an emergency, an `escalate_customer` command, or a support request the model shouldn't handle alone. It's a fixed block (customer identity, property, project, issue, urgency, what they want, information collected so far, documents/photos received, appointment status, next action) rather than freeform text, so the owner sees the same shape every time regardless of what triggered it.

## Owner commands

See [Owner command reference](commands.md) for the full list; the customer-CRM-specific ones are:

| Say | Does |
|---|---|
| `customers` / `customer pipeline` / `customer leads` | `formatCustomerPipelineReport()` — counts by lead score and status, plus an active-emergency count |
| `customer [name/id/phone]` | `formatCustomerSummary()` for one record |
| `customer followups` / `client followups` | `formatCustomerFollowupList()` — records with `next_followup` set or sitting in `FOLLOW_UP`/`DECISION_PENDING` |
| `hot leads` / `hot customers` | Every `HOT`-scored record |
| `update customer [x] status [STATUS]` | Sets `lead_status` directly (any `LEAD_STATUSES` value) |
| `escalate customer [x]` | Sets `escalation_status: HUMAN_REVIEW_REQUIRED` and sends the owner a `formatHandoffSummary` notification |

## Storage note

`data/customers.json` is created on first use by `loadCustomers()`, under `config.paths.data_dir` like the rest of `data/` — see [Data files](data-files.md).

---

[← Back to README](../README.md) · [All documentation](README.md)

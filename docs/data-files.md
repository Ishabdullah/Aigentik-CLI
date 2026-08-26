> [← Back to README](../README.md) · [All documentation](README.md)

# Data files

Everything persistent lives under `data/` (configurable via `paths.data_dir` — see [Configuration reference](configuration.md)):

| File | What's in it |
|---|---|
| `contacts.json` | The [contact directory](contacts.md) |
| `customers.json` | The [customer CRM](customer-crm.md) pipeline |
| `subcontractors.json` | The [subcontractor recruitment](subcontractor-recruitment.md) pipeline |
| `email-rules.json` | Saved email rules — see [Rule engines](rules.md) |
| `sms-rules.json` | Saved Google Voice rules — see [Rule engines](rules.md) |
| `calendar.json` | Appointment records — see [Appointment scheduling](scheduling.md) |
| `schedule-config.json` | Working hours, appointment buffer, booking window, and per-relationship durations |
| `pending.json` | The [review queue](commands.md#the-review-queue) |
| `profile.json` | Aigentik's chosen name, your name, business name/description, setup date, and whether the onboarding request has been sent — see [First-run onboarding](onboarding.md) |
| `do-not-contact.json` | Permanently blocked emails/phone numbers — see [Do-not-contact list](commands.md#do-not-contact-list) |
| `logs/` | Daily structured JSON logs (`aigentik-YYYY-MM-DD.log`), written by `logger.js` |
| `conversations.json` | Reserved for future use — nothing currently reads or writes it |
| `seen-sms-ids.json` | Left over from the removed direct-SMS-polling code path; nothing currently reads or writes it |

`data/` (and `config.json`) are git-ignored — a fresh clone starts with none of this. See [Installation](installation.md) for how a first run creates what it needs.

---

[← Back to README](../README.md) · [All documentation](README.md)

> [← Back to README](../README.md) · [All documentation](README.md)

# The contact directory

`data/contacts.json` is a flat list Aigentik builds and maintains itself. Every inbound email or text either matches an existing contact (by normalized phone number, normalized email, name, or alias) or creates a new one automatically. Each contact tracks: name, any known aliases, phone numbers, email addresses, a home/mailing address, a free-text relationship label ("boss", "wife"), a type (`person`/`business`/`unknown`), standing instructions, a reply behavior (`auto` / `always` / `never` / `review`), where it came from (`email`, `sms`, `android_contacts`, or `auto`), first-seen/last-contact timestamps, a running contact count, and up to the last 50 history entries.

`sync contacts` merges in your actual Android address book (via `termux-contact-list`) without ever overwriting data Aigentik has already learned — it only fills in a name if one's missing, and adds phone numbers/aliases it doesn't already have. This only applies in Termux — see [Termux vs. Linux](installation.md#termux-vs-linux).

Reply behavior per contact overrides the general rule engine: setting someone to `never` stops all processing for them outright (still logged, no reply, no queue item); `always` skips the rule engine and auto-replies unconditionally. See [Rule engines](rules.md) for how the general (non-per-contact) rules work, and [Owner command reference](commands.md) for how to set instructions on a contact conversationally.

Every appointment is also linked to a contact record — see [Appointment scheduling](scheduling.md) for how that's used to resolve reschedule/cancel requests and to fill in the customer details on booking notifications.

---

[← Back to README](../README.md) · [All documentation](README.md)

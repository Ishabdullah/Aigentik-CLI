> [← Back to README](../README.md) · [All documentation](README.md)

# Rule engines

Two independent, structurally identical rule engines: `email-rules.js` for email, `sms-rules.js` for Google Voice texts. Each rule has a `condition_type`, a `condition_value` to match against, and an `action`. Rules are checked in order; the first match wins; if nothing matches, the configured default action applies (`behavior.default_unmatched_action` / `behavior.default_unmatched_sms_action` — see [Configuration reference](configuration.md)).

**Email conditions:** `from`, `domain`, `subject_contains`, `body_contains`, `promotional` (matches against a built-in keyword list — unsubscribe links, "no-reply" senders, "newsletter", etc.), `any` (matches from/subject/body).
**Email actions:** `auto-reply`, `review`, `spam`.

**Google Voice conditions:** `from_number`, `message_contains`, `any`.
**Google Voice actions:** `auto-reply`, `review`, `spam`.

Every rule tracks its own `match_count` and `last_matched` timestamp, so `email rules` / `sms rules` shows you how often each one is actually firing.

Add rules conversationally — `add email rule: auto-reply to anything from boss@company.com`, `add sms rule: spam messages containing "you've won"` — the model parses your description into the structured fields above. Remove them the same way: `remove rule [description or id]`. Full command list: [Owner command reference](commands.md).

Per-contact reply behavior (`always`/`never`/`auto`) overrides these rule engines entirely for that one contact — see [The contact directory](contacts.md).

---

[← Back to README](../README.md) · [All documentation](README.md)

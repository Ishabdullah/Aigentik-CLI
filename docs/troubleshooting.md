> [← Back to README](../README.md) · [All documentation](README.md)

# Troubleshooting & known limitations

## Table of Contents

- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

## Troubleshooting

**llama-server won't start**
```bash
ls -la ~/llama.cpp/build/bin/llama-server   # confirm the binary exists
~/llama.cpp/build/bin/llama-server -m "~/models/.../model.gguf" -c 4096 --host 127.0.0.1 --port 8080
```
Run it manually to see the real error if `start.sh` just reports failure.

**Gmail won't connect**
- Confirm you're using an **App Password**, not your normal Gmail password (Google Account → Security → App Passwords; requires 2-Step Verification to be on).
- Confirm IMAP is enabled: Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP.

**Google Voice texts aren't arriving**
- Confirm SMS forwarding to email is turned on in Google Voice settings, and pointed at the same address in `config.json`.
- Check the subject line format matches what `email-provider.js`'s Google Voice detector expects (`New text message from ...` / `New group text message from ...`) — Google occasionally tweaks wording.

**Contacts aren't syncing**
- Confirm Termux:API is installed and has Contacts permission granted in Android's app settings.
- Test directly: `termux-contact-list`.
- This only applies in Termux — see [Termux vs. Linux](installation.md#termux-vs-linux).

**Aigentik seems to have replied to the same message more than once**
- This was a real bug in an earlier version (new mail wasn't being marked seen correctly, so it kept re-appearing as "new"). It's fixed — every message is now marked seen by its exact IMAP UID immediately after being fetched, and a mailbox-change check can't run concurrently with itself. If you still see it, check `aigentik.log` for repeated `Processing new email from ...` lines for the same address in a short window and open an issue with that excerpt.

## Known limitations

- Composing a brand-new, unprompted text message isn't possible — see [What Aigentik can't do](commands.md#what-aigentik-cant-do).
- `spam [#]` on a queue item created before UID tracking was added falls back to "spam everything from this sender" rather than the one message, since older items have nothing more specific stored.
- `behavior.require_confirmation_for_destructive` and `behavior.tone_matching` are configuration fields that don't currently gate anything — destructive-action confirmation and tone detection always run regardless of their value.
- `sms.poll_interval_ms` / `sms.max_sms_fetch` are vestigial config fields with no code reading them.
- Appointment scheduling is push-only: Aigentik can create/update/remove events via `.ics` email, but can't read changes made directly in your calendar app, and has no visibility into anyone else's real availability beyond what they state in their message. See [Appointment scheduling](scheduling.md).
- If a contact messages to reschedule/cancel while they have more than one upcoming appointment on file, Aigentik picks the closest match to any date they mentioned, or asks which one if it can't tell — it doesn't track multi-turn disambiguation state across messages.

---

[← Back to README](../README.md) · [All documentation](README.md)

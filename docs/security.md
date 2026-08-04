> [← Back to README](../README.md) · [All documentation](README.md)

# Security notes

- All AI inference is local — no API keys, no data sent to any third-party model provider.
- The Gmail app password lives only in `config.json`, on-device, and that file is git-ignored.
- The only network traffic Aigentik generates is Gmail IMAP/SMTP and local calls to `llama-server` on `127.0.0.1`.
- TLS 1.2+ is enforced on both IMAP and SMTP connections, with certificate validation on.
- SMTP has file and URL attachment access disabled outright (reduces SSRF/local-file exposure); emails and replies sent to third parties also carry auto-responder-suppression headers, to reduce the risk of triggering auto-reply loops with other bots.
- IMAP reconnects automatically on connection loss, with exponential backoff and jitter, up to a built-in retry limit (10 attempts by default — this is a code-level default, not currently exposed in `config.json`).

See [Configuration reference](configuration.md) for where credentials live, and [Installation](installation.md) for how `config.json` gets created (never checked into git).

---

[← Back to README](../README.md) · [All documentation](README.md)

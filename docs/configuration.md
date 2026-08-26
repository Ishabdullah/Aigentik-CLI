> [← Back to README](../README.md) · [All documentation](README.md)

# Configuration reference

Every field in `config.json`, in full:

```jsonc
{
  "owner": {
    "admin_number": "15551234567",              // your phone number, digits only
    "admin_number_formatted": "+15551234567",    // same, E.164 — used when composing
    "aigentik_number": "15559876543",            // the Google Voice number Aigentik answers on
    "aigentik_number_formatted": "+15559876543",
    "admin_email": "you@gmail.com"               // your personal email — treated exactly like admin_number for commands
  },
  "gmail": {
    "email": "aigentik@gmail.com",               // the account Aigentik logs into (IMAP/SMTP auth)
    "app_password": "xxxx xxxx xxxx xxxx",       // 16-char Gmail App Password, NOT your login password
    "send_as": null,                             // optional: a verified Gmail "Send mail as" alias
                                                  // (Settings > Accounts > Send mail as) to put in the
                                                  // From header of customer-facing mail instead of
                                                  // `email` — e.g. "contact@yourbusiness.com" forwarding
                                                  // into this inbox. Leave null/omit to send as `email`.
                                                  // Google Voice SMS replies and owner notifications
                                                  // always use `email` regardless, since GV routing
                                                  // depends on the authenticated account, not an alias.
    "imap_host": "imap.gmail.com",
    "imap_port": 993,
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 587
  },
  "llama": {
    "host": "http://127.0.0.1:8080",             // where llama-server listens
    "model": "...",                              // model name/path passed in chat requests
    "model_path": "~/models/.../model.gguf",     // path llama-server is launched with (~ expands to $HOME)
    "llama_server_path": "/path/to/llama-server", // the built binary
    "context_size": 4096,
    "max_tokens": 512,                           // per-reply generation cap
    "temperature": 0.7,
    "threads": 4
  },
  "llm": {
    "provider": "local"                          // "local" (default), "gemini", or "vertex" — see AI provider switching below
  },
  "gemini": {
    "api_key": "",                               // required if provider is/becomes "gemini" — a Google AI Studio key
    "model": "gemini-2.0-flash",
    "host": "https://generativelanguage.googleapis.com/v1beta/openai" // Gemini's OpenAI-compatible endpoint base
  },
  "vertex": {
    "api_key": "",                               // required if provider is/becomes "vertex" — a Vertex AI (Express Mode) key
    "model": "gemini-2.5-flash",                 // 2.0/1.5-series models 404 under Express Mode even where available on AI Studio
    "host": "https://aiplatform.googleapis.com/v1"
  },
  "sms": {
    "poll_interval_ms": 30000,                   // unused by any currently active code path (legacy)
    "max_sms_fetch": 10                          // unused by any currently active code path (legacy)
  },
  "behavior": {
    "paused": false,                             // true = ignore everything on every channel
    "pause_email": false,                        // true = stop auto-replying/queuing email specifically
    "pause_sms": false,                          // true = stop auto-replying/queuing Google Voice texts specifically
    "require_confirmation_for_destructive": true,// documented intent; the confirmation flow itself is always on regardless
    "default_unmatched_action": "auto-reply",    // what to do with an EMAIL that matches no rule
    "default_unmatched_sms_action": "auto-reply",// what to do with a GOOGLE VOICE TEXT that matches no rule
    "tone_matching": true                        // documented intent; tone detection always runs for SMS-shaped replies
  },
  "paths": {
    "data_dir": "/data/data/com.termux/files/home/Aigentik-CLI/data",
    "logs_dir": "/data/data/com.termux/files/home/Aigentik-CLI/data/logs",
    "conversations_dir": "/data/data/com.termux/files/home/Aigentik-CLI/data/conversations" // reserved, not currently used
  }
}
```

A few fields are worth calling out specifically:

- **`owner.admin_email`** is new: an email arriving from this address is routed straight into the same command interpreter as a text from `admin_number` — see [Who Aigentik listens to as "the owner"](architecture.md#who-aigentik-listens-to-as-the-owner).
- **`sms.*`** exists in the config schema but nothing in the current codebase reads it — it's left over from an earlier version that polled a Termux SMS inbox directly. Harmless to leave as-is.
- **`behavior.require_confirmation_for_destructive`** and **`behavior.tone_matching`** describe intended behavior that isn't actually gated behind these flags in code today — the confirmation flow for destructive actions and tone detection both always run. Toggling these currently has no effect.
- **`llm.provider`** decides which AI backend `llama.js`'s `chat()` calls — everything in the app (reply generation, command interpretation, role-router classification, extraction) goes through that one function, so this one setting controls all of it. `local` (the default) talks to `llama.host` exactly as before; `gemini` talks to Google AI Studio's OpenAI-compatible endpoint using `gemini.api_key`/`gemini.model`; `vertex` talks to Google Vertex AI's native `generateContent` endpoint using `vertex.api_key`/`vertex.model` — a genuinely different Google product from `gemini` (different key format, different request shape, different model catalog: 2.0/1.5-series models 404 under Vertex AI Express Mode even when they work fine on AI Studio), not just an alternate name for the same one. Say **"use gemini"**, **"use vertex"**, or **"use local"** (also: "switch to gemini"/"switch to vertex"/"switch to local") to flip it live without restarting Aigentik — this is a runtime-only change (like `behavior.paused`), so it reverts to whatever `llm.provider` says here on the next restart; edit this field directly if you want a different persistent default. Say **"ai status"** to see which one is currently active. Switching to `gemini`/`vertex` fails with a clear message if the matching `api_key` is empty; at startup, the local `llama-server` process is only launched at all if `provider` is `local`, so a cloud-only setup doesn't need `llama.cpp` built or running.
- **Gemini 2.5 models think by default** — they can spend an entire small token budget (e.g. a 10-token warm-up ping) on invisible reasoning before producing visible text, which reads as an empty response. `chatVertex` in `llama.js` sets `generationConfig.thinkingConfig.thinkingBudget: 0` to disable that, the same problem (and same fix shape) as the `enable_thinking: false` flag already set for the local Qwen model.
- **Vertex AI Express Mode's free-tier quota is easy to exhaust.** A single incoming customer message can trigger several LLM calls in a row (role classification, appointment-type detection's LLM fallback, field extraction, reply generation), and a `429 RESOURCE_EXHAUSTED` from one of those mid-conversation surfaces to the customer as a dropped or generic reply rather than a clear error — encountered during live testing with nothing more than a handful of messages in one conversation. Worth keeping in mind before relying on `vertex` (or `gemini`) as the sole provider for real traffic; `local` has no such external rate limit.

See [Installation](installation.md) for how `install.sh` generates a starter `config.json` for you, and [Data files](data-files.md) for everything else persisted under `data/`.

---

[← Back to README](../README.md) · [All documentation](README.md)

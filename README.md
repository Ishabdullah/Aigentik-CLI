# Aigentik

**Aigentik** is a fully local AI assistant running on Android (Termux) that manages your Gmail and Google Voice communications. It runs entirely on your device — no cloud APIs, no data leaves your phone.

## Features

- **📧 Gmail via IMAP IDLE** — Push email notifications, zero polling (powered by `imapflow`)
- **💬 Google Voice SMS** — Receive texts via Gmail email forwarding; reply via SMTP
- **🤖 Local AI (Qwen3-4B)** — All inference runs on-device via `llama.cpp`
- **🗣 Natural language control** — Text commands to your Google Voice number
- **👥 Contact intelligence** — Auto-builds contact directory from messages
- **⚙️ Rule engines** — Per-contact and global rules for auto-reply, spam, review
- **📋 Review queue** — Draft replies queued for your approval via SMS
- **🎭 Tone matching** — Detects message tone and mirrors it in responses

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Aigentik (Node.js)                       │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│   Gmail      │   llama.cpp  │   Contacts   │    Queue          │
│   (IMAP      │   (HTTP API) │   (JSON)     │    (JSON)         │
│    IDLE)     │              │              │                   │
└──────┬───────┴──────┬───────┴──────┬───────┴────────┬──────────┘
       │              │              │                │
       ▼              ▼              ▼                ▼
┌─────────────┐ ┌───────────┐ ┌────────────┐ ┌─────────────┐
│  Gmail      │ │  Qwen3-4B │ │  contacts  │ │  pending    │
│  SMTP/IMAP  │ │  (local)  │ │  .json     │ │  .json      │
└─────────────┘ └───────────┘ └────────────┘ └─────────────┘
       │
       ▼
┌─────────────────────┐
│  Google Voice       │
│  (email forwarding) │
└─────────────────────┘
```

## Requirements

- Android device with **Termux** and **Termux:API**
- **Node.js 18+** (`pkg install nodejs`)
- **llama.cpp** built with `llama-server` binary
- **Qwen3-4B-Instruct GGUF model** (~2.5 GB)
- **Gmail account** with App Password
- **Google Voice number** (for SMS via email forwarding)

## Installation

### 1. Install Termux & Termux:API
```bash
# From F-Droid or GitHub releases
# Grant SMS, Contacts, and Storage permissions in Android settings
```

### 2. Install Node.js & Build llama.cpp
```bash
pkg install nodejs git cmake make

# Build llama.cpp
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
mkdir build && cd build
cmake .. -DLLAMA_CURL=OFF -DGGML_OPENMP=ON
make -j$(nproc)
# Binary at: ./bin/llama-server
```

### 3. Download Model
```bash
# Qwen3-4B-Instruct-2507-Q4_K_M.gguf (~2.5 GB)
# Place at: ~/models/qwen3-4b-instruct/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

### 4. Clone & Configure Aigentik
```bash
git clone https://github.com/yourusername/Aigentik-CLI.git ~/Aigentik-CLI
cd ~/Aigentik-CLI
npm install  # Installs imapflow, nodemailer, mailparser
```

### 5. Configure `config.json`
Copy `config.json.example` to `config.json` and fill in:

```json
{
  "owner": {
    "admin_number": "15551234567",           // Your Google Voice number (admin)
    "admin_number_formatted": "+15551234567",
    "aigentik_number": "15559876543",        // Public Google Voice number
    "aigentik_number_formatted": "+15559876543"
  },
  "gmail": {
    "email": "your@gmail.com",
    "app_password": "xxxx xxxx xxxx xxxx",   // Gmail App Password (16 chars)
    "imap_host": "imap.gmail.com",
    "imap_port": 993,
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 587
  },
  "llama": {
    "host": "http://127.0.0.1:8080",
    "model": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    "model_path": "~/models/qwen3-4b-instruct/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    "llama_server_path": "/data/data/com.termux/files/home/llama.cpp/build/bin/llama-server",
    "context_size": 4096,
    "max_tokens": 512,
    "temperature": 0.7,
    "threads": 4
  },
  "sms": {
    "poll_interval_ms": 30000,
    "max_sms_fetch": 10
  },
  "behavior": {
    "paused": false,
    "pause_email": false,
    "pause_sms": false,
    "require_confirmation_for_destructive": true,
    "default_unmatched_action": "auto-reply",
    "default_unmatched_sms_action": "review",
    "tone_matching": true
  },
  "paths": {
    "data_dir": "/data/data/com.termux/files/home/Aigentik-CLI/data",
    "logs_dir": "/data/data/com.termux/files/home/Aigentik-CLI/data/logs",
    "conversations_dir": "/data/data/com.termux/files/home/Aigentik-CLI/data/conversations"
  }
}
```

> ⚠️ **Never commit `config.json`** — it contains secrets. Add to `.gitignore`.

### 6. Google Voice Setup
1. In Google Voice settings → **Messages** → Enable **"Forward messages to email"**
2. Texts to your Google Voice number arrive as emails from `txt.voice.google.com`
3. Aigentik parses these automatically via Gmail IMAP

## Usage

### Start Aigentik
```bash
cd ~/Aigentik-CLI
./start.sh
```

This launches:
- `llama-server` in tmux session `llama-server`
- Aigentik in tmux session `aigentik`

### View Logs
```bash
tmux attach -t aigentik
# Press Ctrl+B then D to detach
```

### Stop Aigentik
```bash
./stop.sh
```

### Run Tests
```bash
npm test
```

## Owner Commands (via Google Voice SMS)

Text your **admin Google Voice number** to control Aigentik:

| Command | Description |
|---------|-------------|
| `list` / `pending` / `queue` | Show pending review items |
| `status` / `ping` | System health check |
| `reply [#]` | Send draft reply for queue item |
| `edit [#] [new text]` | Replace draft for item |
| `skip [#]` | Dismiss item |
| `spam [#]` | Mark as spam & dismiss |
| `email rules` | List email rules |
| `sms rules` | List SMS rules |
| `contacts` | List saved contacts |
| `pause` / `resume` | Pause/resume all processing |
| `pause email` / `resume email` | Pause/resume email only |
| `pause sms` / `resume sms` | Pause/resume SMS only |
| `rename [name]` | Rename your Aigentik |
| `sync contacts` | Refresh contacts from phone |
| `text [name] [message]` | Send SMS via shorthand |
| `email [name] about [topic]` | Send email via shorthand |

### Natural Language Examples
```
"auto-reply to anything from my boss"
"spam all emails from amazon.com"
"never reply to spam caller"
"always reply to Mom"
"find contact Sarah"
"clean inbox"          → confirms before archiving ALL
"delete all emails"    → confirms before deleting ALL
```

## Rule Engines

### Email Rules (`email-rules.js`)
Conditions: `from`, `domain`, `subject_contains`, `body_contains`, `promotional`, `any`
Actions: `auto-reply`, `review`, `spam`, `delete`, `archive`

```bash
# Via SMS:
"add email rule: auto-reply to emails from boss@company.com"
"add email rule: spam anything from marketing domain"
```

### SMS Rules (`sms-rules.js`)
Conditions: `from_number`, `message_contains`, `any`
Actions: `auto-reply`, `review`, `spam`

```bash
# Via SMS:
"add sms rule: auto-reply to texts from 5551234567"
"add sms rule: spam messages containing 'winner'"
```

## Data Files

All persistent data in `~/Aigentik-CLI/data/`:
| File | Description |
|------|-------------|
| `contacts.json` | Contact directory (auto-built + manual) |
| `email-rules.json` | Email routing rules |
| `sms-rules.json` | SMS routing rules |
| `pending.json` | Review queue |
| `profile.json` | Aigentik name, owner name, setup date |
| `seen-sms-ids.json` | Processed SMS IDs (deduplication) |
| `logs/` | Daily JSON logs |

## How It Works

### Email Flow
1. Gmail IMAP IDLE pushes new email → `email-provider.js` (via `gmail.js` compatibility wrapper)
2. `index.js` routes: Google Voice texts → `handleGoogleVoiceText`, others → `handleNewEmail`
3. Check email rules → `email-rules.js`
4. Generate AI reply → `llama.js` → `generateEmailReply`
5. Auto-reply OR queue for review → `queue.js` + owner notification via email

### SMS Flow (Google Voice)
1. Text to your GV number → Google Voice forwards as email to Gmail
2. Gmail IMAP IDLE pushes → `email-provider.js` → `parseGoogleVoiceEmail`
3. Route: admin number → `owner-command.js`; others → `sms-public.js`
4. Check contact behavior + SMS rules → `contacts.js` + `sms-rules.js`
5. Generate AI reply → `llama.js` → `generateSmsReply`
6. Auto-reply via SMTP to GV email OR queue for review

### Owner Commands
1. SMS from admin number → `owner-command.js`
2. AI interprets natural language → `llama.js` → `interpretCommand`
3. Execute action (queue, rules, contacts, system control)
4. Reply to owner via email notification

## Troubleshooting

### llama-server won't start
```bash
# Check binary exists
ls -la ~/llama.cpp/build/bin/llama-server

# Test manually
~/llama.cpp/build/bin/llama-server -m "~/models/qwen3-4b-instruct/Qwen3-4B-Instruct-2507-Q4_K_M.gguf" -c 4096 --host 127.0.0.1 --port 8080
```

### Gmail connection fails
- Verify App Password (not account password)
- Enable "Less secure apps" or use App Password
- Check IMAP enabled in Gmail settings

### SMS not sending
- Grant Termux:API SMS permission: `termux-sms-send -n "5551234567" 'test'`
- Verify `termux-api` package installed

### Contacts not syncing
- Grant Termux:API Contacts permission
- Test: `termux-contact-list`

## Security

- **All AI runs locally** — no API keys, no cloud calls
- **Gmail App Password** stored in `config.json` (local only)
- **No external network access** except Gmail IMAP/SMTP and local llama-server
- **Data never leaves device**
- **Zero known vulnerabilities** — `npm audit` reports 0 issues
- **TLS 1.2+ enforced** for all IMAP/SMTP connections
- **Header injection prevention** and file/URL access disabled in SMTP
- **Automatic reconnection** with exponential backoff and jitter

## Recent Changes (v2.0)

### Email Subsystem Migration
- **Replaced `node-imap`** (deprecated since 2017, vulnerable) with **`imapflow`** — modern async/await IMAP client with native IDLE, auto-reconnect, connection pooling
- **Upgraded `nodemailer`** 6.9.9 → 9.0.3 — fixes 8 high-severity vulnerabilities (SMTP injection, TLS validation, SSRF, header injection)
- **Upgraded `mailparser`** 3.6.6 → 3.9.14
- **Removed `node-fetch`** — uses native `fetch` API (Node.js 18+)
- **Full ES module migration** — all 16 source files converted
- **New `EmailProvider` class** with production-grade resilience:
  - Exponential backoff reconnection (5s base, 5min max, ±25% jitter)
  - Management connection pool (3 connections) for bulk operations
  - Native IDLE with automatic restart on failure
  - Graceful shutdown with proper resource cleanup
- **Backward compatibility** — `gmail.js` wrapper preserves all 15 public APIs
- **Unit tests** — 9 passing tests for core email functionality

See `MIGRATION_REPORT.md` for full details.

## License

MIT

## Contributing

1. Fork the repo
2. Create feature branch
3. Submit PR with clear description

## Acknowledgments

- [llama.cpp](https://github.com/ggerganov/llama.cpp) — Local LLM inference
- [Qwen3](https://github.com/QwenLM/Qwen) — Base model
- [imapflow](https://github.com/imapflow/imapflow) — Modern IMAP client
- [Termux](https://termux.dev/) — Linux environment on Android
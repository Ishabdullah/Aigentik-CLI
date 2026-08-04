> [← Back to README](../README.md) · [All documentation](README.md)

# Installation

## Table of Contents

- [Requirements](#requirements)
- [Quick install (recommended)](#quick-install-recommended)
- [Manual installation](#manual-installation)
- [Termux vs. Linux](#termux-vs-linux)
- [Turn on Google Voice email forwarding](#turn-on-google-voice-email-forwarding)
- [Running Aigentik](#running-aigentik)

## Requirements

- **Termux** (Android) or a mainstream **Linux** distro — see [Termux vs. Linux](#termux-vs-linux) for what differs
- On Android specifically: **Termux:API** installed too (grant it Contacts permission — that's the only Android permission Aigentik needs, and it's optional; see below)
- **Node.js 18+**
- **llama.cpp**, built with the `llama-server` binary
- A **GGUF model** — this project is tuned around Qwen3-4B-Instruct, but any chat-completions-compatible model llama-server can serve will work
- A **Gmail account** with an **App Password** (IMAP/SMTP access, not your normal password)
- A **Google Voice number**, with SMS forwarding to that Gmail account turned on

## Quick install (recommended)

```bash
git clone https://github.com/Ishabdullah/Aigentik-CLI.git ~/Aigentik-CLI
cd ~/Aigentik-CLI
./install.sh
```

`install.sh` handles everything except the Termux/Termux:API apps themselves (Android app-store installs aren't scriptable) and the Gmail/Google Voice account setup below: it installs system packages (Node.js, git, cmake, a compiler, and — in Termux — the `termux-api` CLI bridge), clones and builds llama.cpp, downloads a GGUF model, runs `npm install`, and generates a starter `config.json` with the local paths (llama-server binary, model file, data directory) already filled in correctly for wherever you cloned the repo. It's safe to re-run any time — every step checks whether its result already exists first and skips it if so, and it will never overwrite an existing `config.json`.

Pass `--skip-llama` and/or `--skip-model` if you already have a `llama-server` binary or GGUF model elsewhere and want to point `config.json` at those manually instead (see the [Configuration reference](configuration.md)).

When it finishes, it prints exactly what's still left to do by hand — a Gmail App Password, Google Voice forwarding, and filling in the placeholder fields in `config.json` — the same three things covered in detail below.

## Manual installation

If you'd rather do each step yourself (or `install.sh` doesn't cover your setup), here's the same process broken out:

**1. Termux & Termux:API** (Android only — skip if you're on Linux)

Install both from F-Droid (the Play Store builds are outdated and unsupported for this kind of use). Open Termux:API's Android permission screen once and grant **Contacts** access. This is only needed for automatic Android-contact syncing — Aigentik runs fine without it.

**2. System packages**

```bash
# Termux
pkg install nodejs git cmake make clang

# Debian/Ubuntu
sudo apt-get install nodejs git cmake build-essential curl
```

If your distro's `nodejs` package is older than 18, install a newer one via [nodejs.org](https://nodejs.org/) or `nvm` instead.

**3. Build llama.cpp**

```bash
git clone https://github.com/ggerganov/llama.cpp ~/llama.cpp
cd ~/llama.cpp
mkdir build && cd build
cmake .. -DLLAMA_CURL=OFF -DGGML_OPENMP=ON
make -j$(nproc) llama-server
# binary ends up at ~/llama.cpp/build/bin/llama-server
```

**4. Get a model**

Download a GGUF chat model and place it somewhere under your home directory, e.g.:

```
~/models/qwen3-4b-instruct/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

**5. Clone and install Aigentik**

```bash
git clone https://github.com/Ishabdullah/Aigentik-CLI.git ~/Aigentik-CLI
cd ~/Aigentik-CLI
npm install
```

**6. Configure**

```bash
cp config.json.example config.json
```

Edit `config.json` — see the [full reference](configuration.md) for every field. At minimum you need to fill in `gmail.email`, `gmail.app_password`, `owner.admin_number*`, `owner.admin_email`, and the `llama.*` paths to match where you built llama.cpp and put the model in steps 3–4.

`config.json` is git-ignored on purpose — it holds your Gmail app password. Never commit it.

## Termux vs. Linux

Aigentik was built for **Termux on Android** — that's the "runs entirely on your phone" pitch — but nothing about the Node.js application itself is Android-specific, so it runs on a regular Linux box too (useful for development, or if you'd rather host it on a server). What differs between the two:

| | Termux | Linux |
|---|---|---|
| Package manager | `pkg` | your distro's (`apt`, `dnf`, `pacman`, ...) |
| Shell paths | Sandboxed under `/data/data/com.termux/files/...` — no `/usr/bin/env`, no `/bin/bash` at the standard location | Standard FHS paths |
| Android contact sync (`contacts-sync.js`, `termux-contact-list`) | Works, if the Termux:API app is installed and granted Contacts permission | Not applicable — there's no Android contact list to read. Aigentik still builds its contact directory from everyone who emails/texts in; it just never has phone contacts to merge in ahead of time. |
| Everything else (Gmail, Google Voice via email, the local LLM, scheduling, rules) | Identical — none of it is Android-specific | Identical |

`install.sh`, `start.sh`, and `stop.sh` all detect which environment they're running in and adjust accordingly (they use a `#!/bin/sh`-based shebang that re-execs into bash, since Termux has neither `/usr/bin/env` nor bash at a standard path).

## Turn on Google Voice email forwarding

In Google Voice: **Settings → Messages → Forward text messages via email**, pointed at the same Gmail account in `config.json`. Incoming texts will now arrive in that inbox as emails from `txt.voice.google.com`, and Aigentik does the rest.

## Running Aigentik

Once `./install.sh` (or the manual steps) has set everything up and `config.json` is filled in:

```bash
cd ~/Aigentik-CLI
./start.sh    # starts llama-server if it isn't already running, then Aigentik itself
```

`start.sh` checks that Node.js is installed and that `config.json` has a Gmail address filled in (exiting with a clear error if either is missing), then launches `node index.js` in the background with output redirected to `aigentik.log`. In Termux specifically, it also checks for `termux-api` and warns (but doesn't block startup) if it's missing, since that only affects Android-contact syncing.

```bash
tail -f ~/Aigentik-CLI/aigentik.log   # watch it live
./stop.sh                             # stop it
```

On startup, in order: it starts (or confirms) `llama-server`, warms it up with a test completion, loads your profile (Aigentik's name, your name, business identity) from `data/profile.json` — creating it with everything but Aigentik's own name left blank if this is a fresh install — does a one-time sync of your Android contacts, connects to Gmail and starts the IMAP IDLE watch, and finally either emails you an "I'm online" notification, or, if the owner's name or business info is still missing, an onboarding request instead (see [First-run onboarding](onboarding.md)). From then on it just sits in `IDLE`, woken up only by actual mailbox changes.

Shutdown (`Ctrl+C` or `SIGTERM`) logs out of IMAP and closes the SMTP transporter cleanly before the process exits.

---

[← Back to README](../README.md) · [All documentation](README.md)

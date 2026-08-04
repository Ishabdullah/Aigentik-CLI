#!/bin/sh
# install.sh — Aigentik one-shot installer
#
# Installs everything Aigentik needs to run: system packages, llama.cpp
# (built from source with the llama-server binary), a GGUF model, Node.js
# dependencies, and a starter config.json — then prints exactly what you
# still need to do by hand (Gmail App Password, Google Voice forwarding,
# editing config.json) to actually turn it on.
#
# Safe to re-run: every step checks whether its result already exists and
# skips it if so. Nothing here overwrites an existing config.json.
#
# Usage: ./install.sh [--skip-model] [--skip-llama] [--help]
#
# Shebang is /bin/sh, not bash, on purpose: Termux has no /usr/bin/env and
# no bash at /bin/bash (it lives under Termux's own prefix), while /bin/sh
# reliably exists in both Termux and mainstream Linux. Re-exec into bash
# (found via PATH) immediately, since the rest of this script uses bash
# features (arrays) that plain sh doesn't have.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -u

# ─── Options ──────────────────────────────────────────────────────────────

SKIP_MODEL=0
SKIP_LLAMA=0
for arg in "$@"; do
  case "$arg" in
    --skip-model) SKIP_MODEL=1 ;;
    --skip-llama) SKIP_LLAMA=1 ;;
    --help|-h)
      echo "Usage: ./install.sh [--skip-model] [--skip-llama]"
      echo ""
      echo "  --skip-model   Don't download the GGUF model (bring your own)"
      echo "  --skip-llama   Don't clone/build llama.cpp (bring your own llama-server)"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (see --help)"
      exit 1
      ;;
  esac
done

# ─── Output helpers ───────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_BLUE='\033[34m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BLUE=''
fi

step()  { echo -e "\n${C_BOLD}${C_BLUE}==>${C_RESET}${C_BOLD} $*${C_RESET}"; }
ok()    { echo -e "  ${C_GREEN}✓${C_RESET} $*"; }
skip()  { echo -e "  ${C_YELLOW}·${C_RESET} $* ${C_YELLOW}(already present, skipping)${C_RESET}"; }
warn()  { echo -e "  ${C_YELLOW}!${C_RESET} $*"; }
fail()  { echo -e "  ${C_RED}✗${C_RESET} $*"; }
die()   { fail "$*"; exit 1; }

# ─── Paths & environment detection ────────────────────────────────────────

AIGENTIK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLAMA_DIR="$HOME/llama.cpp"
LLAMA_SERVER_BIN="$LLAMA_DIR/build/bin/llama-server"
MODEL_DIR="$HOME/models/qwen3-4b-instruct"
MODEL_FILE="Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
MODEL_PATH="$MODEL_DIR/$MODEL_FILE"
MODEL_URL="https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/$MODEL_FILE"

IS_TERMUX=0
if [ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *"com.termux"* ]]; then
  IS_TERMUX=1
fi

JOBS="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"

echo -e "${C_BOLD}🤖 Aigentik installer${C_RESET}"
echo "Install directory: $AIGENTIK_DIR"
if [ "$IS_TERMUX" = "1" ]; then
  echo "Environment: Termux (Android)"
else
  echo "Environment: Linux"
fi

# ─── 1. System packages ───────────────────────────────────────────────────

step "Checking system packages"

if [ "$IS_TERMUX" = "1" ]; then
  NEEDED_PKGS=()
  command -v node    >/dev/null 2>&1 || NEEDED_PKGS+=(nodejs)
  command -v git      >/dev/null 2>&1 || NEEDED_PKGS+=(git)
  command -v cmake    >/dev/null 2>&1 || NEEDED_PKGS+=(cmake)
  command -v make     >/dev/null 2>&1 || NEEDED_PKGS+=(make)
  command -v clang    >/dev/null 2>&1 || NEEDED_PKGS+=(clang)
  command -v curl     >/dev/null 2>&1 || NEEDED_PKGS+=(curl)
  command -v termux-contact-list >/dev/null 2>&1 || NEEDED_PKGS+=(termux-api)

  if [ "${#NEEDED_PKGS[@]}" -eq 0 ]; then
    skip "nodejs, git, cmake, make, clang, curl, termux-api"
  else
    echo "  Installing: ${NEEDED_PKGS[*]}"
    pkg update -y >/dev/null 2>&1
    pkg install -y "${NEEDED_PKGS[@]}" || die "Failed to install: ${NEEDED_PKGS[*]}"
    ok "Installed: ${NEEDED_PKGS[*]}"
  fi

  echo ""
  warn "Termux:API is the CLI bridge package — the Termux:API ${C_BOLD}app${C_RESET} itself must"
  warn "still be installed separately from F-Droid (same source as Termux itself; the"
  warn "Play Store build won't work). Open it once, then grant it Contacts permission"
  warn "in Android Settings → Apps → Termux:API → Permissions. This is only needed for"
  warn "automatic Android-contacts sync — Aigentik runs fine without it."
else
  if command -v apt-get >/dev/null 2>&1; then
    NEEDED_PKGS=()
    command -v git    >/dev/null 2>&1 || NEEDED_PKGS+=(git)
    command -v cmake  >/dev/null 2>&1 || NEEDED_PKGS+=(cmake)
    command -v make   >/dev/null 2>&1 || NEEDED_PKGS+=(build-essential)
    command -v curl   >/dev/null 2>&1 || NEEDED_PKGS+=(curl)

    if [ "${#NEEDED_PKGS[@]}" -eq 0 ]; then
      skip "git, cmake, build-essential, curl"
    else
      echo "  Installing (sudo required): ${NEEDED_PKGS[*]}"
      sudo apt-get update -y && sudo apt-get install -y "${NEEDED_PKGS[@]}" \
        || die "Failed to install: ${NEEDED_PKGS[*]}. Install these manually and re-run."
      ok "Installed: ${NEEDED_PKGS[*]}"
    fi
  else
    warn "No apt-get found — install these manually before continuing, then re-run:"
    warn "  git, cmake, make, a C/C++ compiler (gcc or clang), curl"
  fi

  if ! command -v node >/dev/null 2>&1; then
    warn "Node.js not found. This script won't silently pipe an install script into"
    warn "bash for you — install Node.js 18+ yourself (via your distro's package"
    warn "manager, nvm, or https://nodejs.org/) and re-run this script."
  fi
fi

command -v node >/dev/null 2>&1 && ok "Node.js: $(node --version)"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    die "Node.js 18+ required, found $(node --version). Upgrade and re-run."
  fi
else
  die "Node.js is required. Install it and re-run this script."
fi

# ─── 2. llama.cpp ──────────────────────────────────────────────────────────

step "Setting up llama.cpp"

if [ "$SKIP_LLAMA" = "1" ]; then
  skip "llama.cpp build (--skip-llama)"
elif [ -x "$LLAMA_SERVER_BIN" ]; then
  skip "llama-server binary at $LLAMA_SERVER_BIN"
else
  if [ ! -d "$LLAMA_DIR" ]; then
    echo "  Cloning llama.cpp into $LLAMA_DIR..."
    git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_DIR" \
      || die "Failed to clone llama.cpp"
  else
    ok "llama.cpp source already present at $LLAMA_DIR"
  fi

  echo "  Building llama-server (this can take several minutes)..."
  (
    cd "$LLAMA_DIR" || exit 1
    mkdir -p build && cd build || exit 1
    cmake .. -DLLAMA_CURL=OFF -DGGML_OPENMP=ON || exit 1
    make -j"$JOBS" llama-server || exit 1
  ) || die "llama.cpp build failed — see output above"

  [ -x "$LLAMA_SERVER_BIN" ] || die "Build finished but $LLAMA_SERVER_BIN wasn't produced"
  ok "Built llama-server at $LLAMA_SERVER_BIN"
fi

# ─── 3. Model ──────────────────────────────────────────────────────────────

step "Setting up the language model"

if [ "$SKIP_MODEL" = "1" ]; then
  skip "model download (--skip-model)"
elif [ -s "$MODEL_PATH" ]; then
  skip "model file at $MODEL_PATH"
else
  mkdir -p "$MODEL_DIR"
  echo "  Downloading $MODEL_FILE (~2.5GB, this can take a while)..."
  if curl -fL --retry 3 --retry-delay 5 -o "$MODEL_PATH.part" "$MODEL_URL"; then
    mv "$MODEL_PATH.part" "$MODEL_PATH"
    ok "Downloaded model to $MODEL_PATH"
  else
    rm -f "$MODEL_PATH.part"
    MODEL_DOWNLOAD_FAILED=1
    warn "Automatic download failed (URL may have moved, or you're offline)."
    warn "Download a GGUF chat model manually and place it at:"
    warn "  $MODEL_PATH"
    warn "Search Hugging Face for \"Qwen3-4B-Instruct-2507 GGUF\" (Q4_K_M is a good"
    warn "size/quality balance), or use any other chat-completions-compatible GGUF —"
    warn "just update llama.model / llama.model_path in config.json to match."
  fi
fi

# ─── 4. Node dependencies ──────────────────────────────────────────────────

step "Installing Node.js dependencies"

if [ -d "$AIGENTIK_DIR/node_modules" ]; then
  skip "node_modules"
else
  (cd "$AIGENTIK_DIR" && npm install) || die "npm install failed"
  ok "Installed Node.js dependencies"
fi

# ─── 5. config.json ─────────────────────────────────────────────────────────

step "Setting up config.json"

CONFIG_PATH="$AIGENTIK_DIR/config.json"

if [ -f "$CONFIG_PATH" ]; then
  skip "config.json (existing file left untouched)"
else
  # Built directly (not parsed from config.json.example, which is JSONC —
  # human-readable comments, not valid JSON) so the fields Aigentik actually
  # reads (import ... with { type: 'json' }, which requires strict JSON) are
  # never at the mercy of a comment-stripping regex breaking on a future edit.
  DATA_DIR="$AIGENTIK_DIR/data"
  node -e "
    const fs = require('fs');
    const cfg = {
      owner: {
        admin_number: '18025551234',
        admin_number_formatted: '+18025551234',
        aigentik_number: '18025555678',
        aigentik_number_formatted: '+18025555678',
        admin_email: 'your@gmail.com'
      },
      gmail: {
        email: 'your@gmail.com',
        app_password: 'xxxx xxxx xxxx xxxx',
        imap_host: 'imap.gmail.com',
        imap_port: 993,
        smtp_host: 'smtp.gmail.com',
        smtp_port: 587
      },
      llama: {
        host: 'http://127.0.0.1:8080',
        model: '$MODEL_PATH',
        model_path: '$MODEL_PATH',
        llama_server_path: '$LLAMA_SERVER_BIN',
        context_size: 4096,
        max_tokens: 512,
        temperature: 0.7,
        threads: ${JOBS}
      },
      sms: { poll_interval_ms: 30000, max_sms_fetch: 10 },
      behavior: {
        paused: false,
        pause_email: false,
        pause_sms: false,
        require_confirmation_for_destructive: true,
        default_unmatched_action: 'auto-reply',
        default_unmatched_sms_action: 'review',
        tone_matching: true
      },
      paths: {
        data_dir: '$DATA_DIR',
        logs_dir: '$DATA_DIR/logs',
        conversations_dir: '$DATA_DIR/conversations'
      }
    };
    fs.writeFileSync('$CONFIG_PATH', JSON.stringify(cfg, null, 2));
  " || die "Failed to generate config.json"
  ok "Created config.json with local paths filled in (llama/model paths, data dir)"
  warn "gmail.*, owner.admin_number*, and owner.admin_email are still placeholders —"
  warn "fill those in before running Aigentik (see the checklist below)."
fi

mkdir -p "$AIGENTIK_DIR/data"

# ─── Done ───────────────────────────────────────────────────────────────────

echo ""
if [ "${MODEL_DOWNLOAD_FAILED:-0}" = "1" ]; then
  echo -e "${C_BOLD}${C_YELLOW}⚠️  Install finished with warnings — the model download failed, see above.${C_RESET}"
  echo "Aigentik will not start until a GGUF model exists at the path shown above."
else
  echo -e "${C_BOLD}${C_GREEN}✅ Install steps complete.${C_RESET}"
fi
echo ""
echo -e "${C_BOLD}Before you can run Aigentik, finish these steps:${C_RESET}"
echo ""
echo -e "${C_BOLD}1. Create a Gmail App Password${C_RESET} for the account Aigentik will log into:"
echo "     - That Google account needs 2-Step Verification turned on first"
echo "       (myaccount.google.com/security)"
echo "     - Then generate an App Password at:"
echo "       myaccount.google.com/apppasswords"
echo "     - Choose \"Mail\" as the app — you'll get a 16-character code"
echo "     - This is NOT your normal Gmail password; your real password won't work"
echo ""
echo -e "${C_BOLD}2. Set up Google Voice text forwarding${C_RESET} to that same Gmail account:"
echo "     - In Google Voice: Settings → Messages → \"Forward text messages via email\""
echo "     - Point it at the Gmail address from step 1"
echo "     - Incoming texts will now arrive as emails from txt.voice.google.com,"
echo "       which is how Aigentik sees and replies to them"
echo ""
echo -e "${C_BOLD}3. Edit config.json${C_RESET} ($CONFIG_PATH):"
echo "     - gmail.email / gmail.app_password  → from step 1"
echo "     - owner.admin_number / admin_number_formatted → your phone number"
echo "     - owner.aigentik_number / aigentik_number_formatted → the Google Voice number"
echo "     - owner.admin_email → your personal email (treated like admin_number for commands)"
echo "     See docs/configuration.md for every field."
echo ""
if [ "$IS_TERMUX" = "1" ]; then
  echo -e "${C_BOLD}4. Grant Termux:API Contacts permission${C_RESET} (optional, for contact sync):"
  echo "     - Install the Termux:API app from F-Droid if you haven't"
  echo "     - Android Settings → Apps → Termux:API → Permissions → Contacts"
  echo ""
  echo -e "${C_BOLD}5. Start Aigentik:${C_RESET}"
else
  echo -e "${C_BOLD}4. Start Aigentik:${C_RESET}"
fi
echo "     cd $AIGENTIK_DIR && ./start.sh"
echo "     tail -f aigentik.log   # watch it live"
echo "     ./stop.sh              # stop it"
echo ""
echo "Full documentation: $AIGENTIK_DIR/README.md and $AIGENTIK_DIR/docs/"

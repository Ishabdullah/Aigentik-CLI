#!/bin/sh
# start.sh — Aigentik startup script
#
# Shebang is /bin/sh, not bash: Termux has no /usr/bin/env and no bash at
# /bin/bash (it lives under Termux's own prefix), while /bin/sh reliably
# exists in both Termux and mainstream Linux. Re-exec into bash immediately.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

AIGENTIK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "🤖 Starting Aigentik..."
echo ""

# Check Node.js is available
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found."
  if [ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *"com.termux"* ]]; then
    echo "   Install it with: pkg install nodejs"
  fi
  exit 1
fi

# Android contacts sync needs Termux:API — only relevant in Termux, and only
# a warning even there, since Aigentik runs fine without it (see README).
if [ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *"com.termux"* ]]; then
  if ! command -v termux-contact-list &> /dev/null; then
    echo "⚠️  Termux:API not found — Android contact sync will be skipped."
    echo "   Install with: pkg install termux-api (plus the Termux:API app from F-Droid)"
  fi
fi

# Check config has been filled in — not just present, since install.sh
# always creates one with placeholder values ('your@gmail.com', etc.) that
# would otherwise pass a bare-existence check and fail later during IMAP
# login instead, in a log file nobody's watching yet on a first run.
EMAIL=$(node -e "const c=require('$AIGENTIK_DIR/config.json'); console.log(c.gmail.email)" 2>/dev/null)
APP_PASSWORD=$(node -e "const c=require('$AIGENTIK_DIR/config.json'); console.log(c.gmail.app_password)" 2>/dev/null)
if [ -z "$EMAIL" ] || [ "$EMAIL" = "your@gmail.com" ] || [ -z "$APP_PASSWORD" ] || [ "$APP_PASSWORD" = "xxxx xxxx xxxx xxxx" ]; then
  echo "❌ Gmail not configured. Edit $AIGENTIK_DIR/config.json first"
  echo "   (run ./install.sh if you haven't yet — it creates a starter config.json)."
  echo "   Set your gmail.email and gmail.app_password"
  exit 1
fi

# Kill any existing Aigentik process
pkill -f "node index.js" 2>/dev/null && echo "⚡ Stopped previous Aigentik process"

# Start Aigentik in background
cd "$AIGENTIK_DIR"
nohup node index.js > aigentik.log 2>&1 &
AIGENTIK_PID=$!

sleep 3

# Check it started
if kill -0 $AIGENTIK_PID 2>/dev/null; then
  echo "✅ Aigentik started (PID: $AIGENTIK_PID)"
  echo ""
  echo "Useful commands:"
  echo "  tail -f $AIGENTIK_DIR/aigentik.log  — view live logs"
  echo "  ./stop.sh                           — stop Aigentik"
  echo ""
else
  echo "❌ Aigentik failed to start. Run: node $AIGENTIK_DIR/index.js to see errors"
fi


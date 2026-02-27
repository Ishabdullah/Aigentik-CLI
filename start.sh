#!/data/data/com.termux/files/usr/bin/bash
# start.sh — Aigentik startup script
# Run this from native Termux to start everything

AIGENTIK_DIR="/data/data/com.termux/files/home/aigentik"

echo ""
echo "🤖 Starting Aigentik..."
echo ""

# Check Node.js is available
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install it with: pkg install nodejs"
  exit 1
fi

# Check termux-api is available
if ! command -v termux-sms-send &> /dev/null; then
  echo "❌ Termux:API not found. Install it with: pkg install termux-api"
  exit 1
fi

# Check config has been filled in
EMAIL=$(node -e "const c=require('$AIGENTIK_DIR/config.json'); console.log(c.gmail.email)" 2>/dev/null)
if [ -z "$EMAIL" ]; then
  echo "❌ Gmail not configured. Edit ~/aigentik/config.json first."
  echo "   Set your gmail.email and gmail.app_password"
  exit 1
fi

# Kill any existing Aigentik session
tmux kill-session -t aigentik 2>/dev/null && echo "⚡ Stopped previous Aigentik session"

# Start Aigentik in a tmux session
tmux new-session -d -s aigentik "cd $AIGENTIK_DIR && node index.js"

sleep 3

# Check it started
if tmux has-session -t aigentik 2>/dev/null; then
  echo "✅ Aigentik started in tmux session 'aigentik'"
  echo ""
  echo "Useful commands:"
  echo "  tmux attach -t aigentik    — view live logs"
  echo "  tmux detach                — leave logs running (Ctrl+B then D)"
  echo "  ./stop.sh                  — stop Aigentik"
  echo ""
else
  echo "❌ Aigentik failed to start. Run: node ~/aigentik/index.js to see errors"
fi


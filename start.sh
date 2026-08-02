#!/data/data/com.termux/files/usr/bin/bash
# start.sh — Aigentik startup script
# Run this from native Termux to start everything

AIGENTIK_DIR="/data/data/com.termux/files/home/Aigentik-CLI"

echo ""
echo "🤖 Starting Aigentik..."
echo ""

# Check Node.js is available
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install it with: pkg install nodejs"
  exit 1
fi

# Check termux-api is available (needed for Android contacts sync)
if ! command -v termux-contact-list &> /dev/null; then
  echo "❌ Termux:API not found. Install it with: pkg install termux-api"
  exit 1
fi

# Check config has been filled in
EMAIL=$(node -e "const c=require('$AIGENTIK_DIR/config.json'); console.log(c.gmail.email)" 2>/dev/null)
if [ -z "$EMAIL" ]; then
  echo "❌ Gmail not configured. Edit ~/Aigentik-CLI/config.json first."
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
  echo "  tail -f ~/Aigentik-CLI/aigentik.log  — view live logs"
  echo "  ./stop.sh                           — stop Aigentik"
  echo ""
else
  echo "❌ Aigentik failed to start. Run: node ~/Aigentik-CLI/index.js to see errors"
fi


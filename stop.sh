#!/data/data/com.termux/files/usr/bin/bash
# stop.sh — Aigentik stop script

echo "⚡ Stopping Aigentik..."
pkill -f "node index.js" 2>/dev/null && echo "✅ Aigentik stopped." || echo "Aigentik was not running."

# Belt-and-suspenders: Aigentik's own SIGTERM handler stops llama-server it
# started, but clean it up directly too in case Aigentik was killed forcibly
# (SIGKILL) or crashed without running that handler, leaving it orphaned.
sleep 1
if pkill -f "llama-server" 2>/dev/null; then
  echo "✅ llama-server stopped."
fi


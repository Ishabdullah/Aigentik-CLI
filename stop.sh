#!/data/data/com.termux/files/usr/bin/bash
# stop.sh — Aigentik stop script

echo "⚡ Stopping Aigentik..."
tmux kill-session -t aigentik 2>/dev/null && echo "✅ Aigentik stopped." || echo "Aigentik was not running."


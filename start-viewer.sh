#!/usr/bin/env bash
# Open the cut-list viewer: pick a model, start the local server if it isn't
# running, and open it in the browser.
#
#   ./start-viewer.sh                    pick from a list
#   ./start-viewer.sh spinning-wheel     open that model straight away
#
# The server keeps running after this exits (so the page keeps working);
# ./start-viewer.sh --stop shuts it down.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/viewer"
PORT=8743
URL="http://localhost:$PORT/"
LOG="${XDG_CACHE_HOME:-$HOME/.cache}/woodmodels-viewer.log"
PIDFILE="${LOG%.log}.pid"

running() { curl -fs -o /dev/null "$URL"; }

if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$PIDFILE" ]] && kill "$(cat "$PIDFILE")" 2>/dev/null; then echo "Viewer stopped."; else echo "Viewer wasn't running (from here)."; fi
  rm -f "$PIDFILE"
  exit 0
fi

# models: the built-in one, then every folder listed in models/index.json
mapfile -t ROWS < <(python3 - <<'EOF'
import json
print('|' + json.load(open('model.json')).get('title', 'Built-in model'))
for m in json.load(open('models/index.json')):
    print(m['path'] + '|' + m.get('title', m['path']))
EOF
)

choice=""
if [[ -n "${1:-}" ]]; then
  choice="models/${1%/}/"
  [[ -f "$choice/scene.obj" ]] || { echo "No model folder viewer/$choice"; exit 1; }
elif command -v zenity >/dev/null && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  args=()
  for r in "${ROWS[@]}"; do args+=("${r%%|*}" "${r#*|}"); done
  choice=$(zenity --list --title="WoodModels viewer" --text="Which model?" --width=420 --height=300 \
    --column=path --column=Model --hide-column=1 --print-column=1 "${args[@]}") || exit 0
else
  echo "Which model?"
  for i in "${!ROWS[@]}"; do echo "  $((i + 1))) ${ROWS[$i]#*|}"; done
  read -rp "Number: " n
  choice="${ROWS[$((n - 1))]%%|*}"
fi

if ! running; then
  mkdir -p "$(dirname "$LOG")"
  # like python3 -m http.server, but telling the browser to check for newer
  # files every time, so an updated viewer or model shows up on a plain reload
  nohup python3 -c '
import http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
http.server.ThreadingHTTPServer(("", int(sys.argv[1])), H).serve_forever()
'  "$PORT" >"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  for _ in $(seq 50); do running && break; sleep 0.1; done
  running || { echo "The viewer didn't start - see $LOG"; exit 1; }
fi

xdg-open "${URL}?model=${choice}" >/dev/null 2>&1 &
echo "Viewer running at ${URL}?model=${choice}"

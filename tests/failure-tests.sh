#!/usr/bin/env bash
# Failure/recovery tests for the deployed bot. Run from your Mac:
#
#   bash tests/failure-tests.sh will@SERVER_IP            # all tests except reboot
#   bash tests/failure-tests.sh will@SERVER_IP --reboot   # also reboot the server
#   bash tests/failure-tests.sh will@SERVER_IP --quick    # skip network + reboot tests
#
# What it does to the live bot: kills it once (it restarts in ~10s) and, unless
# --quick, cuts its network for ~2.5 min. The AI tests run as separate one-off
# processes with deliberately broken settings, so the live bot isn't touched.
# Cost: a few cents of Vertex AI (paid fallback) per run.
set -uo pipefail

HOST=${1:?Usage: bash tests/failure-tests.sh user@server-ip [--reboot|--quick]}
MODE=${2:-}
APP=/opt/courseworks-bot
PASS=0
FAIL=0

pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); }
remote() { ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" "$@"; }

# Remote helper: wait until "Bot ready" is logged after a given timestamp.
WAIT_READY='wait_ready() { for _ in $(seq 1 "$2"); do sudo journalctl -u courseworks-bot -o cat --no-pager --since "$1" | grep -q "Bot ready" && return 0; sleep 1; done; return 1; }'

echo "== 0. Preflight"
if remote "systemctl is-active --quiet courseworks-bot"; then pass "bot service is running"; else fail "bot service is not running"; exit 1; fi

echo "== 1. Bot crash (kill -9) recovers without a QR scan"
out=$(remote "$WAIT_READY"'
  wait_ready "-5 min" 60 >/dev/null  # make sure it is up before killing
  PID=$(systemctl show -p MainPID --value courseworks-bot)
  [ "$PID" -gt 0 ] || { echo "no-pid"; exit 1; }
  K=$(date "+%Y-%m-%d %H:%M:%S"); sudo kill -9 "$PID"; S=$(date +%s)
  if wait_ready "$K" 90; then echo "recovered in $(( $(date +%s) - S ))s"; else echo "not-recovered"; fi
  sudo journalctl -u courseworks-bot -o cat --no-pager --since "$K" | grep -q "Scan this QR" && echo "asked-for-qr"')
echo "   $out" | head -2
if [[ $out == recovered* && $out != *asked-for-qr* ]]; then pass "restarted and reconnected"; else fail "did not recover cleanly ($out)"; fi

echo "== 2. Free Gemini key rejected → paid Vertex answers"
out=$(remote "cd $APP && sudo -u cwbot env GEMINI_API_KEY=invalid-key-for-test node --env-file=.env src/cli.js 'whats due tomorrow?' 2>&1")
code=$?
if [[ $code -eq 0 && $out == *"Free Gemini rejected"* && $out != *"Error:"*Unhandled* ]]; then pass "fell back to paid and answered"; else fail "no fallback (exit $code): $(echo "$out" | tail -2)"; fi

echo "== 3. Free and paid both down → 'overloaded' error, not silence"
out=$(remote "cd $APP && sudo -u cwbot env GEMINI_API_KEY=invalid-key-for-test VERTEX_PROJECT=nonexistent-project-xyz node --env-file=.env -e '
  import(\"./src/agent.js\").then(async ({ answerQuestion, OutOfQuotaError }) => {
    try { await answerQuestion(\"whats due tomorrow?\"); console.log(\"RESULT answered\"); }
    catch (e) { console.log(\"RESULT\", e instanceof OutOfQuotaError ? \"overloaded\" : \"other:\" + e.message); }
  });' 2>&1 | grep RESULT")
if [[ $out == "RESULT overloaded" ]]; then pass "raised OutOfQuotaError (bot replies 'overloaded')"; else fail "$out"; fi

echo "== 4. CourseWorks token rejected → warning logged, no crash"
out=$(remote "cd $APP && sudo -u cwbot env CANVAS_API_TOKEN=invalid-token node --env-file=.env src/cli.js 'whats due this week?' 2>&1")
code=$?
if [[ $code -eq 0 && $out == *"CourseWorks rejected the token"* ]]; then pass "warned about the token and still replied"; else fail "exit $code: $(echo "$out" | tail -2)"; fi

echo "== 5. Privacy: upcoming items never include personal planner notes"
out=$(remote "cd $APP && sudo -u cwbot node --env-file=.env -e '
  import(\"./src/tools.js\").then(async ({ toolsByName }) => {
    const out = await toolsByName.get_upcoming_items.run({ start_date: \"2026-01-01\", end_date: \"2027-12-31\" });
    const bad = out.split(\"\n\").filter((l) => /planner_note|\\[undefined\\]|\\[personal\\]/.test(l));
    console.log(\"RESULT\", bad.length);
  });' 2>&1 | grep RESULT")
if [[ $out == "RESULT 0" ]]; then pass "no personal items in output"; else fail "$out personal line(s) found"; fi

if [[ $MODE != "--quick" ]]; then
  echo "== 6. Network cut for ~150s → reconnect with backoff, no QR"
  out=$(remote "$WAIT_READY"'
    wait_ready "-5 min" 60 >/dev/null
    UIDN=$(id -u cwbot); K=$(date "+%Y-%m-%d %H:%M:%S")
    sudo iptables -I OUTPUT -m owner --uid-owner "$UIDN" -j DROP
    # Safety net: the rule removes itself even if this SSH session dies.
    sudo nohup sh -c "sleep 150; iptables -D OUTPUT -m owner --uid-owner $UIDN -j DROP" >/dev/null 2>&1 &
    while sudo iptables -C OUTPUT -m owner --uid-owner "$UIDN" -j DROP 2>/dev/null; do sleep 3; done
    R=$(date "+%Y-%m-%d %H:%M:%S"); S=$(date +%s)
    if wait_ready "$R" 120; then echo "reconnected ${S}"; echo "after $(( $(date +%s) - S ))s"; else echo "not-reconnected"; fi
    LOG=$(sudo journalctl -u courseworks-bot -o cat --no-pager --since "$K")
    echo "$LOG" | grep -q "reconnecting in 4s" && echo "backoff-ok"
    echo "$LOG" | grep -q "QR code expired\|Scan this QR" && echo "asked-for-qr"')
  echo "   $(echo "$out" | grep after)"
  if [[ $out == *reconnected* && $out == *backoff-ok* && $out != *asked-for-qr* ]]; then pass "reconnected with backoff"; else fail "$out"; fi
fi

if [[ $MODE == "--reboot" ]]; then
  echo "== 7. Server reboot → bot comes back by itself"
  T0=$(date +%s)
  remote 'nohup sudo sh -c "sleep 1; systemctl reboot" >/dev/null 2>&1 &'
  while remote true 2>/dev/null; do sleep 2; (( $(date +%s) - T0 > 120 )) && break; done
  until remote true 2>/dev/null; do sleep 3; (( $(date +%s) - T0 > 400 )) && break; done
  out=$(remote 'for _ in $(seq 1 120); do sudo journalctl -u courseworks-bot -b -o cat --no-pager | grep -q "Bot ready" && { echo up; exit; }; sleep 1; done; echo down')
  if [[ $out == up ]]; then pass "back after $(( $(date +%s) - T0 ))s"; else fail "bot not ready after reboot"; fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

#!/bin/zsh
# ios-live-resume-harness.sh: the host side of iOSClient/BABOnlineUITests/LiveForegroundResumeTests
# (the iOS foreground after the keep-alive, against a local server; never production).
#
#   scripts/ios-live-resume-harness.sh --port <port> --udid <simulator UDID> --db <db name> \
#       --mongo <mongodb://127.0.0.1:<port>> --ctl <dir> [--log <file>]
#
# Runs this checkout's server on 127.0.0.1:<port> (scripts/ios-live-resume-preload.js remaps
# the hard-coded port 3000 and 'babonline' database), then serves the live test's requests,
# files the test creates in <dir> (TEST_RUNNER_BAB_LIVE_CTL), until <dir>/stop exists:
#   suspend-app / resume-app       SIGSTOP / SIGCONT the BAB Online app process on <udid> only
#                                  (what iOS suspension does; a simulator's background task
#                                  outlives a device's, so the app is never suspended otherwise)
#   restart-request                kill and start the server again
#   freeze-server / thaw-server    SIGSTOP / SIGCONT the server (its connections stay open,
#                                  nothing answers: a link that died silently)
# Each writes <name>.done when done. The preload also writes <dir>/probe-snapshot.json
# (the answer to each foreground probe: requestId, stage, hand) for the mid-game test.
#
# Refuses port 3000, the babonline database, a MongoDB that is not 127.0.0.1 / localhost
# with a port and no credentials, and port 27017 (the default mongod: use a mongod of your
# own on a temp dbpath), and a new simulator. <dir> must be new, empty, or one this harness
# made (it leaves a .ios-live-resume-harness marker); it only ever removes its own request,
# .done, probe-snapshot.json and default server.log files there. The test account's password is never given to
# this script: export it for xcodebuild only (see LiveForegroundResumeTests).
set -u

PORT="" UDID="" DB="" MONGO="" CTL="" LOG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --udid) UDID="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --mongo) MONGO="$2"; shift 2 ;;
    --ctl) CTL="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
die() { echo "ios-live-resume-harness: $*" >&2; exit 2; }
[ -n "$PORT" ] && [ -n "$UDID" ] && [ -n "$DB" ] && [ -n "$MONGO" ] && [ -n "$CTL" ] \
  || die "--port, --udid, --db, --mongo and --ctl are required"
[[ "$PORT" == <1024-65535> ]] || die "--port must be a number from 1024"
[ "$PORT" -ne 3000 ] || die "port 3000 is the real server's: use another"
[ "${DB:l}" != "babonline" ] || die "the babonline database is the real one: use another"
# mongodb://127.0.0.1:<port> or mongodb://localhost:<port>, optionally /<db>[?options]:
# no credentials (no '@'), no second host (no ',')
[[ "$MONGO" =~ '^mongodb://(127\.0\.0\.1|localhost):([0-9]+)(/[^@,]*)?$' ]] \
  || die "--mongo must be a local mongodb://127.0.0.1:<port> (no credentials, one host)"
MONGO_PORT=$(( 10#${match[2]} ))
[ "$MONGO_PORT" -ne 27017 ] || die "--mongo port 27017 is the default mongod's: run your own on another port"
xcrun simctl list devices | grep -q "($UDID)" || die "no simulator $UDID"

ROOT="${0:A:h:h}"
PRELOAD="$ROOT/scripts/ios-live-resume-preload.js"
# The CTL dir: new, empty, or made by this harness (its marker); never anyone else's files.
MARKER=".ios-live-resume-harness"
REQUESTS=(suspend-app resume-app restart-request freeze-server thaw-server)
OWN_FILES=(stop probe-snapshot.json server.log $REQUESTS ${^REQUESTS}.done)
if [ -e "$CTL" ]; then
  [ -d "$CTL" ] || die "--ctl $CTL is not a directory"
  if [ ! -f "$CTL/$MARKER" ]; then
    existing=("$CTL"/*(DN))
    [ ${#existing} -eq 0 ] || die "--ctl $CTL is not empty and was not made by this harness: use a new directory"
  fi
else
  mkdir -p "$CTL" || die "cannot create $CTL"
fi
CTL="${CTL:A}"
touch "$CTL/$MARKER" || die "cannot write to $CTL"
for f in $OWN_FILES; do rm -f "$CTL/$f"; done
[ -n "$LOG" ] || LOG="$CTL/server.log"
LOG="${LOG:A}"

log() { echo "[harness] $(date -u +%H:%M:%S) $*" >> "$LOG"; }
PID=""
start_server() {
  ( cd "$ROOT" && NODE_ENV=production AMBIENT_BOTS=false BAB_LIVE_PORT="$PORT" BAB_LIVE_DB="$DB" \
      BAB_LIVE_CTL="$CTL" MONGO_URI="$MONGO" exec node -r "$PRELOAD" server/index.js >> "$LOG" 2>&1 ) &
  PID=$!
  local i
  for i in {1..60}; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/socket.io/?EIO=4&transport=polling")" = 200 ] && break
    sleep 0.5
  done
  log "server up pid=$PID port=$PORT db=$DB"
}
stop_server() { kill -CONT "$PID" 2>/dev/null; kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }
app_pid() { pgrep -f "Devices/$UDID/data/Containers/Bundle/Application/.*/BAB Online.app/BAB Online" | head -1; }
trap 'stop_server; log "stopped"; exit 0' INT TERM

start_server
echo "harness: server on http://127.0.0.1:$PORT (db $DB), CTL $CTL, log $LOG; touch $CTL/stop to end"
while [ ! -f "$CTL/stop" ]; do
  if [ -f "$CTL/restart-request" ]; then
    rm -f "$CTL/restart-request"
    log "restart: killing server pid=$PID"
    stop_server; start_server
    touch "$CTL/restart-request.done"
  fi
  if [ -f "$CTL/suspend-app" ]; then
    rm -f "$CTL/suspend-app"; A=$(app_pid)
    [ -n "$A" ] && kill -STOP "$A" && log "app pid=$A SIGSTOP (suspended)"
    touch "$CTL/suspend-app.done"
  fi
  if [ -f "$CTL/resume-app" ]; then
    rm -f "$CTL/resume-app"; A=$(app_pid)
    [ -n "$A" ] && kill -CONT "$A" && log "app pid=$A SIGCONT (resumed)"
    touch "$CTL/resume-app.done"
  fi
  if [ -f "$CTL/freeze-server" ]; then
    rm -f "$CTL/freeze-server"; kill -STOP "$PID" && log "server pid=$PID SIGSTOP (frozen)"
    touch "$CTL/freeze-server.done"
  fi
  if [ -f "$CTL/thaw-server" ]; then
    rm -f "$CTL/thaw-server"; kill -CONT "$PID" && log "server pid=$PID SIGCONT (thawed)"
    touch "$CTL/thaw-server.done"
  fi
  sleep 0.2
done
stop_server
log "stopped"

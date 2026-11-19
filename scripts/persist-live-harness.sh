#!/bin/zsh
# persist-live-harness.sh: deploys, crashes and Mongo outages on a local copy of production, for
# the deploy-survival live verification (the plan's section 5; docs/claude/server-infra.md
# "Live game persistence", Live harness). Never production.
#
#   scripts/persist-live-harness.sh --proxy <port> --ports <a,b> --db <name> \
#       --mongo mongodb://127.0.0.1:<28000-28999> --ctl <dir> [--mode on|write|off] [--log <file>]
#   scripts/persist-live-harness.sh --ctl <dir> --do <verb> [key=value ...]   (send a verb, wait)
#   scripts/persist-live-harness.sh --selftest --proxy ... --ports ... --db ... --mongo ... --ctl <dir>
#
# Runs, all on 127.0.0.1:
#   - its own mongod on the --mongo port (dbpath <dir>/mongod-data, --bind_ip 127.0.0.1);
#   - scripts/persist-live-proxy.js on --proxy: Railway's router (HTTP to the active instance,
#     websocket upgrades pinned to theirs);
#   - instances of this checkout's server, one per --ports port as deploys need them:
#     NODE_ENV=production LIVE_PERSIST=<mode> AMBIENT_BOTS=false node -r scripts/persist-live-preload.js
#     server/index.js (the preload maps the hard-coded port 3000 to the instance's port and the
#     'babonline' database to --db; DB_NAME and MONGO_URI are set too), each with a
#     RAILWAY_DEPLOYMENT_ID; logs in <dir>/instance-<port>.log ([persistlog] lines: the store's
#     Mongo ops, never a hand or chat).
# A crashed instance (any exit but 0, SIGKILL included) is restarted on a free port with the SAME
# deployment id, as Railway's ON_FAILURE policy does; an exit 0 (a SIGTERM) is not.
#
# Verbs: write a file <dir>/<verb> (its content: key=value arguments), or use --do. Each answers
# <dir>/<verb>.done ("ok ..." or "error ..."):
#   deploy [overlap=3] [mode=<mode>]   a new deployment (new RAILWAY_DEPLOYMENT_ID) on the free
#                                      port; once its /ready answers 200 (120 s, Railway's
#                                      healthcheck) the proxy switches to it, `overlap` seconds
#                                      later the old one gets SIGTERM, and SIGKILL if it is still up
#                                      20 s after (drainingSeconds). Done when the old one exited
#   kill [same=1|0] [restart=1|0] [port=<p>]  SIGKILL the active instance (or <p>); restart (default)
#                                      starts a replacement with the same (default) or a new
#                                      deployment id. Done when the replacement is routed
#   throw [port=<p>]                   an uncaught exception in it (the crash path, exit 1); the
#                                      ON_FAILURE restart follows. Done when the replacement is routed
#   arm <trigger> [delay=<ms>] [port=<p>]  kill-after-card-2 | kill-after-gameEnd-fire | throw-now
#                                      (scripts/persist-live-preload.js); the ON_FAILURE restart follows
#   freeze / thaw [port=<p>]           SIGSTOP / SIGCONT the instance (a process that stopped
#                                      answering and beating, but keeps its sockets)
#   sigterm-only [port=<p>]            SIGTERM with no successor. Done when it exited
#   start [mode=<mode>] [same=0|1]     start an instance (new deployment id unless same=1) and route
#                                      to it (after sigterm-only, or with nothing running)
#   mongo-stop / mongo-start           stop (clean shutdown: connections refused) / start mongod
#   mongo-freeze / mongo-thaw          SIGSTOP / SIGCONT mongod (a stall: operations time out)
#   proxy-drop                         the proxy cuts every open websocket (a network blip; the
#                                      instances are untouched and the clients reconnect)
#   status                             instances, ports, modes, deployment ids, the routed one
#   stop                               stop everything (instances SIGTERM, then SIGKILL after 20 s;
#                                      the proxy; mongod) and exit. Data stays in <dir>/mongod-data
#
# --selftest: boots everything in write mode, plays one game (scripts/persist-live-probe.js: a
# player and a spectator at a table of 3 bots, --expect end), deploys mid-game, checks today's
# behaviour (the "interrupted" line, the old instance exits 0 and deletes its docs, the clients
# reconnect through the proxy to the new instance and find the game gone, no hand in any log),
# then tears everything down (its mongod data included). Exit 0 when every check passed.
#
# Refuses: port 3000 (the real server's) and 27017 (the default mongod) anywhere; the babonline
# database; a --mongo that is not mongodb://127.0.0.1|localhost:<28000-28999>[/db] with no
# credentials and one host; a port something already listens on; a <dir> that is not new, empty
# or one this harness made (its .persist-live-harness marker). Passwords never pass through
# here: the probe makes throwaway accounts with random passwords it keeps in memory.
set -u
zmodload zsh/datetime

ROOT="${0:A:h:h}"
SELF="${0:A}"
PROXY="" PORTS_ARG="" DB="" MONGO="" CTL="" MODE="on" LOG="" SELFTEST=0 DO=""
DO_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --proxy) PROXY="$2"; shift 2 ;;
    --ports) PORTS_ARG="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --mongo) MONGO="$2"; shift 2 ;;
    --ctl) CTL="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --selftest) SELFTEST=1; shift ;;
    --do) DO="$2"; shift 2; DO_ARGS=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
die() { echo "persist-live-harness: $*" >&2; exit 2; }
[ -n "$CTL" ] || die "--ctl <dir> is required"

VERBS=(deploy kill throw arm freeze thaw sigterm-only start mongo-stop mongo-start mongo-freeze mongo-thaw proxy-drop status stop)

# ---------- --do: send one verb to a running harness and wait for its answer ----------
if [ -n "$DO" ]; then
  (( ${VERBS[(Ie)$DO]} )) || die "unknown verb $DO (one of: $VERBS)"
  [ -f "$CTL/.persist-live-harness" ] || die "$CTL is not a running harness's directory"
  rm -f "$CTL/$DO.done"
  print -r -- "${DO_ARGS[*]}" > "$CTL/$DO.tmp" && mv "$CTL/$DO.tmp" "$CTL/$DO"
  WAIT_S=${PERSIST_LIVE_WAIT:-240}
  for i in {1..$(( WAIT_S * 5 ))}; do
    if [ -f "$CTL/$DO.done" ]; then
      cat "$CTL/$DO.done"
      head -c 2 "$CTL/$DO.done" | grep -q ok && exit 0 || exit 1
    fi
    sleep 0.2
  done
  echo "error: no answer to $DO within $WAIT_S s" >&2
  exit 1
fi

# ---------- refusals ----------
[ -n "$PROXY" ] && [ -n "$PORTS_ARG" ] && [ -n "$DB" ] && [ -n "$MONGO" ] \
  || die "--proxy, --ports, --db, --mongo and --ctl are required"
[[ "$MODE" == (on|write|off) ]] || die "--mode must be on, write or off"
PORTS=(${(s:,:)PORTS_ARG})
[ ${#PORTS} -ge 2 ] || die "--ports needs at least two ports (a deploy runs two instances at once)"
check_port() {
  [[ "$1" == <1024-65535> ]] || die "$2 $1 must be a port number from 1024"
  [ "$1" -ne 3000 ] || die "$2 3000 is the real server's: use another"
  [ "$1" -ne 27017 ] || die "$2 27017 is the default mongod's: use another"
}
check_port "$PROXY" --proxy
for p in $PORTS; do check_port "$p" --ports; done
[ "${DB:l}" != "babonline" ] || die "the babonline database is the real one: use another"
[[ "$DB" =~ '^[A-Za-z0-9_-]{1,60}$' ]] || die "--db must be a plain database name"
# mongodb://127.0.0.1:<port> or mongodb://localhost:<port>, optionally /<db>: no credentials
# (no '@'), no second host (no ','), no options
[[ "$MONGO" =~ '^mongodb://(127\.0\.0\.1|localhost):([0-9]+)(/[A-Za-z0-9_-]*)?$' ]] \
  || die "--mongo must be a local mongodb://127.0.0.1:<port> (no credentials, one host, no options)"
MONGO_PORT=$(( 10#${match[2]} ))
[ "$MONGO_PORT" -ne 27017 ] || die "--mongo port 27017 is the default mongod's: this harness runs its own on 28000-28999"
[ "$MONGO_PORT" -ge 28000 ] && [ "$MONGO_PORT" -le 28999 ] || die "--mongo port must be in 28000-28999 (the harness's own mongod)"
ALL=($PROXY $PORTS $MONGO_PORT)
[ ${#${(u)ALL}} -eq ${#ALL} ] || die "--proxy, --ports and the --mongo port must all differ"
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

MARKER=".persist-live-harness"
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

# ======================================================================
# --selftest: drive a harness (this script, in the background) through one deploy
# ======================================================================
if [ "$SELFTEST" -eq 1 ]; then
  for p in $ALL; do listening "$p" && die "port $p is in use: the self-test needs it free"; done
  touch "$CTL/$MARKER"
  ST_LOG="$CTL/selftest.log"
  : > "$ST_LOG"
  slog() { echo "[selftest] $(date -u +%H:%M:%S) $*" | tee -a "$ST_LOG"; }
  FAILS=()
  check() { if eval "$2"; then slog "PASS $1"; else slog "FAIL $1"; FAILS+=("$1"); fi; }
  counts() {
    ( cd "$ROOT" && node -e '
      const { MongoClient } = require("mongodb");
      (async () => {
        const c = new MongoClient(process.argv[1], { serverSelectionTimeoutMS: 3000 });
        await c.connect();
        const d = c.db(process.argv[2]);
        const out = {};
        for (const n of ["liveGames", "liveTournaments", "serverInstances", "gameRecords"]) out[n] = await d.collection(n).countDocuments();
        console.log(JSON.stringify(out));
        await c.close();
      })().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
    ' "$MONGO" "$DB" )
  }
  jget() { node -e 'const o=JSON.parse(process.argv[1]); console.log(o[process.argv[2]] ?? "")' "$1" "$2"; }

  slog "booting the harness in write mode (proxy $PROXY, ports $PORTS_ARG, mongod $MONGO_PORT, db $DB)"
  "$SELF" --proxy "$PROXY" --ports "$PORTS_ARG" --db "$DB" --mongo "$MONGO" --ctl "$CTL" --mode write > "$CTL/harness.out" 2>&1 &
  HPID=$!
  teardown_selftest() {
    touch "$CTL/stop"
    for i in {1..200}; do kill -0 $HPID 2>/dev/null || break; sleep 0.2; done
    kill -0 $HPID 2>/dev/null && { slog "harness did not stop; killing it"; kill $HPID; }
  }
  ok_ready=0
  for i in {1..750}; do
    [ -f "$CTL/ready" ] && { ok_ready=1; break; }
    kill -0 $HPID 2>/dev/null || break
    sleep 0.2
  done
  if [ $ok_ready -ne 1 ]; then
    slog "FAIL the harness never got ready (see $CTL/harness.log)"
    teardown_selftest
    exit 1
  fi
  OLD_PORT=$(sed -n 's/.*instance=\([0-9]*\).*/\1/p' "$CTL/ready")
  slog "ready: $(cat "$CTL/ready")"

  node "$ROOT/scripts/persist-live-probe.js" --url "http://127.0.0.1:$PROXY" --role player --expect end \
    --ctl "$CTL" --signal-after-cards 6 --max-seconds 300 > "$CTL/probe-player.log" 2>&1 &
  PPID_PLAYER=$!
  node "$ROOT/scripts/persist-live-probe.js" --url "http://127.0.0.1:$PROXY" --role spectator --expect end \
    --ctl "$CTL" --max-seconds 300 > "$CTL/probe-spectator.log" 2>&1 &
  PPID_SPECTATOR=$!

  got_cards=0
  for i in {1..1200}; do
    [ -f "$CTL/probe-player.cards" ] && { got_cards=1; break; }
    kill -0 $PPID_PLAYER 2>/dev/null || break
    sleep 0.2
  done
  check "the game reached 6 cards played (a dealt hand)" '[ $got_cards -eq 1 ]'
  BEFORE=$(counts)
  slog "collections mid-game: $BEFORE"
  check "write mode saved the game while it ran (liveGames >= 1)" '[ "$(jget "$BEFORE" liveGames)" -ge 1 ] 2>/dev/null'

  slog "deploy overlap=2 mode=write"
  DEPLOY_OUT=$("$SELF" --ctl "$CTL" --do deploy overlap=2 mode=write)
  slog "deploy: $DEPLOY_OUT"
  check "the deploy completed and the old instance exited 0" '[[ "$DEPLOY_OUT" == ok* && "$DEPLOY_OUT" == *"exit=0"* ]]'
  NEW_PORT=$(print -r -- "$DEPLOY_OUT" | sed -n 's/.*new=\([0-9]*\).*/\1/p')

  for pid in $PPID_PLAYER $PPID_SPECTATOR; do
    for i in {1..600}; do kill -0 $pid 2>/dev/null || break; sleep 0.2; done
  done
  passed() { [ "$(node -e 'try { console.log(require(process.argv[1]).pass === true) } catch { console.log(false) }' "$1" 2>/dev/null)" = true ]; }
  slog "player probe: $(tail -1 "$CTL/probe-player.log" | cut -c1-400)"
  slog "spectator probe: $(tail -1 "$CTL/probe-spectator.log" | cut -c1-400)"
  check "the player probe passed (notice, serverShutdown, reconnect, game gone)" 'passed "$CTL/probe-player.result.json"'
  check "the spectator probe passed (notice, serverShutdown, re-spectate refused)" 'passed "$CTL/probe-spectator.result.json"'
  sleep 1
  AFTER=$(counts)
  slog "collections after the deploy: $AFTER"
  check "no live game doc left (the old instance deleted its own)" '[ "$(jget "$AFTER" liveGames)" = 0 ]'
  check "no game record (the game never ended)" '[ "$(jget "$AFTER" gameRecords)" = 0 ]'
  OLD_LOG="$CTL/instance-$OLD_PORT.log"
  NEW_LOG="$CTL/instance-$NEW_PORT.log"
  check "[persistlog] shows the game inserted on the old instance" 'grep -q "op=insertOne coll=liveGames .*outcome=inserted" "$OLD_LOG"'
  check "[persistlog] shows the SIGTERM, the write-mode delete and exit 0" \
    'grep -q "signal=SIGTERM" "$OLD_LOG" && grep -q "op=deleteMany coll=liveGames id=owner outcome=deleted=" "$OLD_LOG" && grep -q "exit=0" "$OLD_LOG"'
  check "the clients reached the new instance through the proxy (restoreSession, rejoinGame there)" \
    '[ -n "$NEW_PORT" ] && grep -q "IN .*restoreSession" "$NEW_LOG" && grep -q "IN .*rejoinGame" "$NEW_LOG"'
  check "the proxy switched its HTTP target" 'grep -q "HTTP target $OLD_PORT -> $NEW_PORT" "$CTL/proxy.log"'
  check "no hand in any harness line ([keeplog] / [persistlog])" '! grep -hE "^\[(keeplog|persistlog)\].*(hand\([0-9]+\)=\[|\"suit\")" "$CTL"/instance-*.log'
  if grep -qE '"suit"|of (hearts|spades|clubs|diamonds)' "$CTL"/instance-*.log; then
    slog "WARN card text in a server log line (not the harness's own): $(grep -cE '"suit"|of (hearts|spades|clubs|diamonds)' "$CTL"/instance-*.log | tr '\n' ' ')"
  fi

  teardown_selftest
  sleep 0.5
  check "everything stopped (proxy, instances, mongod ports free)" '! listening $PROXY && ! listening ${PORTS[1]} && ! listening ${PORTS[2]} && ! listening $MONGO_PORT'
  rm -rf "$CTL/mongod-data"
  check "the self-test's mongod data is gone" '[ ! -e "$CTL/mongod-data" ]'
  if [ ${#FAILS} -eq 0 ]; then
    slog "SELFTEST PASS (logs in $CTL)"
    exit 0
  fi
  slog "SELFTEST FAIL: ${(j:; :)FAILS} (logs in $CTL)"
  exit 1
fi

# ======================================================================
# The harness
# ======================================================================
for p in $ALL; do listening "$p" && die "port $p is in use: the harness runs its own proxy, instances and mongod"; done
touch "$CTL/$MARKER" || die "cannot write to $CTL"
for v in $VERBS; do rm -f "$CTL/$v" "$CTL/$v.done" "$CTL/$v.tmp"; done
rm -f "$CTL/ready" "$CTL/proxy-target" "$CTL/proxy-target.ack" "$CTL/proxy-cut" "$CTL/proxy-cut.ack" "$CTL"/inst-*.pid(N) "$CTL"/inst-*.exit(N) "$CTL"/arm-*(N)
[ -n "$LOG" ] || LOG="$CTL/harness.log"
LOG="${LOG:A}"
MONGOD_BIN="${MONGOD_BIN:-$(command -v mongod || echo /opt/homebrew/bin/mongod)}"
[ -x "$MONGOD_BIN" ] || die "no mongod (set MONGOD_BIN)"

log() { echo "[harness] $(date -u +%H:%M:%S) $*" >> "$LOG"; }
now_ms() { integer ms=$(( EPOCHREALTIME * 1000 )); echo $ms; }
done_verb() { print -r -- "$2" > "$CTL/$1.done"; log "$1: $2"; }
new_dep() { uuidgen | tr 'A-Z' 'a-z'; }

# ---------- mongod ----------
MONGOD_PID=""
start_mongod() {
  mkdir -p "$CTL/mongod-data"
  "$MONGOD_BIN" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --dbpath "$CTL/mongod-data" >> "$CTL/mongod.log" 2>&1 &
  MONGOD_PID=$!
  local i
  for i in {1..100}; do listening "$MONGO_PORT" && { log "mongod up pid=$MONGOD_PID port=$MONGO_PORT"; return 0; }; sleep 0.2; done
  log "mongod did not start (see $CTL/mongod.log)"
  return 1
}
stop_mongod() {
  [ -n "$MONGOD_PID" ] || return 0
  kill -CONT "$MONGOD_PID" 2>/dev/null
  kill -TERM "$MONGOD_PID" 2>/dev/null
  local i
  for i in {1..75}; do kill -0 "$MONGOD_PID" 2>/dev/null || break; sleep 0.2; done
  kill -0 "$MONGOD_PID" 2>/dev/null && kill -KILL "$MONGOD_PID" 2>/dev/null
  log "mongod stopped"
  MONGOD_PID=""
}

# ---------- the proxy ----------
PROXY_PID=""
start_proxy() {
  node "$ROOT/scripts/persist-live-proxy.js" --listen "$PROXY" --ctl "$CTL" >> "$CTL/proxy.log" 2>&1 &
  PROXY_PID=$!
  local i
  for i in {1..50}; do listening "$PROXY" && return 0; sleep 0.2; done
  return 1
}
ROUTED=""
route_to() {
  print -r -- "$1" > "$CTL/proxy-target.tmp" && mv "$CTL/proxy-target.tmp" "$CTL/proxy-target"
  local i
  for i in {1..20}; do [ "$(cat "$CTL/proxy-target.ack" 2>/dev/null)" = "$1" ] && break; sleep 0.1; done
  log "proxy -> $1 (was ${ROUTED:--})"
  ROUTED="$1"
}

# ---------- instances ----------
typeset -A I_PID I_MODE I_DEP I_STATE I_EXPECT I_T0
start_instance() { # port mode deploymentId
  local port=$1 mode=$2 dep=$3
  rm -f "$CTL/inst-$port.pid" "$CTL/inst-$port.exit" "$CTL/arm-$port" "$CTL/arm-$port.fired"
  # The exit code comes from a /bin/sh wait: zsh's wait reports 128+SIGSTOP for a child that
  # was ever stopped (freeze), even when it later exits on its own
  ( cd "$ROOT" && NODE_ENV=production LIVE_PERSIST="$mode" AMBIENT_BOTS=false \
      BAB_LIVE_PORT="$port" BAB_LIVE_DB="$DB" DB_NAME="$DB" MONGO_URI="$MONGO" \
      RAILWAY_DEPLOYMENT_ID="$dep" BAB_PERSIST_CTL="$CTL" BAB_PERSIST_TAG="$port" \
      /bin/sh -c 'node -r "$1" server/index.js >> "$2" 2>&1 & echo $! > "$3"; wait $!; echo $? > "$4"' \
        sh "$ROOT/scripts/persist-live-preload.js" "$CTL/instance-$port.log" "$CTL/inst-$port.pid" "$CTL/inst-$port.exit" \
        2>> "$CTL/instance-$port.log" ) &
  local i
  for i in {1..50}; do [ -s "$CTL/inst-$port.pid" ] && break; sleep 0.05; done
  I_PID[$port]=$(cat "$CTL/inst-$port.pid" 2>/dev/null)
  I_MODE[$port]=$mode; I_DEP[$port]=$dep; I_STATE[$port]=booting; I_EXPECT[$port]=""; I_T0[$port]=$(now_ms)
  log "instance $port starting pid=${I_PID[$port]} mode=$mode deployment=${dep[1,8]}"
}
alive() { [ "${I_STATE[$1]:-none}" != none ] && [ "${I_STATE[$1]}" != exited ]; }
ready() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$1/ready")" = 200 ]; }
free_port() {
  local p
  for p in $PORTS; do
    alive "$p" && continue
    listening "$p" && continue
    echo "$p"; return 0
  done
  return 1
}
target_port() { # port=<p> from the arguments, else the routed instance
  local a
  for a in "$@"; do [[ "$a" == port=* ]] && { echo "${a#port=}"; return; }; done
  echo "$ROUTED"
}
argval() { # key default args...
  local key=$1 def=$2 a; shift 2
  for a in "$@"; do [[ "$a" == $key=* ]] && { echo "${a#$key=}"; return; }; done
  echo "$def"
}

# A replacement / new instance waiting for /ready, then routed; its verb answered then
PENDING_ROUTE="" PENDING_VERB="" PENDING_T0=0
ONFAIL_RESTARTS=0
# The deploy in progress
DEP_PHASE=idle DEP_NEW="" DEP_OLD="" DEP_OVERLAP=3 DEP_T=0 DEP_TERM_T=0
# A sigterm-only in progress
TERM_PORT="" TERM_T=0

reap() {
  local p code
  for p in ${(k)I_STATE}; do
    [ "${I_STATE[$p]}" = exited ] && continue
    [ -f "$CTL/inst-$p.exit" ] || continue
    code=$(cat "$CTL/inst-$p.exit")
    I_STATE[$p]=exited
    log "instance $p exited code=$code after $(( ($(now_ms) - ${I_T0[$p]}) / 1000 )) s (expected: ${I_EXPECT[$p]:-no})"
    # ON_FAILURE: a crash of the active instance is restarted with the same deployment id
    if [ "$code" -ne 0 ] && [ "$p" = "$ROUTED" ] && [ -z "${I_EXPECT[$p]}" ]; then
      if [ $ONFAIL_RESTARTS -ge 10 ]; then
        log "ON_FAILURE: 10 restarts used, not restarting"
        continue
      fi
      ONFAIL_RESTARTS=$(( ONFAIL_RESTARTS + 1 ))
      local np
      np=$(free_port) || { log "ON_FAILURE: no free port"; continue; }
      log "ON_FAILURE restart $ONFAIL_RESTARTS: $p (code $code) -> $np, same deployment"
      start_instance "$np" "${I_MODE[$p]}" "${I_DEP[$p]}"
      PENDING_ROUTE=$np; PENDING_T0=$(now_ms)
      [ -n "$PENDING_VERB" ] || PENDING_VERB=onfailure
    fi
  done
}

tick_pending() {
  [ -n "$PENDING_ROUTE" ] || return
  if ! alive "$PENDING_ROUTE"; then
    [ "$PENDING_VERB" != onfailure ] && done_verb "$PENDING_VERB" "error instance $PENDING_ROUTE exited before /ready"
    PENDING_ROUTE="" PENDING_VERB=""
    return
  fi
  if ready "$PENDING_ROUTE"; then
    I_STATE[$PENDING_ROUTE]=ready
    route_to "$PENDING_ROUTE"
    local msg="ok routed=$PENDING_ROUTE deployment=${I_DEP[$PENDING_ROUTE][1,8]} ready_ms=$(( $(now_ms) - PENDING_T0 ))"
    if [ "$PENDING_VERB" = onfailure ]; then log "restart routed: $msg"; else done_verb "$PENDING_VERB" "$msg"; fi
    PENDING_ROUTE="" PENDING_VERB=""
  elif [ $(( $(now_ms) - PENDING_T0 )) -gt 120000 ]; then
    [ "$PENDING_VERB" != onfailure ] && done_verb "$PENDING_VERB" "error instance $PENDING_ROUTE never answered /ready in 120 s"
    PENDING_ROUTE="" PENDING_VERB=""
  fi
}

tick_deploy() {
  case $DEP_PHASE in
    idle) return ;;
    booting)
      if ! alive "$DEP_NEW"; then
        done_verb deploy "error new instance $DEP_NEW exited before /ready (the old one keeps serving)"
        DEP_PHASE=idle; return
      fi
      if ready "$DEP_NEW"; then
        I_STATE[$DEP_NEW]=ready
        route_to "$DEP_NEW"
        log "deploy: $DEP_NEW ready after $(( $(now_ms) - DEP_T )) ms; SIGTERM to ${DEP_OLD:--} in $DEP_OVERLAP s"
        DEP_PHASE=overlap; DEP_T=$(now_ms)
      elif [ $(( $(now_ms) - DEP_T )) -gt 120000 ]; then
        kill -KILL "${I_PID[$DEP_NEW]}" 2>/dev/null; I_EXPECT[$DEP_NEW]=kill
        done_verb deploy "error healthcheck: $DEP_NEW never answered /ready in 120 s (the old one keeps serving)"
        DEP_PHASE=idle
      fi ;;
    overlap)
      [ $(( $(now_ms) - DEP_T )) -ge $(( DEP_OVERLAP * 1000 )) ] || return
      if [ -z "$DEP_OLD" ] || ! alive "$DEP_OLD"; then
        done_verb deploy "ok new=$DEP_NEW old=none"
        DEP_PHASE=idle; return
      fi
      I_EXPECT[$DEP_OLD]=term
      kill -CONT "${I_PID[$DEP_OLD]}" 2>/dev/null
      kill -TERM "${I_PID[$DEP_OLD]}" 2>/dev/null
      log "deploy: SIGTERM to $DEP_OLD"
      DEP_PHASE=draining; DEP_TERM_T=$(now_ms) ;;
    draining)
      if ! alive "$DEP_OLD"; then
        done_verb deploy "ok new=$DEP_NEW old=$DEP_OLD exit=$(cat "$CTL/inst-$DEP_OLD.exit") drain_ms=$(( $(now_ms) - DEP_TERM_T )) deployment=${I_DEP[$DEP_NEW][1,8]}"
        DEP_PHASE=idle
      elif [ $(( $(now_ms) - DEP_TERM_T )) -gt 20000 ] && [ "${I_EXPECT[$DEP_OLD]}" = term ]; then
        log "deploy: $DEP_OLD still up 20 s after SIGTERM (drainingSeconds): SIGKILL"
        I_EXPECT[$DEP_OLD]=kill
        kill -KILL "${I_PID[$DEP_OLD]}" 2>/dev/null
      fi ;;
  esac
}

tick_term() {
  [ -n "$TERM_PORT" ] || return
  if ! alive "$TERM_PORT"; then
    done_verb sigterm-only "ok port=$TERM_PORT exit=$(cat "$CTL/inst-$TERM_PORT.exit") drain_ms=$(( $(now_ms) - TERM_T )) (no successor)"
    TERM_PORT=""
  elif [ $(( $(now_ms) - TERM_T )) -gt 20000 ] && [ "${I_EXPECT[$TERM_PORT]}" = term ]; then
    log "sigterm-only: $TERM_PORT still up after 20 s (drainingSeconds): SIGKILL"
    I_EXPECT[$TERM_PORT]=kill
    kill -KILL "${I_PID[$TERM_PORT]}" 2>/dev/null
  fi
}

status_text() {
  local p out="routed=${ROUTED:--} deploy=$DEP_PHASE mongod=$([ -n "$MONGOD_PID" ] && echo up || echo down)"
  for p in ${(k)I_STATE}; do
    out+=" | $p ${I_STATE[$p]} mode=${I_MODE[$p]} deployment=${I_DEP[$p][1,8]} pid=${I_PID[$p]}"
    [ "${I_STATE[$p]}" = exited ] && out+=" exit=$(cat "$CTL/inst-$p.exit" 2>/dev/null)"
  done
  print -r -- "$out"
}

handle() { # verb args...
  local verb=$1; shift
  local p np
  case $verb in
    deploy)
      [ "$DEP_PHASE" = idle ] || { done_verb deploy "error a deploy is already in progress"; return; }
      np=$(free_port) || { done_verb deploy "error no free port in $PORTS_ARG"; return; }
      DEP_OVERLAP=$(argval overlap 3 "$@")
      [[ "$DEP_OVERLAP" == <0-600> ]] || { done_verb deploy "error overlap must be 0-600 seconds"; return; }
      local mode=$(argval mode "${I_MODE[$ROUTED]:-$MODE}" "$@")
      [[ "$mode" == (on|write|off) ]] || { done_verb deploy "error mode must be on, write or off"; return; }
      DEP_OLD=$ROUTED; DEP_NEW=$np; DEP_T=$(now_ms)
      alive "$DEP_OLD" || DEP_OLD=""
      start_instance "$np" "$mode" "$(new_dep)"
      DEP_PHASE=booting ;;
    start)
      np=$(free_port) || { done_verb start "error no free port in $PORTS_ARG"; return; }
      local mode=$(argval mode "${I_MODE[$ROUTED]:-$MODE}" "$@") dep
      if [ "$(argval same 0 "$@")" = 1 ] && [ -n "$ROUTED" ]; then dep=${I_DEP[$ROUTED]}; else dep=$(new_dep); fi
      start_instance "$np" "$mode" "$dep"
      PENDING_ROUTE=$np; PENDING_VERB=start; PENDING_T0=$(now_ms) ;;
    kill)
      p=$(target_port "$@")
      alive "$p" || { done_verb kill "error no live instance on ${p:--}"; return; }
      I_EXPECT[$p]=kill
      kill -KILL "${I_PID[$p]}" 2>/dev/null
      log "SIGKILL $p"
      local i; for i in {1..50}; do [ -f "$CTL/inst-$p.exit" ] && break; sleep 0.05; done
      reap
      if [ "$(argval restart 1 "$@")" = 1 ]; then
        np=$(free_port) || { done_verb kill "error killed $p; no free port for the replacement"; return; }
        local dep=${I_DEP[$p]}
        [ "$(argval same 1 "$@")" = 1 ] || dep=$(new_dep)
        start_instance "$np" "${I_MODE[$p]}" "$dep"
        PENDING_ROUTE=$np; PENDING_VERB=kill; PENDING_T0=$(now_ms)
      else
        done_verb kill "ok killed $p (no restart)"
      fi ;;
    throw|arm)
      p=$(target_port "$@")
      alive "$p" || { done_verb $verb "error no live instance on ${p:--}"; return; }
      local trig="throw-now" opts=()
      if [ $verb = arm ]; then
        trig=${1:-}; shift
        [[ "$trig" == (kill-after-card-2|kill-after-gameEnd-fire|throw-now) ]] || { done_verb arm "error unknown trigger ${trig:--}"; return; }
        local d=$(argval delay "" "$@"); [ -n "$d" ] && opts=("delay=$d")
      fi
      print -r -- "$trig ${opts[*]}" > "$CTL/arm-$p.tmp" && mv "$CTL/arm-$p.tmp" "$CTL/arm-$p"
      if [ $verb = throw ]; then
        PENDING_VERB=throw   # answered when the ON_FAILURE restart is routed
      else
        done_verb arm "ok armed $trig on $p (the ON_FAILURE restart follows its death)"
      fi ;;
    freeze|thaw)
      p=$(target_port "$@")
      alive "$p" || { done_verb $verb "error no live instance on ${p:--}"; return; }
      if [ $verb = freeze ]; then kill -STOP "${I_PID[$p]}"; else kill -CONT "${I_PID[$p]}"; fi
      done_verb $verb "ok $verb $p" ;;
    sigterm-only)
      p=$(target_port "$@")
      alive "$p" || { done_verb sigterm-only "error no live instance on ${p:--}"; return; }
      I_EXPECT[$p]=term; TERM_PORT=$p; TERM_T=$(now_ms)
      kill -CONT "${I_PID[$p]}" 2>/dev/null
      kill -TERM "${I_PID[$p]}" ;;
    mongo-stop) stop_mongod; done_verb mongo-stop "ok mongod stopped" ;;
    mongo-start)
      [ -z "$MONGOD_PID" ] || { done_verb mongo-start "error mongod is already running"; return; }
      if start_mongod; then done_verb mongo-start "ok mongod up"; else done_verb mongo-start "error mongod did not start"; fi ;;
    mongo-freeze|mongo-thaw)
      [ -n "$MONGOD_PID" ] || { done_verb $verb "error mongod is not running"; return; }
      if [ $verb = mongo-freeze ]; then kill -STOP "$MONGOD_PID"; else kill -CONT "$MONGOD_PID"; fi
      done_verb $verb "ok $verb" ;;
    proxy-drop)
      rm -f "$CTL/proxy-cut.ack"
      : > "$CTL/proxy-cut"
      local i; for i in {1..30}; do [ -f "$CTL/proxy-cut.ack" ] && break; sleep 0.1; done
      if [ -f "$CTL/proxy-cut.ack" ]; then done_verb proxy-drop "ok dropped $(cat "$CTL/proxy-cut.ack") websocket(s)"
      else done_verb proxy-drop "error the proxy did not answer"; fi ;;
    status) done_verb status "ok $(status_text)" ;;
  esac
}

teardown() {
  local p i
  log "stopping"
  for p in ${(k)I_STATE}; do
    alive "$p" || continue
    kill -CONT "${I_PID[$p]}" 2>/dev/null
    kill -TERM "${I_PID[$p]}" 2>/dev/null
  done
  for i in {1..100}; do
    reap
    local any=0
    for p in ${(k)I_STATE}; do alive "$p" && any=1; done
    [ $any -eq 0 ] && break
    sleep 0.2
  done
  for p in ${(k)I_STATE}; do alive "$p" && { kill -KILL "${I_PID[$p]}" 2>/dev/null; log "instance $p SIGKILL at teardown"; }; done
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  stop_mongod
  rm -f "$CTL/ready"
  log "stopped"
}
trap 'teardown; exit 0' INT TERM

# ---------- boot ----------
log "harness boot: proxy $PROXY, ports $PORTS_ARG, db $DB, mongod $MONGO_PORT, mode $MODE, checkout $ROOT"
start_mongod || { teardown; die "mongod did not start (see $CTL/mongod.log)"; }
start_proxy || { teardown; die "the proxy did not start (see $CTL/proxy.log)"; }
start_instance "${PORTS[1]}" "$MODE" "$(new_dep)"
for i in {1..600}; do
  ready "${PORTS[1]}" && break
  reap
  [ "${I_STATE[${PORTS[1]}]}" = exited ] && break
  sleep 0.2
done
if ! ready "${PORTS[1]}"; then
  teardown
  die "the first instance never answered /ready (see $CTL/instance-${PORTS[1]}.log)"
fi
I_STATE[${PORTS[1]}]=ready
route_to "${PORTS[1]}"
print -r -- "proxy=$PROXY instance=${PORTS[1]} mode=$MODE" > "$CTL/ready"
echo "persist-live-harness: http://127.0.0.1:$PROXY/ (http://localhost:$PROXY/) -> instance ${PORTS[1]} ($MODE), db $DB on mongod $MONGO_PORT"
echo "  verbs: $SELF --ctl $CTL --do <verb> [key=value ...]   (stop: --do stop); log $LOG"

# ---------- the loop ----------
while true; do
  reap
  tick_pending
  tick_deploy
  tick_term
  if [ -f "$CTL/stop" ]; then
    rm -f "$CTL/stop"
    teardown
    print -r -- "ok stopped" > "$CTL/stop.done"
    exit 0
  fi
  for v in $VERBS; do
    [ "$v" = stop ] && continue
    [ -f "$CTL/$v" ] || continue
    args=$(cat "$CTL/$v"); rm -f "$CTL/$v"
    log "verb $v ${args}"
    handle "$v" ${=args}
  done
  sleep 0.2
done

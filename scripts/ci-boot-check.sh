#!/usr/bin/env bash
# CI boot check (.github/workflows/ci.yml): wait until every URL answers 2xx,
# failing early if the server under test has already exited, so a crash at
# boot fails the job instead of passing a fixed sleep.
#
#   scripts/ci-boot-check.sh (--pid PID | --container NAME) URL...
#
# BOOT_TIMEOUT (seconds, default 60) bounds the whole wait, all URLs together;
# BOOT_SETTLE (seconds, default 5) is how long it must stay up afterwards.
set -euo pipefail

usage() { echo "usage: $0 (--pid PID | --container NAME) URL..." >&2; exit 2; }

[ $# -ge 3 ] || usage
case "$1" in
    --pid) alive() { kill -0 "$target" 2>/dev/null; } ;;
    --container) alive() { [ "$(docker inspect -f '{{.State.Running}}' "$target" 2>/dev/null)" = true ]; } ;;
    *) usage ;;
esac
target="$2"
shift 2

timeout="${BOOT_TIMEOUT:-60}"
deadline=$((SECONDS + timeout))

for url in "$@"; do
    until body="$(curl --fail --silent --show-error --max-time 5 "$url" 2>&1)"; do
        if ! alive "$target"; then
            echo "boot check: $target exited before $url answered" >&2
            exit 1
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "boot check: no 2xx from $url within ${timeout}s (last: ${body:0:300})" >&2
            exit 1
        fi
        sleep 2
    done
    body="${body//$'\n'/ }"
    echo "boot check: $url -> ${body:0:120}"
done

# Answering once isn't enough if it dies right after (a late crash in boot)
sleep "${BOOT_SETTLE:-5}"
if ! alive "$target"; then
    echo "boot check: $target exited after answering" >&2
    exit 1
fi

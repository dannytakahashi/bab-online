#!/bin/zsh
# Fixture screenshots (roadmap item 26). Two modes:
#
#   ios-screenshots.sh <result.xcresult> <outdir>
#       Export the PNG attachments of a BABOnlineUITests run (FixtureScreenshotTests
#       names them <pose>-<fixture>-screen<i>-<WxH>) into <outdir>, renamed from the
#       manifest, and print each image's pixel size.
#
#   ios-screenshots.sh --simctl <udid> <outdir> <fixture...>
#       No XCTest: install-free relaunch of the installed Debug app per fixture
#       (`simctl launch ... -uiFixture <name>`) and `simctl io screenshot` of both
#       displays (primary = the Duo's outer 1398x2034, primary-1 = the inner
#       2007x2853). Set EXTRA="-uiFold book" for more launch arguments.
#
#   ios-screenshots.sh --status-bar <udid> set|clear
#       The App Store status bar (9:41, full bars) for an XCTest screenshot run, and
#       back to the live one afterwards (--simctl sets and clears it itself).
#
# The Duo's pose (closed / open / partially open) is set by hand in Device Hub.
# Screenshots are review material: keep them out of the repo.
set -u

status_bar() {
  if [[ "$2" == "set" ]]; then
    xcrun simctl status_bar "$1" override --time 9:41 --dataNetwork wifi --wifiBars 3 --cellularBars 4 --batteryState charged --batteryLevel 100 >/dev/null 2>&1
  else
    xcrun simctl status_bar "$1" clear >/dev/null 2>&1
  fi
}

if [[ "${1:-}" == "--status-bar" ]]; then
  status_bar "${2:?udid}" "${3:?set|clear}"
  exit 0
fi

if [[ "${1:-}" == "--simctl" ]]; then
  udid=$2; out=$3; shift 3
  mkdir -p "$out"
  status_bar "$udid" set
  trap 'status_bar "$udid" clear' EXIT
  for fx in "$@"; do
    xcrun simctl terminate "$udid" com.bab-online.BABOnline >/dev/null 2>&1
    xcrun simctl launch "$udid" com.bab-online.BABOnline -uiFixture "$fx" ${=EXTRA:-} >/dev/null || exit 1
    sleep 3
    for d in primary primary-1; do
      f="$out/$fx-$d.png"
      if xcrun simctl io "$udid" screenshot --display="$d" "$f" >/dev/null 2>&1; then
        echo "$(sips -g pixelWidth -g pixelHeight "$f" | awk '/pixel/ {printf "%s ", $2}') $f"
      fi
    done
  done
  xcrun simctl terminate "$udid" com.bab-online.BABOnline >/dev/null 2>&1
  exit 0
fi

result=${1:?usage: ios-screenshots.sh <xcresult> <outdir> | --simctl <udid> <outdir> <fixture...>}
out=${2:?outdir}
mkdir -p "$out"
tmp=$(mktemp -d)
xcrun xcresulttool export attachments --path "$result" --output-path "$tmp" >/dev/null || exit 1
python3 -I - "$tmp" "$out" <<'PY'
import json, os, re, shutil, sys
src, out = sys.argv[1], sys.argv[2]
manifest = json.load(open(os.path.join(src, "manifest.json")))
n = 0
for test in manifest:
    for a in test.get("attachments", []):
        name = a.get("suggestedHumanReadableName") or a["exportedFileName"]
        base, ext = os.path.splitext(name)
        base = re.sub(r"_\d+_[0-9A-Fa-f-]{36}$", "", base)
        ext = os.path.splitext(a["exportedFileName"])[1] or ext
        if ext.lower() != ".png":
            continue
        shutil.copyfile(os.path.join(src, a["exportedFileName"]), os.path.join(out, base + ext))
        n += 1
print("exported %d screenshots" % n)
PY
rm -rf "$tmp"
for f in "$out"/*.png(N); do
  echo "$(sips -g pixelWidth -g pixelHeight "$f" | awk '/pixel/ {printf "%s ", $2}') $(basename "$f")"
done

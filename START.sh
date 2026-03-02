cd repo
git fetch origin
git reset --hard origin/master
chmod -R +x Util/aMuleD.AppImage/
rm -f ~/.aMule/muleLock .aMule/muleLock 2>/dev/null

detect_arch() {
  case "$(uname -m)" in
    aarch64|arm64) echo "arm64" ;;
    armv7*) echo "armv7" ;;
    *) echo "x64" ;;
  esac
}

detect_os() {
  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]]; then
    echo "win"
  else
    echo "linux"
  fi
}

OS=$(detect_os)
ARCH=$(detect_arch)

if [[ "$OS" == "win" ]]; then
  case "$(echo $PROCESSOR_ARCHITECTURE | tr '[:upper:]' '[:lower:]')" in
    arm64) ARCH="arm64" ;;
    *) ARCH="x64" ;;
  esac
  BIN="Util/aMuleD.AppImage/amuled-${ARCH}.exe"
else
  BIN="Util/aMuleD.AppImage/amuled-${ARCH}.AppImage"
fi

FLAGS="--config-dir=.aMule"
EXTRACT_DIR="../home/amuled"
SUCCESS_THRESHOLD=600
MAX_ATTEMPTS=3
WORKING_METHOD=""

start_server() {
  cd MuLy 2>/dev/null || return
  VOLTA_NPM="/opt/aMuleD.bin/home/.volta/bin/npm"
  if [[ -x "$VOLTA_NPM" ]]; then
    "$VOLTA_NPM" install --force && node server.js &
  elif command -v volta &>/dev/null; then
    volta run npm install --force && node server.js &
  else
    npm install --force && node server.js &
  fi
  cd ..
}

run_method_1() {
  rm -f ~/.aMule/muleLock .aMule/muleLock 2>/dev/null
  "$BIN" $FLAGS
}

run_method_2() {
  rm -f ~/.aMule/muleLock .aMule/muleLock 2>/dev/null
  "$BIN" --appimage-extract-and-run $FLAGS
}

run_method_3() {
  rm -f ~/.aMule/muleLock .aMule/muleLock 2>/dev/null
  mkdir -p "$EXTRACT_DIR"
  rm -rf "$EXTRACT_DIR/squashfs-root" 2>/dev/null
  cd "$EXTRACT_DIR" && "$OLDPWD/$BIN" --appimage-extract
  ./squashfs-root/usr/bin/amuled $FLAGS
  cd "$OLDPWD"
}

try_method() {
  local method_fn="$1"
  local attempts=0
  local first_fail=0

  while true; do
    local t_start=$(date +%s)
    $method_fn
    local elapsed=$(( $(date +%s) - t_start ))

    if (( elapsed >= SUCCESS_THRESHOLD )); then
      return 0
    fi

    attempts=$(( attempts + 1 ))
    [[ $attempts -eq 1 ]] && first_fail=$(date +%s)

    if (( attempts >= MAX_ATTEMPTS )); then
      local window=$(( $(date +%s) - first_fail ))
      if (( window < SUCCESS_THRESHOLD )); then
        return 1
      else
        attempts=1
        first_fail=$(date +%s)
      fi
    fi

    sleep 2
  done
}

watchdog() {
  local method_fn="$1"
  while true; do
    rm -f ~/.aMule/muleLock .aMule/muleLock 2>/dev/null
    $method_fn
    sleep 2
  done
}

start_server

while true; do
  for method in run_method_1 run_method_2 run_method_3; do
    if try_method "$method"; then
      WORKING_METHOD="$method"
      break 2
    fi
  done
done

watchdog "$WORKING_METHOD"

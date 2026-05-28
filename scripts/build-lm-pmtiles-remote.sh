#!/usr/bin/env bash
# Kör build-lm-pmtiles.sh på en fjärrserver och hämtar hem resultatet.
#
# Användning:
#   ./scripts/build-lm-pmtiles-remote.sh                  # fullt Sverige-bygge
#   ./scripts/build-lm-pmtiles-remote.sh --bbox=17.7,59.2,18.3,59.5   # prototyp
#   ./scripts/build-lm-pmtiles-remote.sh --skip-upload    # data redan uppe
#   ./scripts/build-lm-pmtiles-remote.sh --skip-download  # bygg utan att hämta hem
#   ./scripts/build-lm-pmtiles-remote.sh --no-resume      # börja bygget om från noll
#   ./scripts/build-lm-pmtiles-remote.sh -- --force       # argument efter "--" går till remote-skriptet
#
# Konfiguration (alla har defaults; sätt i .env eller miljö):
#   LM_REMOTE_HOST   default: 178.105.223.176
#   LM_REMOTE_USER   default: root
#   LM_REMOTE_DIR    default: /root/kvg
#   LM_RAW_DIR       default: data/raw/lantmäteriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259
#   LM_OUT_PMTILES   default: data/sweden-lm.pmtiles
#   LM_SSH_OPTS      default: (tom; t.ex. "-i ~/.ssh/id_ed25519")
#
# Kräver lokalt: ssh, scp, rsync
# Installeras automatiskt på servern: gdal-bin, tippecanoe, unzip, jq, pmtiles
#
set -euo pipefail
cd "$(dirname "$0")/.."

# Ladda .env om den finns (för LM_REMOTE_HOST m.fl.)
if [[ -f .env ]]; then
  set -a; . ./.env; set +a
fi

LM_REMOTE_HOST="${LM_REMOTE_HOST:-178.105.223.176}"
LM_REMOTE_USER="${LM_REMOTE_USER:-root}"
LM_REMOTE_DIR="${LM_REMOTE_DIR:-/root/kvg}"
LM_RAW_DIR="${LM_RAW_DIR:-data/raw/lantmäteriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259}"
LM_OUT_PMTILES="${LM_OUT_PMTILES:-data/sweden-lm.pmtiles}"
LM_SSH_OPTS="${LM_SSH_OPTS:-}"

SKIP_UPLOAD=0
SKIP_DOWNLOAD=0
NO_RESUME=0
REMOTE_ARGS=()
PASSTHROUGH=0

for arg in "$@"; do
  if [[ "$PASSTHROUGH" -eq 1 ]]; then REMOTE_ARGS+=("$arg"); continue; fi
  case "$arg" in
    --) PASSTHROUGH=1 ;;
    --skip-upload) SKIP_UPLOAD=1 ;;
    --skip-download) SKIP_DOWNLOAD=1 ;;
    --no-resume) NO_RESUME=1 ;;
    --bbox=*|--force|--force-stage=*|--inventory) REMOTE_ARGS+=("$arg") ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Okänt argument: $arg" >&2; exit 2 ;;
  esac
done

SSH=(ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 $LM_SSH_OPTS)
RSYNC_SSH="ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 $LM_SSH_OPTS"
REMOTE="${LM_REMOTE_USER}@${LM_REMOTE_HOST}"
REMOTE_RAW="${LM_REMOTE_DIR}/data/raw/lm"
REMOTE_SCRIPT="${LM_REMOTE_DIR}/scripts/build-lm-pmtiles.sh"
REMOTE_OUT="${LM_REMOTE_DIR}/data/sweden-lm.pmtiles"
LOG_DIR="${LM_REMOTE_DIR}/logs"

echo ">> Mål: ${REMOTE}:${LM_REMOTE_DIR}"

# --------------------------------------------------------------------------
# 1. SSH-test + deps install (idempotent)
# --------------------------------------------------------------------------
echo ">> [1/5] Verifierar SSH och installerar verktyg vid behov"
"${SSH[@]}" "$REMOTE" "set -e
  mkdir -p '${LM_REMOTE_DIR}/scripts' '${REMOTE_RAW}' '${LM_REMOTE_DIR}/data' '${LOG_DIR}'
  need_install=0
  for c in ogr2ogr tippecanoe tile-join pmtiles unzip jq; do
    command -v \$c >/dev/null 2>&1 || need_install=1
  done
  if [ \$need_install -eq 1 ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq gdal-bin tippecanoe unzip jq curl ca-certificates >/dev/null
    if ! command -v pmtiles >/dev/null; then
      curl -sSL https://github.com/protomaps/go-pmtiles/releases/download/v1.22.3/go-pmtiles_1.22.3_Linux_x86_64.tar.gz \
        | tar xz -C /tmp pmtiles
      mv /tmp/pmtiles /usr/local/bin/pmtiles && chmod +x /usr/local/bin/pmtiles
    fi
  fi
  echo '   gdal:      '\$(ogr2ogr --version)
  echo '   tippecanoe:'\$(tippecanoe --version 2>&1 | head -1)
  echo '   pmtiles:   '\$(pmtiles version 2>&1 | head -1)
"

# --------------------------------------------------------------------------
# 2. Synka script + rådata
# --------------------------------------------------------------------------
echo ">> [2/5] Uppladdar bygg-script"
rsync -avh -e "$RSYNC_SSH" scripts/build-lm-pmtiles.sh "${REMOTE}:${REMOTE_SCRIPT}"
"${SSH[@]}" "$REMOTE" "chmod +x '${REMOTE_SCRIPT}'"

if [[ "$SKIP_UPLOAD" -eq 1 ]]; then
  echo "   (skip) --skip-upload satt; hoppar över rådata-sync"
else
  echo ">> [3/5] Synkar rådata ($(du -sh "$LM_RAW_DIR" | cut -f1)) till ${REMOTE}:${REMOTE_RAW}"
  rsync -avh --partial --progress -e "$RSYNC_SSH" \
    "${LM_RAW_DIR%/}/" "${REMOTE}:${REMOTE_RAW}/"
fi

# --------------------------------------------------------------------------
# 3. Kör bygget (i bakgrunden via nohup så SSH-tapp inte avbryter)
# --------------------------------------------------------------------------
LOG_NAME="build-$(date +%Y%m%d-%H%M%S).log"
REMOTE_LOG="${LOG_DIR}/${LOG_NAME}"
REMOTE_PID_FILE="${LOG_DIR}/build.pid"

if [[ "$NO_RESUME" -eq 1 ]]; then
  echo ">> --no-resume: rensar tidigare stage-data"
  "${SSH[@]}" "$REMOTE" "rm -rf '${LM_REMOTE_DIR}/data/stage/lm' '${REMOTE_OUT}'"
fi

# Om en build redan kör: häng på den loggen istället för att starta en ny.
RUNNING_PID="$("${SSH[@]}" "$REMOTE" "test -f '${REMOTE_PID_FILE}' && cat '${REMOTE_PID_FILE}' || true")"
if [[ -n "$RUNNING_PID" ]] && "${SSH[@]}" "$REMOTE" "kill -0 ${RUNNING_PID} 2>/dev/null"; then
  CURRENT_LOG="$("${SSH[@]}" "$REMOTE" "ls -t ${LOG_DIR}/build-*.log 2>/dev/null | head -1")"
  echo ">> [4/5] Build kör redan (pid ${RUNNING_PID}); följer ${CURRENT_LOG}"
  REMOTE_LOG="$CURRENT_LOG"
else
  echo ">> [4/5] Startar bygge: ${REMOTE_SCRIPT} ${REMOTE_ARGS[*]:-}"
  REMOTE_ARGS_QUOTED=""
  for a in "${REMOTE_ARGS[@]:-}"; do
    [[ -z "$a" ]] && continue
    REMOTE_ARGS_QUOTED+=" $(printf %q "$a")"
  done
  "${SSH[@]}" "$REMOTE" "
    cd '${LM_REMOTE_DIR}'
    export LM_RAW_DIR='${REMOTE_RAW}'
    nohup bash '${REMOTE_SCRIPT}' ${REMOTE_ARGS_QUOTED} >'${REMOTE_LOG}' 2>&1 &
    echo \$! > '${REMOTE_PID_FILE}'
    echo '   pid='\$(cat '${REMOTE_PID_FILE}')
    echo '   log='${REMOTE_LOG}
  "
fi

echo ">> Följer logg (Ctrl+C bryter följandet, bygget fortsätter på servern)"
"${SSH[@]}" "$REMOTE" "tail -n +1 -f '${REMOTE_LOG}' --pid=\$(cat '${REMOTE_PID_FILE}')" || true

# Hämta exitkod
EXIT_CODE="$("${SSH[@]}" "$REMOTE" "
  PID=\$(cat '${REMOTE_PID_FILE}' 2>/dev/null || echo)
  if [ -n \"\$PID\" ] && kill -0 \"\$PID\" 2>/dev/null; then echo running; exit 0; fi
  # Avlöst process — leta exitkod i loggens sista rad
  grep -q 'Klart: ' '${REMOTE_LOG}' && echo 0 || echo failed
")"

if [[ "$EXIT_CODE" == "running" ]]; then
  echo ">> Bygget kör fortfarande på servern. Återanslut senare med:"
  echo "   $0 --skip-upload"
  exit 0
fi
if [[ "$EXIT_CODE" != "0" ]]; then
  echo ">> Bygget misslyckades. Se ${REMOTE_LOG} på servern." >&2
  exit 1
fi

# --------------------------------------------------------------------------
# 4. Hämta hem resultatet
# --------------------------------------------------------------------------
if [[ "$SKIP_DOWNLOAD" -eq 1 ]]; then
  echo ">> [5/5] (skip) --skip-download satt"
  exit 0
fi

mkdir -p "$(dirname "$LM_OUT_PMTILES")"
echo ">> [5/5] Hämtar hem ${REMOTE_OUT} -> ${LM_OUT_PMTILES}"
rsync -avh --partial --progress -e "$RSYNC_SSH" \
  "${REMOTE}:${REMOTE_OUT}" "${LM_OUT_PMTILES}"

echo "Klart: ${LM_OUT_PMTILES} ($(du -sh "$LM_OUT_PMTILES" | cut -f1))"

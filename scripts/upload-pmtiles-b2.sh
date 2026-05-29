#!/usr/bin/env bash
# Laddar upp sweden-lm.pmtiles till Backblaze B2 via S3-kompatibelt API.
#
# Designat att köra på samma host som byggde filen (server eller lokalt).
# Multipart-upload sköts av aws-cli (handles ~18 GB UNAN problem).
#
# Konfiguration via env-variabler (eller .env-fil i repo-roten):
#   B2_KEY_ID            – B2 application keyID
#   B2_APPLICATION_KEY   – B2 application key
#   B2_BUCKET            – mål-bucket (t.ex. "kartvertyget-tiles")
#   B2_ENDPOINT          – S3-endpoint, t.ex. "https://s3.eu-central-003.backblazeb2.com"
#   B2_REGION            – regionkod ur endpointen, t.ex. "eu-central-003"
#   B2_KEY               – objektnyckel (default: "sweden-lm.pmtiles")
#
# Användning:
#   ./scripts/upload-pmtiles-b2.sh                       # ladda upp data/sweden-lm.pmtiles
#   ./scripts/upload-pmtiles-b2.sh path/to/file.pmtiles  # annan källfil
#   ./scripts/upload-pmtiles-b2.sh --wait                # vänta tills filen är klar (inga build-processer kör)
#   ./scripts/upload-pmtiles-b2.sh --check               # endast verifiera credentials + filtillstånd
#   ./scripts/upload-pmtiles-b2.sh --dry-run             # visa kommandot men kör inte
#
# Kräver: awscli v2 (brew install awscli  /  apt install awscli),
#         pmtiles CLI (för sanity-check av filhuvudet).
#
set -euo pipefail
cd "$(dirname "$0")/.."

# --- ladda .env om den finns ---
if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

SRC="data/sweden-lm.pmtiles"
WAIT=0
CHECK_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --wait)    WAIT=1 ;;
    --check)   CHECK_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -*) echo "Okänd flagga: $arg" >&2; exit 2 ;;
    *)  SRC="$arg" ;;
  esac
done

: "${B2_KEY_ID:?ange B2_KEY_ID (B2 application keyID)}"
: "${B2_APPLICATION_KEY:?ange B2_APPLICATION_KEY}"
: "${B2_BUCKET:?ange B2_BUCKET}"
: "${B2_ENDPOINT:?ange B2_ENDPOINT (t.ex. https://s3.eu-central-003.backblazeb2.com)}"
: "${B2_REGION:?ange B2_REGION (t.ex. eu-central-003)}"
B2_KEY="${B2_KEY:-sweden-lm.pmtiles}"

command -v aws >/dev/null || { echo "aws-cli saknas (brew install awscli)" >&2; exit 1; }

aws_call() {
  AWS_ACCESS_KEY_ID="$B2_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$B2_APPLICATION_KEY" \
  AWS_DEFAULT_REGION="$B2_REGION" \
  aws --endpoint-url "$B2_ENDPOINT" "$@"
}

echo ">> Konfig"
echo "   bucket   : $B2_BUCKET"
echo "   key      : $B2_KEY"
echo "   endpoint : $B2_ENDPOINT"
echo "   källa    : $SRC"

if [[ "$CHECK_ONLY" == 1 ]]; then
  echo ">> Verifierar credentials (head-bucket)"
  aws_call s3api head-bucket --bucket "$B2_BUCKET" && echo "   OK"
  exit 0
fi

# --- vänta in build om begärt ---
if [[ "$WAIT" == 1 ]]; then
  echo ">> Väntar på att build-processer ska bli klara"
  while pgrep -fa 'tippecanoe|tile-join|pmtiles convert|build-lm-pmtiles' >/dev/null; do
    sleep 30
    echo "   $(date '+%H:%M:%S') – build pågår fortfarande..."
  done
  echo "   inga build-processer kör"
fi

# --- sanity-check filen ---
if [[ ! -f "$SRC" ]]; then
  echo "Fel: källfilen finns inte: $SRC" >&2
  exit 1
fi
SRC_SIZE=$(stat -c%s "$SRC" 2>/dev/null || stat -f%z "$SRC")
echo ">> Källa: $SRC ($(numfmt --to=iec --suffix=B "$SRC_SIZE" 2>/dev/null || echo "$SRC_SIZE bytes"))"

if [[ "$SRC_SIZE" -lt 1000000 ]]; then
  echo "Fel: filen är misstänkt liten (<1 MB) — build kanske inte är klar?" >&2
  exit 1
fi

# Verifiera PMTiles-magic via pmtiles CLI om tillgänglig, annars dd
if command -v pmtiles >/dev/null; then
  if ! pmtiles show "$SRC" >/dev/null 2>&1; then
    echo "Fel: pmtiles show misslyckades — filen är trasig eller ofullständig" >&2
    exit 1
  fi
  echo "   pmtiles show OK"
else
  MAGIC=$(head -c 7 "$SRC")
  [[ "$MAGIC" == "PMTiles" ]] || { echo "Fel: fel magic (förväntade 'PMTiles')" >&2; exit 1; }
fi

# --- jämför med befintligt objekt (om finns) ---
echo ">> Kontrollerar existerande objekt i bucket"
REMOTE_INFO=$(aws_call s3api head-object --bucket "$B2_BUCKET" --key "$B2_KEY" 2>/dev/null || true)
if [[ -n "$REMOTE_INFO" ]]; then
  REMOTE_SIZE=$(echo "$REMOTE_INFO" | sed -n 's/.*"ContentLength": *\([0-9]*\).*/\1/p' | head -1)
  REMOTE_MTIME=$(echo "$REMOTE_INFO" | sed -n 's/.*"LastModified": *"\([^"]*\)".*/\1/p' | head -1)
  echo "   befintlig: $REMOTE_SIZE bytes, $REMOTE_MTIME"
  if [[ "$REMOTE_SIZE" == "$SRC_SIZE" ]]; then
    echo "   VARNING: samma storlek som lokal fil — kanske redan uppladdad."
    echo "           ladda upp ändå utan att ange --dry-run."
  fi
else
  echo "   objektet finns inte ännu"
fi

# --- multipart-tuning för stora filer ---
# Backblaze rekommenderar 100 MB+ part size för stora objekt
aws configure set default.s3.multipart_chunksize 128MB
aws configure set default.s3.multipart_threshold 128MB
aws configure set default.s3.max_concurrent_requests 8

CMD=(s3 cp "$SRC" "s3://$B2_BUCKET/$B2_KEY"
     --content-type "application/octet-stream"
     --cache-control "public, max-age=86400, immutable"
     --metadata "source=kartvertyget,built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
     --no-progress)

echo ">> Kommando:"
echo "   aws --endpoint-url $B2_ENDPOINT ${CMD[*]}"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "(dry-run, hoppar över själva uppladdningen)"
  exit 0
fi

echo ">> Laddar upp (multipart, ~$(( SRC_SIZE / 134217728 )) parts à 128 MB)"
START=$(date +%s)
aws_call "${CMD[@]}"
END=$(date +%s)
DURATION=$((END - START))
echo ">> Klart på ${DURATION}s ($(( SRC_SIZE / (DURATION > 0 ? DURATION : 1) / 1048576 )) MB/s)"

# --- verifiera uppladdat objekt ---
echo ">> Verifierar uppladdat objekt"
NEW_INFO=$(aws_call s3api head-object --bucket "$B2_BUCKET" --key "$B2_KEY")
NEW_SIZE=$(echo "$NEW_INFO" | sed -n 's/.*"ContentLength": *\([0-9]*\).*/\1/p' | head -1)
if [[ "$NEW_SIZE" != "$SRC_SIZE" ]]; then
  echo "Fel: storlek matchar inte ($NEW_SIZE vs $SRC_SIZE)" >&2
  exit 1
fi
echo "   $NEW_SIZE bytes – OK"

# B2 publik URL (om bucket är public): https://f003.backblazeb2.com/file/<bucket>/<key>
# eller via S3-endpoint:               https://<endpoint-host>/<bucket>/<key>
ENDPOINT_HOST="${B2_ENDPOINT#https://}"
echo ""
echo ">> Förmodade publika URL:er (beroende på bucket-policy):"
echo "   S3-style:  https://$B2_BUCKET.${ENDPOINT_HOST}/$B2_KEY"
echo "   Path-style: $B2_ENDPOINT/$B2_BUCKET/$B2_KEY"
echo "   B2-native:  https://f003.backblazeb2.com/file/$B2_BUCKET/$B2_KEY"
echo ""
echo "Tips: testa range-request: curl -sI -r 0-127 <url>"

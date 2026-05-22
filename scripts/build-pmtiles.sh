#!/usr/bin/env bash
# Bygger data/sweden.pmtiles.
#
# Metod 1 (STANDARD, snabb ~3-5 min): Extraherar Sverige direkt från Protomaps
# senaste dagliga planet-build via HTTP range-requests.
# Kräver: pmtiles CLI (brew install pmtiles).
#
# Metod 2 (ALTERNATIV, långsam ~30-90 min): Bygger från Geofabriks OSM-PBF via
# planetiler. Ger identisk schema men tar längre tid. Aktiveras med --planetiler.
#
# Användning:
#   ./scripts/build-pmtiles.sh              # Metod 1 (standard)
#   ./scripts/build-pmtiles.sh --planetiler # Metod 2
#
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_DIR="data"
mkdir -p "$DATA_DIR"
OUT="$DATA_DIR/sweden.pmtiles"

# Sverigs ungefärliga bbox (lon_min lat_min lon_max lat_max)
BBOX="10.54,55.20,24.17,69.07"

if [[ "${1:-}" == "--planetiler" ]]; then
  echo ">> Metod 2: planetiler"
  RAW_DIR="$DATA_DIR/raw"
  mkdir -p "$RAW_DIR"
  PBF="$RAW_DIR/sweden-latest.osm.pbf"
  PBF_URL="https://download.geofabrik.de/europe/sweden-latest.osm.pbf"
  JAR="$RAW_DIR/planetiler.jar"
  JAR_URL="https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar"

  if [ ! -f "$PBF" ]; then
    echo ">> Laddar ner OSM-extrakt …"
    curl -L --fail -o "$PBF" "$PBF_URL"
  fi
  if [ ! -f "$JAR" ]; then
    echo ">> Laddar ner planetiler …"
    curl -L --fail -o "$JAR" "$JAR_URL"
  fi
  java -Xmx6g -jar "$JAR" --osm-path="$PBF" --output="$OUT" --force
else
  echo ">> Metod 1: pmtiles extract från Protomaps planet-build"
  which pmtiles >/dev/null || { echo "Fel: pmtiles CLI saknas. Installera: brew install pmtiles"; exit 1; }

  # Hitta senaste tillgängliga build (försök bakåt i tid).
  BASE_URL=""
  for DAYS_AGO in 0 1 2 3 4 5 6 7; do
    DATE=$(date -v-${DAYS_AGO}d "+%Y%m%d" 2>/dev/null || date -d "-${DAYS_AGO} days" "+%Y%m%d")
    URL="https://build.protomaps.com/${DATE}.pmtiles"
    CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$URL")
    if [ "$CODE" = "200" ]; then
      BASE_URL="$URL"
      echo ">> Hittade build: $URL"
      break
    fi
  done

  if [ -z "$BASE_URL" ]; then
    echo "Fel: Ingen Protomaps-build hittades de senaste 7 dagarna."
    exit 1
  fi

  pmtiles extract "$BASE_URL" "$OUT" --bbox="$BBOX" --minzoom=0 --maxzoom=15
fi

echo "Klart: $OUT ($(du -sh "$OUT" | cut -f1))"

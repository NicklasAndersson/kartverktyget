#!/usr/bin/env bash
# Bygger data/sweden-lm.pmtiles från Lantmäteriets Topografi 10 (GEODOK/51).
#
# Förutsätter att råleveransen ligger uppackningsklar under
#   data/raw/lantmäteriet/<uttagsidentitet>/*.zip
# (default: bb7631cc-81ee-4bd0-aa8b-2a23714cb259, sätt LM_RAW_DIR för annan).
#
# Pipeline:
#   1. unzip *_sverige.zip          -> data/stage/lm/gpkg/*.gpkg
#   2. ogr2ogr (EPSG:3006 -> 4326)  -> data/stage/lm/geojsonl/<lager>.geojsonl
#   3. tippecanoe per lager          -> data/stage/lm/mbtiles/<lager>.mbtiles
#   4. tile-join                     -> data/stage/lm/sweden-lm.mbtiles
#   5. pmtiles convert               -> data/sweden-lm.pmtiles
#
# Idempotent: hoppar över steg vars output redan finns. Använd --force för
# att bygga om allt från grunden, eller --force-stage=<unzip|geojson|mvt|join|pmtiles>
# för att tvinga om ett enskilt steg.
#
# Användning:
#   ./scripts/build-lm-pmtiles.sh                  # fullt Sverige-bygge
#   ./scripts/build-lm-pmtiles.sh --bbox=17.7,59.2,18.3,59.5  # endast Stockholm (prototyp)
#   ./scripts/build-lm-pmtiles.sh --inventory      # ogrinfo över alla gpkg, ingen build
#   ./scripts/build-lm-pmtiles.sh --force          # bygg om allt
#
# Kräver: gdal (ogr2ogr/ogrinfo) >= 3.8, tippecanoe >= 2.40, pmtiles CLI,
#         unzip, jq (för --inventory).
#   brew install gdal tippecanoe pmtiles jq
#
set -euo pipefail
cd "$(dirname "$0")/.."

LM_RAW_DIR="${LM_RAW_DIR:-data/raw/lantmäteriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259}"
STAGE="data/stage/lm"
GPKG_DIR="$STAGE/gpkg"
GEOJSON_DIR="$STAGE/geojsonl"
MBTILES_DIR="$STAGE/mbtiles"
MERGED_MBTILES="$STAGE/sweden-lm.mbtiles"
OUT_PMTILES="data/sweden-lm.pmtiles"

FORCE_ALL=0
FORCE_STAGE=""
BBOX=""
INVENTORY=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE_ALL=1 ;;
    --force-stage=*) FORCE_STAGE="${arg#*=}" ;;
    --bbox=*) BBOX="${arg#*=}" ;;
    --inventory) INVENTORY=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Okänt argument: $arg" >&2; exit 2 ;;
  esac
done

stage_needs_rebuild() {
  local stage="$1" target="$2"
  [[ "$FORCE_ALL" -eq 1 ]] && return 0
  [[ "$FORCE_STAGE" == "$stage" ]] && return 0
  [[ ! -e "$target" ]] && return 0
  return 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Fel: '$1' saknas. Installera enligt skriptets huvud." >&2; exit 1; }
}

require_cmd unzip
require_cmd ogr2ogr
require_cmd ogrinfo
require_cmd tippecanoe
require_cmd tile-join
require_cmd pmtiles

if [[ ! -d "$LM_RAW_DIR" ]]; then
  echo "Fel: råleverans saknas i $LM_RAW_DIR" >&2
  exit 1
fi

mkdir -p "$GPKG_DIR" "$GEOJSON_DIR" "$MBTILES_DIR" "data"

# --------------------------------------------------------------------------
# Lagermappning. Format per rad:
#   <lager>|<gpkg-basnamn>|<tabell>|<minzoom>|<maxzoom>|<extra-tippecanoe-args>
#
# Tabellnamnen är hämtade ur uttag.json för den faktiska leveransen.
# `extra-tippecanoe-args` läggs efter standardflaggorna och kan vara tom.
# --------------------------------------------------------------------------
# OBS: minzoom är vald så att en z(minz)-tile får plats i RAM på 16 GB-servern.
# Lantmäteriets Topo10 är designat för zoom ~10+; under z8 räcker background-
# fyllningen i style:n. mark/sankmark har 3,5M polygoner — z5 OOMmar tippecanoe
# (varje tile måste hålla nästan hela landet i minnet samtidigt).
read -r -d '' LAYER_SPECS <<'SPECS' || true
earth|mark_sverige|mark|5|10|--exclude-all --coalesce --reorder -D8 --simplification=20
landcover|mark_sverige|mark|9|15|--coalesce-smallest-as-needed --maximum-tile-bytes=800000
landcover_wet|mark_sverige|sankmark|9|15|--coalesce-smallest-as-needed
land_edges|mark_sverige|markkantlinje|11|15|--drop-densest-as-needed
water|hydro_sverige|hydrolinje|7|15|--drop-densest-as-needed
watercourses|hydro_sverige|hydroanlaggningslinje|9|15|--drop-densest-as-needed
water_points|hydro_sverige|hydropunkt|10|15|--drop-densest-as-needed
water_intressanta|hydro_sverige|hydrografiskt_intressant_plats|10|15|
water_anlaggningspunkt|hydro_sverige|hydroanlaggningspunkt|10|15|
roads|kommunikation_sverige|vaglinje|8|15|--drop-densest-as-needed
roads_minor|kommunikation_sverige|ovrig_vag|10|15|--drop-densest-as-needed
trails|kommunikation_sverige|transportled_fjall|10|15|
trail_points|kommunikation_sverige|ledintressepunkt_fjall|11|15|
ferry|kommunikation_sverige|farjeled|8|15|
road_points|kommunikation_sverige|vagpunkt|11|15|
rail|kommunikation_sverige|ralstrafik|7|15|
rail_stations|kommunikation_sverige|ralstrafikstation|9|15|
buildings|byggnadsverk_sverige|byggnad|12|15|--drop-densest-as-needed
building_points|byggnadsverk_sverige|byggnadspunkt|13|15|
building_extras_lines|byggnadsverk_sverige|byggnadsanlaggningslinje|13|15|
building_extras_points|byggnadsverk_sverige|byggnadsanlaggningspunkt|13|15|
power|ledningar_sverige|ledningslinje|10|15|
power_transformers|ledningar_sverige|transformatoromrade|12|15|
landuse|anlaggningsomrade_sverige|anlaggningsomrade|8|15|--coalesce-densest-as-needed
landuse_points|anlaggningsomrade_sverige|anlaggningsomradespunkt|11|15|
aeroway|anlaggningsomrade_sverige|flygplatsomrade|7|15|
aeroway_runway|anlaggningsomrade_sverige|start_landningsbana|9|15|
aeroway_points|anlaggningsomrade_sverige|flygplatspunkt|9|15|
protected_areas|naturvard_sverige|skyddadnatur|7|15|--coalesce-smallest-as-needed
restricted_areas|naturvard_sverige|restriktionsomrade|9|15|
naturvard_points|naturvard_sverige|naturvardspunkt|10|15|
military|militartomrade_sverige|militart_omrade|8|15|
contours|hojd_sverige|hojdlinje|12|15|--drop-densest-as-needed
contour_points|hojd_sverige|hojdpunkt|13|15|
contour_labels|hojd_sverige|hojdkurvstext|13|15|
labels|text_sverige|textobjekt|8|15|--drop-densest-as-needed
polcirkeln|norrapolcirkeln_sverige|polcirkeln|5|15|
SPECS

# --------------------------------------------------------------------------
# Steg 1: unzip
# --------------------------------------------------------------------------
echo ">> [1/5] Packar upp ZIP-leveranser till $GPKG_DIR"
for zip in "$LM_RAW_DIR"/*_sverige.zip; do
  [[ -f "$zip" ]] || { echo "   (inga zip-filer hittades i $LM_RAW_DIR)"; break; }
  base="$(basename "$zip" .zip)"
  marker="$GPKG_DIR/.unzipped.$base"
  if stage_needs_rebuild "unzip" "$marker"; then
    echo "   unzip $base"
    unzip -o -q -d "$GPKG_DIR" "$zip"
    touch "$marker"
  else
    echo "   (skip) $base redan uppackad"
  fi
done

# --------------------------------------------------------------------------
# Inventory-läge: ogrinfo per gpkg och avsluta.
# --------------------------------------------------------------------------
if [[ "$INVENTORY" -eq 1 ]]; then
  echo ">> Inventarie över $GPKG_DIR"
  for gpkg in "$GPKG_DIR"/*.gpkg; do
    [[ -f "$gpkg" ]] || continue
    echo "── $(basename "$gpkg") ──────────────────────────"
    ogrinfo -so "$gpkg" | sed -n '1,200p'
  done
  exit 0
fi

# --------------------------------------------------------------------------
# Steg 2: ogr2ogr per (gpkg, tabell) -> GeoJSONSeq i EPSG:4326
# --------------------------------------------------------------------------
echo ">> [2/5] Reprojicerar GeoPackage-tabeller till GeoJSONSeq (EPSG:4326)"

# bbox till ogr2ogr (i SWEREF99 TM = EPSG:3006 källkoordinater). Vi använder
# -spat med -spat_srs EPSG:4326 så det räcker att ange lon/lat-bbox.
SPAT_ARGS=()
if [[ -n "$BBOX" ]]; then
  IFS=',' read -r lonmin latmin lonmax latmax <<<"$BBOX"
  SPAT_ARGS=(-spat "$lonmin" "$latmin" "$lonmax" "$latmax" -spat_srs EPSG:4326)
  echo "   bbox-filter aktivt: $BBOX"
fi

VALID_SPECS=()
while IFS='|' read -r layer gpkg_base table minz maxz extra; do
  [[ -z "${layer:-}" || "$layer" =~ ^# ]] && continue
  gpkg="$GPKG_DIR/${gpkg_base}.gpkg"
  if [[ ! -f "$gpkg" ]]; then
    echo "   (skip) $layer: $gpkg saknas"
    continue
  fi
  # Verifiera att tabellen finns i gpkg innan vi pluggar in den.
  if ! ogrinfo -ro -q "$gpkg" | awk '{print $2}' | grep -qx "$table"; then
    echo "   (skip) $layer: tabell '$table' finns inte i $(basename "$gpkg")"
    continue
  fi
  out="$GEOJSON_DIR/${layer}.geojsonl"
  if stage_needs_rebuild "geojson" "$out"; then
    echo "   ogr2ogr $layer ($(basename "$gpkg"):$table)"
    tmp="${out}.tmp"
    rm -f "$tmp"
    ogr2ogr -f GeoJSONSeq -t_srs EPSG:4326 \
      -lco RS=NO \
      "${SPAT_ARGS[@]}" \
      "$tmp" "$gpkg" "$table"
    mv "$tmp" "$out"
  else
    echo "   (skip) $layer redan exporterad"
  fi
  VALID_SPECS+=("$layer|$minz|$maxz|$extra")
done <<<"$LAYER_SPECS"

# --------------------------------------------------------------------------
# Steg 3: tippecanoe per lager
# --------------------------------------------------------------------------
echo ">> [3/5] Bygger MVT-mbtiles per lager"
for spec in "${VALID_SPECS[@]}"; do
  IFS='|' read -r layer minz maxz extra <<<"$spec"
  src="$GEOJSON_DIR/${layer}.geojsonl"
  out="$MBTILES_DIR/${layer}.mbtiles"
  if [[ ! -s "$src" ]]; then
    echo "   (skip) $layer: tom geojsonl-fil"
    continue
  fi
  if stage_needs_rebuild "mvt" "$out"; then
    echo "   tippecanoe $layer (z$minz-$maxz)"
    rm -f "$out"
    # shellcheck disable=SC2086
    tippecanoe -o "$out" \
      -l "$layer" \
      -Z "$minz" -z "$maxz" \
      --no-tile-compression \
      --force \
      --read-parallel \
      $extra \
      "$src"
  else
    echo "   (skip) $layer mbtiles redan byggd"
  fi
done

# --------------------------------------------------------------------------
# Steg 4: tile-join
# --------------------------------------------------------------------------
echo ">> [4/5] Slår ihop alla lager till $MERGED_MBTILES"
if stage_needs_rebuild "join" "$MERGED_MBTILES"; then
  rm -f "$MERGED_MBTILES"
  tile-join -o "$MERGED_MBTILES" \
    --no-tile-compression \
    --attribution "© Lantmäteriet (CC BY 4.0)" \
    --name "Kartvertyget – Lantmäteriet Topografi 10" \
    "$MBTILES_DIR"/*.mbtiles
else
  echo "   (skip) merged mbtiles finns redan"
fi

# --------------------------------------------------------------------------
# Steg 5: pmtiles convert
# --------------------------------------------------------------------------
echo ">> [5/5] Konverterar till PMTiles -> $OUT_PMTILES"
if stage_needs_rebuild "pmtiles" "$OUT_PMTILES"; then
  rm -f "$OUT_PMTILES"
  pmtiles convert "$MERGED_MBTILES" "$OUT_PMTILES"
  pmtiles show "$OUT_PMTILES" | sed -n '1,40p'
else
  echo "   (skip) $OUT_PMTILES finns redan"
fi

echo "Klart: $OUT_PMTILES ($(du -sh "$OUT_PMTILES" | cut -f1))"

#!/usr/bin/env bash
# Bygger data/sweden-terrain.pmtiles från Sonny's LiDAR-DTM för Sverige.
#
# Beroenden (rekommenderat via conda/mamba eller pip):
#   pip install rasterio rio-rgbify
#   brew install gdal pmtiles   # för gdal_translate och pmtiles convert
#
# Manuellt steg:
#   1. Ladda ner Sweden-täckande GeoTIFF-paneler från https://sonny.4lima.de/
#      och lägg dem under data/raw/sonny/.
#   2. Kör detta skript.
#
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_DIR="data"
RAW_DIR="$DATA_DIR/raw/sonny"
MERGED="$DATA_DIR/raw/sweden-dem-merged.tif"
RGB="$DATA_DIR/raw/sweden-terrain-rgb.tif"
MBTILES="$DATA_DIR/raw/sweden-terrain.mbtiles"
OUT="$DATA_DIR/sweden-terrain.pmtiles"

if [ ! -d "$RAW_DIR" ] || [ -z "$(ls -A "$RAW_DIR" 2>/dev/null)" ]; then
  echo "Fel: lägg Sonny GeoTIFF-paneler i $RAW_DIR först."
  exit 1
fi

echo ">> Slår ihop DEM-paneler …"
gdal_merge.py -o "$MERGED" -of GTiff -co COMPRESS=DEFLATE -co TILED=YES "$RAW_DIR"/*.tif

echo ">> Konverterar till terrain-RGB (Mapbox-encoding) …"
rio rgbify -b -10000 -i 0.1 "$MERGED" "$RGB"

echo ">> Bygger MBTiles (z 6-12) …"
gdal_translate -of mbtiles "$RGB" "$MBTILES" -co TILE_FORMAT=PNG -co RESAMPLING=BILINEAR
gdaladdo -r bilinear "$MBTILES" 2 4 8 16 32 64

echo ">> Konverterar till PMTiles …"
pmtiles convert "$MBTILES" "$OUT"

echo "Klart: $OUT"

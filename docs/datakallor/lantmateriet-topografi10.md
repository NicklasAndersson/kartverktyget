# Implementationsförslag: Topografi 10 som alternativ datakälla

> **OBS — designdokument.** Det här är ett bakgrunds- och schemadokument
> (lagermappning, val av tippecanoe-flaggor, motiveringar). Den faktiska
> byggrutinen — skript, Hetzner-runbook, snapshot-/resume-flöde,
> `.env`-variabler — finns i [lantmateriet-remote-build.md](lantmateriet-remote-build.md).

Det här dokumentet beskriver hur Lantmäteriets produkt **Topografi 10
Nedladdning, vektor** ([GEODOK/51][geodok51]) används som alternativ
datakälla i Fältkarta Pro, samt vad som återstår innan flödet är komplett.

> **Status (2026-05-27):** En fungerande Sverige-täckande PMTiles-pipeline
> finns på fjärrservern (`root@178.105.223.176`). Filen
> `data/sweden-lm.pmtiles` (~18 GB, z5–15, 38 vector-layers) byggs av
> [scripts/build-lm-pmtiles.sh](../../scripts/build-lm-pmtiles.sh), serveras
> av Caddy via `http://178.105.223.176:8080/sweden-lm.pmtiles` och
> konsumeras av MapLibre i webben via stilen
> [apps/web/public/styles/lantmateriet-topo10.json](../../apps/web/public/styles/lantmateriet-topo10.json).
> Råleveransen ligger lokalt under
> [data/raw/lantmäteriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259/](../../data/raw/lantm%C3%A4teriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259/)
> samt som spegling på servern (`/root/kvg/data/raw/lm/`).
>
> **Drift:** Bygget körs på en fjärrserver eftersom det kräver ~40 GB disk
> och flera GB RAM. Se
> [lantmateriet-remote-build.md](lantmateriet-remote-build.md) för hur
> [scripts/build-lm-pmtiles-remote.sh](../../scripts/build-lm-pmtiles-remote.sh)
> sköter rsync, nohup-bygge och publicering.

[geodok51]: https://geotorget.lantmateriet.se/dokumentation/GEODOK/51/latest.html

---

## Innehåll

- [Nuvarande implementation](#nuvarande-implementation)
- [Översikt](#översikt)
- [Levererad data](#levererad-data)
- [Jämförelse mot nuvarande källa](#jämförelse-mot-nuvarande-källa)
- [Förutsättningar](#förutsättningar)
- [Datapipeline](#datapipeline)
- [Lagermappning](#lagermappning)
- [Höjddata och höjdkurvor](#höjddata-och-höjdkurvor)
- [Stilfil](#stilfil)
- [Integration i webb och API](#integration-i-webb-och-api)
- [Juridik och drift](#juridik-och-drift)
- [Hybridstrategi](#hybridstrategi)
- [Stegvis införande](#stegvis-införande)
- [Öppna frågor och risker](#öppna-frågor-och-risker)

---

## Nuvarande implementation

Den här sektionen dokumenterar det som faktiskt fungerar idag och hur det
hänger ihop. Övriga sektioner längre ner är ursprungligt designdokument –
sparat som teknisk referens.

### Komponenter

| Komponent | Plats | Roll |
|---|---|---|
| Råleverans (zip-paket) | `data/raw/lantmäteriet/bb7631cc-.../`, speglat till `/root/kvg/data/raw/lm/` på servern | Lantmäteriets GeoPackage-paket, ett per tema |
| Bygg-skript | [scripts/build-lm-pmtiles.sh](../../scripts/build-lm-pmtiles.sh) | Hela pipelinen från zip → pmtiles |
| Fjärr-orchestrering | [scripts/build-lm-pmtiles-remote.sh](../../scripts/build-lm-pmtiles-remote.sh) | rsync av script + nohup-körning på server |
| PMTiles på servern | `/root/kvg/data/sweden-lm.pmtiles` (18 GB) | Outputfil, exponerad via symlink `/srv/tiles/sweden-lm.pmtiles` |
| Caddy | `:8080`, dokumentrot `/srv/tiles` | Range-stöd, CORS `*` – krav för pmtiles-protokollet i webbläsaren |
| Stilfil | [apps/web/public/styles/lantmateriet-topo10.json](../../apps/web/public/styles/lantmateriet-topo10.json) | MapLibre-stil som pekar `pmtiles://http://178.105.223.176:8080/sweden-lm.pmtiles` |
| pmtiles-protokoll | [apps/web/src/map/MapView.tsx](../../apps/web/src/map/MapView.tsx) (modul-toppnivå) | Registrerar `Protocol().tile` mot `maplibregl.addProtocol('pmtiles', …)` |
| Källval | `mapSource: 'osm' \| 'lm'` i [apps/web/src/state/store.ts](../../apps/web/src/state/store.ts) | Dropdown i Sidebar väljer stil-URL |
| Render-API | [apps/api/src/render/engine.ts](../../apps/api/src/render/engine.ts) (`styleFile` baserat på `mapSource`) | PDF-renderaren använder samma stil |

### Bygg-pipeline (steg-för-steg)

Skriptet [scripts/build-lm-pmtiles.sh](../../scripts/build-lm-pmtiles.sh) är
**idempotent**: varje steg har en marker- eller utdatafil och hoppas över om
den redan finns. Detta gör att man kan köra om skriptet utan att bygga om
allt.

1. **Unzip** – `$LM_RAW_DIR/*_sverige.zip` → `data/stage/lm/gpkg/*.gpkg`.
   Marker: `data/stage/lm/gpkg/.unzipped.<paket>`. 11 GeoPackage-filer (en
   per tema).
2. **ogr2ogr** – per (gpkg, tabell) i `LAYER_SPECS`-tabellen reprojiceras
   från SWEREF99 TM (EPSG:3006) till WGS84 (EPSG:4326) och skrivs som
   GeoJSONSeq till `data/stage/lm/geojsonl/<lager>.geojsonl`. Skapas bara
   om filen saknas.
3. **tippecanoe** – per lager byggs en `.mbtiles` i
   `data/stage/lm/mbtiles/<lager>.mbtiles` med zoom-intervall och
   simplifierings-flaggor från `LAYER_SPECS`. Skapas bara om mbtiles saknas.
4. **tile-join** – alla `mbtiles` slås ihop till
   `data/stage/lm/sweden-lm.mbtiles` med attribuering `© Lantmäteriet
   (CC BY 4.0)`. Skapas bara om merged-mbtiles saknas.
5. **pmtiles convert** – mbtiles → `data/sweden-lm.pmtiles`. Tempfil läggs
   under `data/stage/lm/tmp/` (`--tmpdir`) för att slippa att `/tmp`
   tmpfs:en svämmar över. Skapas bara om pmtiles saknas.

### Köra om delar av bygget

| Vad du vill | Kommando |
|---|---|
| Endast bygga lager som saknas (default) | `./scripts/build-lm-pmtiles.sh` |
| Tvinga om ett enskilt steg | `./scripts/build-lm-pmtiles.sh --force-stage=mvt` (eller `unzip` / `geojson` / `join` / `pmtiles`) |
| Tvinga om allt | `./scripts/build-lm-pmtiles.sh --force` |
| Bygg om ett specifikt lager | Radera `data/stage/lm/mbtiles/<lager>.mbtiles` + `data/stage/lm/sweden-lm.mbtiles` + `data/sweden-lm.pmtiles`, kör skriptet igen. (Om även geojsonl ska byggas om: radera även `data/stage/lm/geojsonl/<lager>.geojsonl`.) |
| Lägga till nytt lager | Lägg en rad i `LAYER_SPECS`-blocket i skriptet, radera merged-mbtiles + pmtiles, kör skriptet igen. |
| Snabb-bygge för utveckling | `./scripts/build-lm-pmtiles.sh --bbox=17.7,59.2,18.3,59.5` (Stockholm). OBS: blandar inte med fullt bygge — rensa stage först. |
| Inventera schema | `./scripts/build-lm-pmtiles.sh --inventory` (ogrinfo per gpkg, ingen build) |

**Trigger-fil per steg**:

| Steg | Hoppas över om… |
|---|---|
| unzip | `data/stage/lm/gpkg/.unzipped.<paket>` finns |
| geojson | `data/stage/lm/geojsonl/<lager>.geojsonl` finns |
| mvt | `data/stage/lm/mbtiles/<lager>.mbtiles` finns |
| join | `data/stage/lm/sweden-lm.mbtiles` finns |
| pmtiles | `data/sweden-lm.pmtiles` finns |

Borttag av en fil längs vägen får alla nedströms-steg att köras om
nästa gång, men föregående steg återanvänds.

### Lager i nuvarande pmtiles (38 st)

Mappningen finns i `LAYER_SPECS`-blocket i
[scripts/build-lm-pmtiles.sh](../../scripts/build-lm-pmtiles.sh). Formatet
är `<lager-id>|<gpkg-basnamn>|<tabell>|<minzoom>|<maxzoom>|<extra-tippecanoe-args>`.

| Lager-id | GeoPackage:tabell | Zoom | Tippecanoe-extras |
|---|---|---|---|
| `earth` | `mark_sverige:mark` | 5–10 | `--exclude-all --coalesce --simplification=12 --maximum-tile-bytes=300000 --drop-densest-as-needed` |
| `landcover` | `mark_sverige:mark` | 9–15 | `--coalesce-smallest-as-needed --maximum-tile-bytes=800000` |
| `landcover_wet` | `mark_sverige:sankmark` | 9–15 | `--coalesce-smallest-as-needed` |
| `land_edges` | `mark_sverige:markkantlinje` | 11–15 | `--drop-densest-as-needed` |
| `water` | `hydro_sverige:hydrolinje` | 7–15 | `--drop-densest-as-needed` |
| `watercourses` | `hydro_sverige:hydroanlaggningslinje` | 9–15 | `--drop-densest-as-needed` |
| `water_points` | `hydro_sverige:hydropunkt` | 10–15 | `--drop-densest-as-needed` |
| `water_intressanta` | `hydro_sverige:hydrografiskt_intressant_plats` | 10–15 | – |
| `water_anlaggningspunkt` | `hydro_sverige:hydroanlaggningspunkt` | 10–15 | – |
| `roads` | `kommunikation_sverige:vaglinje` | 8–15 | `--drop-densest-as-needed` |
| `roads_minor` | `kommunikation_sverige:ovrig_vag` | 10–15 | `--drop-densest-as-needed` |
| `trails` | `kommunikation_sverige:transportled_fjall` | 10–15 | – |
| `trail_points` | `kommunikation_sverige:ledintressepunkt_fjall` | 11–15 | – |
| `ferry` | `kommunikation_sverige:farjeled` | 8–15 | – |
| `road_points` | `kommunikation_sverige:vagpunkt` | 11–15 | – |
| `rail` | `kommunikation_sverige:ralstrafik` | 7–15 | – |
| `rail_stations` | `kommunikation_sverige:ralstrafikstation` | 9–15 | – |
| `buildings` | `byggnadsverk_sverige:byggnad` | 12–15 | `--drop-densest-as-needed` |
| `building_points` | `byggnadsverk_sverige:byggnadspunkt` | 13–15 | – |
| `building_extras_lines` | `byggnadsverk_sverige:byggnadsanlaggningslinje` | 13–15 | – |
| `building_extras_points` | `byggnadsverk_sverige:byggnadsanlaggningspunkt` | 13–15 | – |
| `power` | `ledningar_sverige:ledningslinje` | 10–15 | – |
| `power_transformers` | `ledningar_sverige:transformatoromrade` | 12–15 | – |
| `landuse` | `anlaggningsomrade_sverige:anlaggningsomrade` | 8–15 | `--coalesce-densest-as-needed` |
| `landuse_points` | `anlaggningsomrade_sverige:anlaggningsomradespunkt` | 11–15 | – |
| `aeroway` | `anlaggningsomrade_sverige:flygplatsomrade` | 7–15 | – |
| `aeroway_runway` | `anlaggningsomrade_sverige:start_landningsbana` | 9–15 | – |
| `aeroway_points` | `anlaggningsomrade_sverige:flygplatspunkt` | 9–15 | – |
| `protected_areas` | `naturvard_sverige:skyddadnatur` | 7–15 | `--coalesce-smallest-as-needed` |
| `restricted_areas` | `naturvard_sverige:restriktionsomrade` | 9–15 | – |
| `naturvard_points` | `naturvard_sverige:naturvardspunkt` | 10–15 | – |
| `military` | `militartomrade_sverige:militart_omrade` | 8–15 | – |
| `contours` | `hojd_sverige:hojdlinje` | 12–15 | `--drop-densest-as-needed` |
| `contour_points` | `hojd_sverige:hojdpunkt` | 13–15 | – |
| `contour_labels` | `hojd_sverige:hojdkurvstext` | 13–15 | – |
| `labels` | `text_sverige:textobjekt` | 8–15 | `--drop-densest-as-needed` |
| `polcirkeln` | `norrapolcirkeln_sverige:polcirkeln` | 5–15 | – |

PMTiles-headern visar `minzoom=5`, `maxzoom=15`, bounds
`9.13,54.95 → 24.95,69.15`. Tile-data: MVT, gzip-komprimerad.

### Stilen (lantmateriet-topo10.json)

Stilfilen är ren MapLibre v8. Toppen pekar `lm`-källan på remote-pmtiles:

```json
"sources": {
  "lm": {
    "type": "vector",
    "url": "pmtiles://http://178.105.223.176:8080/sweden-lm.pmtiles",
    "attribution": "© Lantmäteriet (CC BY 4.0)"
  }
}
```

Glyfer hämtas från `https://protomaps.github.io/basemaps-assets/fonts/...`
(samma som övriga stilar). Fonts som faktiskt används:
`Noto Sans Regular`, `Noto Sans Italic` (testat – `Noto Sans Bold` saknas
på CDN:en och bör undvikas).

39 lager renderas (i ordning underifrån):

1. `background` – fyllfärg `#f5f0e6`
2. `earth` – `mark_sverige:mark` polygoner, fyllfärg `#f3ecdc`
3. `landcover-*` – skog, åker, öppen mark, glaciär, byggd mark, kvarter, vatten
4. `landcover-wet` – sankmark
5. `landuse`, `protected-areas`, `aeroway-area`
6. `land-edges` – stranddetaljer
7. `water-lines`, `watercourses`
8. `contours-minor`, `contours-major` – LM-höjdkurvor (linjer)
9. **`contour-labels`** – höjdvärden från `contour_labels`-lagret
10. `buildings`, `power`, `ferry`, `rail-*`, `trails-*`, `roads-*`,
   `aeroway-runway`
11. **`labels-large`** – ortsnamn (`thojd ≥ 14`) från z8
12. **`labels-medium`** – kvarters-/områdesnamn (`thojd 10–13`) från z11
13. **`labels-small`** – gatu-/detaljtext (`thojd < 10`) från z13

Textstorlek skalas med `thojd` (Lantmäteriets rekommenderade höjd i
millimeter), och rotation tas från `trikt`-fältet (grader).

### Höjdkurv-toggle (UI ⇄ MapView)

Tidigare lade `contours`-checkboxen i sidofältet **bara** till ett DEM-overlay
från AWS Terrarium via `maplibre-contour`, vilket dubblerade kurvorna på LM-
stilen. Sedan 2026-05-27 har
[apps/web/src/map/MapView.tsx](../../apps/web/src/map/MapView.tsx) två
varianter beroende på `mapSource`:

- **`mapSource === 'lm'`**: togglar visibility på de tre LM-lagren
  `contours-minor`, `contours-major`, `contour-labels` via
  `setLayoutProperty('visibility', ...)`. Inget DEM-overlay läggs till.
- **Övriga källor** (protomaps/OSM m.fl.): som tidigare – `addContourLayers`
  lägger till en separat vektorkälla `kvg-contours` byggd av
  `maplibre-contour` mot terrarium-DEM.

Logiken sitter i `syncContours`-effekten samt i `restoreMapState` vid
init/style-byte. Byter man `mapSource` så råkörs effekten och rätt
toggle-mekanism aktiveras.

### Servern

| Sak | Värde |
|---|---|
| Värd | `root@178.105.223.176` (`/dev/sda1`, 301 G total, ~80 G fritt) |
| Råleverans | `/root/kvg/data/raw/lm/*.zip` |
| Stage | `/root/kvg/data/stage/lm/{gpkg,geojsonl,mbtiles,tmp}/` |
| Output | `/root/kvg/data/sweden-lm.pmtiles` (18 G) |
| HTTP-serve | Caddy på `:8080`, dokumentrot `/srv/tiles/`, symlink `/srv/tiles/sweden-lm.pmtiles → /root/kvg/data/sweden-lm.pmtiles` |
| CORS / range | `Access-Control-Allow-Origin: *`, `Accept-Ranges: bytes` (krav från pmtiles-protokollet) |
| Loggar | `/root/kvg/logs/build-<timestamp>.log`, `/root/kvg/logs/pmtiles-convert.log` |

För att verifiera att servern svarar med en giltig pmtiles-header:

```bash
curl -s -r 0-126 http://178.105.223.176:8080/sweden-lm.pmtiles -o /tmp/h.bin
xxd /tmp/h.bin | head -2   # ska börja med "PMTiles" + version-byte 3
```

### Att verifiera en specifik tile

```bash
pmtiles tile http://178.105.223.176:8080/sweden-lm.pmtiles 14 9011 4839 \
  > /tmp/tg.bin
gunzip -f -c /tmp/tg.bin > /tmp/t.mvt    # MVT är gzippad i pmtiles
# Avkoda med @mapbox/vector-tile + pbf (pbf v4 är CommonJS-default-export)
```

---



## Översikt

Topografi 10 är Lantmäteriets mest detaljerade vektorkarta, avsedd för
skalområdet 1:1 000 – 1:20 000. Den passar utmärkt som bakgrundskarta för
fältbruk och täcker bland annat:

- **Byggnader** och byggnadsverk
- **Markslag** (skog, öppen mark, våtmark, åker m.m.)
- **Vägar och stigar** med klassindelning (inkl. fjälleder)
- **Hydrografi** (vattenytor, vattendrag, stränder)
- **Ortnamn** ur Lantmäteriets ortnamnsregister
- **Höjddata** (höjdkurvor, höjdpunkter, höjdkurvstext)
- **Anläggningsområden, ledningar, naturvård, militära områden**

Produkten är **avgiftsfri** under [Creative Commons BY 4.0][cc-by]. Den levereras
som nedladdning via Geotorget, antingen som engångsuttag eller som abonnemang
med inkrementella leveranser. Det förproducerade lagret uppdateras veckovis.

[cc-by]: https://creativecommons.org/licenses/by/4.0/

## Levererad data

Aktuellt uttag (order `89442a66-f71b-46b6-8f5f-70cf89f449c4`, uttagsidentitet
`bb7631cc-81ee-4bd0-aa8b-2a23714cb259`) ligger i
[data/raw/lantmäteriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259/](../../data/raw/lantm%C3%A4teriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259/)
och innehåller följande Sverige-täckande GeoPackage-paket samt en
[uttag.json](../../data/raw/lantm%C3%A4teriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259/uttag.json)
med statistik per tabell och täckningspolygon.

| Fil | Tabeller (urval) | Antal objekt (urval) | Föreslagen användning |
|---|---|---|---|
| `byggnadsverk_sverige.zip` | `byggnad`, `byggnadspunkt`, `byggnadsanlaggningslinje`, `byggnadsanlaggningspunkt` | 9 473 619 byggnader | `buildings` |
| `mark_sverige.zip` | `mark`, `sankmark`, `markkantlinje` | – | `landcover`, `earth` |
| `hydro_sverige.zip` | `hydrolinje`, `hydroanlaggningslinje`, `hydroanlaggningspunkt`, `hydropunkt`, `hydrografiskt_intressant_plats` | – | `water`, `watercourses` |
| `kommunikation_sverige.zip` | `vaglinje`, `ovrig_vag` (663 870), `transportled_fjall`, `ledintressepunkt_fjall`, `farjeled`, `vagpunkt`, `ralstrafik`, `ralstrafikstation` | – | `roads`, `trails`, `rail` |
| `ledningar_sverige.zip` | `ledningslinje`, `transformatoromrade` | – | `power` (nytt lager) |
| `anlaggningsomrade_sverige.zip` | `anlaggningsomrade`, `anlaggningsomradespunkt`, `start_landningsbana`, `flygplatsomrade`, `flygplatspunkt` | – | `landuse` / `aeroway` |
| `naturvard_sverige.zip` | `skyddadnatur`, `restriktionsomrade`, `naturvardspunkt` | – | `protected_areas` (nytt lager) |
| `militartomrade_sverige.zip` | `militart_omrade` | – | `landuse` (militärt) |
| `hojd_sverige.zip` | `hojdlinje` (5 576 429), `hojdpunkt` (33 783), `hojdkurvstext` (767 370) | – | `contours`, ersätter AWS Terrarium |
| `text_sverige.zip` | `textobjekt` | – | `places` / `labels` |
| `norrapolcirkeln_sverige.zip` | `polcirkeln` | – | dekorativt lager |

> **Schemaobservation:** Tabellnamnen i den faktiska leveransen (`byggnad`,
> `mark`, `vaglinje`, `hydrolinje`, `textobjekt`, …) är något enklare än vad
> dokumentationssidan för Topografi 10 2026.05 antyder (`byggnadsverk`,
> `markyta`, …). Lagermappningen nedan utgår från de **faktiska** tabellnamnen
> i leveransen — verifiera produktversion mot `ogrinfo` innan stilfilen
> färdigställs.
>
> Leveransen saknar `admindelning_sverige.zip`, `markreglering_sverige.zip`,
> `rattighet_sverige.zip` och `fastighet_sverige.zip` som listas i
> `uttag.json` — beställ separat om administrativa gränser eller
> fastighetsinformation behövs.

## Jämförelse mot nuvarande källa

| Egenskap | OSM/Protomaps (nuvarande) | Topografi 10 |
|---|---|---|
| Källa | OpenStreetMap via Protomaps planet-build | Lantmäteriet, Geotorget |
| Täckning | Hela världen (vi extraherar Sveriges bbox) | Endast Sverige |
| Noggrannhet | Crowd-sourcad, varierar | Myndighetsdata, 1:10 000 |
| Aktualitet | Daglig planet-build | Veckovis förproducerat lager |
| Skala | Universellt schema, zoom 0–15 | Optimerad för 1:1 000–1:20 000 |
| Vägklasser | OSM-taggar (`highway=*`) | Lantmäteriets klassificering |
| Stigar i fjäll/skog | Begränsad täckning | God täckning (`transportled_fjall`) |
| Byggnader | OSM (varierar) | 9,4 miljoner, heltäckande |
| Höjdkurvor | AWS Terrarium (extern) | Inkluderat (5,6M `hojdlinje`) |
| Ortnamn | OSM `name`-taggar | Fastställda namn i Ortnamnsregistret |
| Licens | ODbL | CC BY 4.0 |
| Format | MVT i PMTiles | GeoPackage (SWEREF99 TM) |
| Storlek (PMTiles, Sverige) | ~3 GB | Uppskattning 8–15 GB |
| Pris | Gratis | Avgiftsfri |
| Konto krävs | Nej | Ja, Geotorget |

## Förutsättningar

1. **Geotorget-konto** med godkända användarvillkor för GEODOK/51 *(redan
   uppfyllt — uttag finns lokalt)*.
2. **Beställning** av produkten — engångsuttag finns redan, abonnemang krävs
   för framtida automatiska uppdateringar.
3. **API-credentials** (OAuth2 client credentials) — behövs först när
   pipelinen ska automatiseras för veckovis uppdatering. Skapas under *Mitt
   konto → API-nycklar*. Tills dess kan steg 1 i pipelinen hoppas över.
4. **Miljövariabler** (läggs i `.env`, ej committas):

   ```env
   LM_CLIENT_ID=...
   LM_CLIENT_SECRET=...
   LM_ORDER_ID=89442a66-f71b-46b6-8f5f-70cf89f449c4
   LM_TOKEN_URL=https://api.lantmateriet.se/token
   LM_DOWNLOAD_BASE=https://api.lantmateriet.se/geotorget/orderhanterare/v2
   LM_RAW_DIR=data/raw/lantmäteriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259
   ```

5. **Verktyg**:
   - `gdal` ≥ 3.8 (`ogr2ogr`) för läsning av GeoPackage och omprojektion
   - `tippecanoe` ≥ 2.40 för MVT-generering
   - `pmtiles` CLI för konvertering MBTiles → PMTiles
   - `curl`, `jq`, `unzip` för API-anrop och uppackning

   På macOS:
   ```bash
   brew install gdal tippecanoe pmtiles jq
   ```

## Datapipeline

Ett nytt skript `scripts/build-lm-pmtiles.sh` läggs vid sidan av befintliga
[scripts/build-pmtiles.sh](../../scripts/build-pmtiles.sh). Skriptet följer
samma struktur (utskrift `>>`, `set -euo pipefail`, output i `data/`) och bör
vara idempotent så att man kan köra det iterativt under utveckling.

### Steg

1. **(Valfritt) Hämta ny leverans** — hoppas över så länge
   `$LM_RAW_DIR/uttag.json` redan finns. För framtida automatisering:

   ```bash
   TOKEN=$(curl -s -u "$LM_CLIENT_ID:$LM_CLIENT_SECRET" \
     -d "grant_type=client_credentials" \
     "$LM_TOKEN_URL" | jq -r .access_token)
   # POST mot order-API för att trigga ny leverans, polla status,
   # ladda ner alla *_sverige.zip till $LM_RAW_DIR
   ```

2. **Packa upp** ZIP-filerna till `data/stage/lm/gpkg/`:

   ```bash
   STAGE="data/stage/lm"
   mkdir -p "$STAGE/gpkg"
   for zip in "$LM_RAW_DIR"/*_sverige.zip; do
     unzip -o -d "$STAGE/gpkg" "$zip"
   done
   ```

   Resulterar i en uppsättning `.gpkg`-filer, en per tema.

3. **Inventera schema** med `ogrinfo` för att bekräfta tabell- och
   attributnamn innan konvertering:

   ```bash
   ogrinfo -al -so "$STAGE/gpkg/byggnadsverk_sverige.gpkg" byggnad
   ```

4. **Reprojicera och exportera per tabell** från SWEREF99 TM (EPSG:3006) till
   WGS84 (EPSG:4326) med `ogr2ogr`. GeoJSONSeq (NDJSON) är effektivast som
   input till `tippecanoe`:

   ```bash
   ogr2ogr -f GeoJSONSeq -t_srs EPSG:4326 \
     "$STAGE/byggnad.geojsonl" \
     "$STAGE/gpkg/byggnadsverk_sverige.gpkg" byggnad
   ```

   Loopas över alla relevanta `(gpkg, tabell)`-par enligt
   [Lagermappning](#lagermappning) nedan.

5. **Bygg MVT** med `tippecanoe` per logiskt MapLibre-källskikt:

   ```bash
   tippecanoe -o "$STAGE/buildings.mbtiles" \
     -l buildings -Z 12 -z 15 --drop-densest-as-needed \
     --no-tile-compression \
     "$STAGE/byggnad.geojsonl"
   ```

6. **Slå ihop** alla mbtiles med `tile-join`:

   ```bash
   tile-join -o "$STAGE/sweden-lm.mbtiles" "$STAGE"/*.mbtiles
   ```

7. **Konvertera till PMTiles**:

   ```bash
   pmtiles convert "$STAGE/sweden-lm.mbtiles" data/sweden-lm.pmtiles
   pmtiles show data/sweden-lm.pmtiles
   ```

### Zoomstrategi

Matchas mot dagens pipeline (minzoom 0, maxzoom 15). Förslag per lager:

| Lager | minzoom | maxzoom | Motivering |
|---|---|---|---|
| `earth`, `landcover`, `water` | 5 | 15 | Bakgrund även vid låg zoom |
| `roads`, `watercourses`, `rail` | 8 | 15 | Linjenät |
| `trails` (`transportled_fjall`, `ovrig_vag`) | 10 | 15 | Detaljerat |
| `contours`, `buildings`, `power` | 12 | 15 | Hög detalj |
| `labels`, `places` (`textobjekt`) | 6 | 15 | Skiktas via `textstorlek` |

## Lagermappning

Tabellnamnen nedan är hämtade direkt ur den lokala leveransens
[uttag.json](../../data/raw/lantm%C3%A4teriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259/uttag.json).
Lager-id:n speglar dagens Protomaps-schema där det är möjligt, så att
befintliga stilfiler kan ges LM-varianter med minimala ändringar.

| Källskikt (PMTiles) | GeoPackage | Tabell(er) | Filter / nyckelattribut |
|---|---|---|---|
| `earth` | `mark_sverige.gpkg` | `mark` | bakgrundsdissolved |
| `landcover` | `mark_sverige.gpkg` | `mark`, `sankmark` | `objekttyp` (skog, åker, fjäll, sankmark, …) |
| `water` | `hydro_sverige.gpkg` | `hydrolinje` (ytor via polygonisering) | `objekttyp` |
| `watercourses` | `hydro_sverige.gpkg` | `hydrolinje`, `hydroanlaggningslinje` | `objekttyp` |
| `water_points` | `hydro_sverige.gpkg` | `hydropunkt`, `hydrografiskt_intressant_plats`, `hydroanlaggningspunkt` | `objekttyp` |
| `roads` | `kommunikation_sverige.gpkg` | `vaglinje`, `ovrig_vag` | `objekttyp` (motorväg → enskild väg) |
| `trails` | `kommunikation_sverige.gpkg` | `transportled_fjall`, `ledintressepunkt_fjall`, `farjeled` | `objekttyp` |
| `rail` | `kommunikation_sverige.gpkg` | `ralstrafik`, `ralstrafikstation` | `objekttyp` |
| `road_points` | `kommunikation_sverige.gpkg` | `vagpunkt` | `objekttyp` |
| `buildings` | `byggnadsverk_sverige.gpkg` | `byggnad` | `objekttyp`, `andamal` |
| `building_extras` | `byggnadsverk_sverige.gpkg` | `byggnadspunkt`, `byggnadsanlaggningslinje`, `byggnadsanlaggningspunkt` | `objekttyp` |
| `power` | `ledningar_sverige.gpkg` | `ledningslinje`, `transformatoromrade` | `objekttyp`, `spanningsniva` |
| `landuse` | `anlaggningsomrade_sverige.gpkg` | `anlaggningsomrade`, `anlaggningsomradespunkt` | `objekttyp` |
| `aeroway` | `anlaggningsomrade_sverige.gpkg` | `flygplatsomrade`, `flygplatspunkt`, `start_landningsbana` | `objekttyp` |
| `protected_areas` | `naturvard_sverige.gpkg` | `skyddadnatur`, `restriktionsomrade`, `naturvardspunkt` | `objekttyp`, `skyddstyp` |
| `military` | `militartomrade_sverige.gpkg` | `militart_omrade` | – |
| `contours` | `hojd_sverige.gpkg` | `hojdlinje` | `hojd` + härlett `index` (`hojd % 100 == 0`) |
| `contour_points` | `hojd_sverige.gpkg` | `hojdpunkt` | `hojd` |
| `contour_labels` | `hojd_sverige.gpkg` | `hojdkurvstext` | `text`, `hojd` |
| `places` / `labels` | `text_sverige.gpkg` | `textobjekt` | `texttyp`, `textstorlek` |
| `polcirkeln` | `norrapolcirkeln_sverige.gpkg` | `polcirkeln` | dekorativt |

> Administrativa gränser (`admindelning_sverige.zip`) ingår inte i leveransen
> men kan beställas separat och mappas till ett `boundaries`-lager med
> `lansyta` och `kommunyta`.

## Höjddata och höjdkurvor

`hojd_sverige.zip` innehåller färdiga höjdkurvor som linjegeometrier. Detta
öppnar för att ersätta dagens beroende av AWS Terrarium + `maplibre-contour`
när `mapSource === 'lm'` är aktivt:

- **Fördelar**: ingen extern beroendekedja, samma cache som baskartan, korrekt
  attribuering, konsekvent renderad även offline.
- **Genomförande**:
  1. Bygg `contours`-lagret i `sweden-lm.pmtiles` med ett `hojd`-attribut
     plus ett härlett `index`-attribut (`hojd % 100 == 0`) för indexkurvor.
  2. Generera `contour_labels` från `hojdkurvstext` med rotation från
     tabellens orientering, om sådan finns.
  3. Lägg till två symbol-/linjelager i stilfilen som speglar dagens
     index/mellankurv-lager.
  4. När `mapSource === 'lm'` är aktivt: hoppa över `maplibre-contour`-
     källan i [apps/web/src/map/MapView.tsx](../../apps/web/src/map/MapView.tsx)
     och låt PMTiles-lagret stå för kurvorna.

> **OSM-läget** behåller `maplibre-contour` så att höjdkurvor fungerar utan
> svensk specialdata.

## Stilfil

En ny stil `apps/web/public/styles/lantmateriet-topo10.json` skapas baserat på
[apps/web/public/styles/friluft.json](../../apps/web/public/styles/friluft.json)
(för färg) och
[apps/web/public/styles/sw-laser.json](../../apps/web/public/styles/sw-laser.json)
(för laser-/svartvitt). Eftersom källskikten heter samma som i Protomaps-
stilen behövs främst:

- Justerade `filter` mot LM:s attributnamn (`objekttyp` istället för `kind`)
- Färgjusteringar för markslag som inte finns i OSM (t.ex. `sankmark`,
  `fjall`, `kalfjall`)
- Egna lager för `trails` (fjällederna), `power`, `protected_areas`,
  `military` och `polcirkeln`
- Bibehållna glyfer: `Noto Sans Regular`, `Noto Sans Medium`, `Noto Sans
  Italic` (kompatibelt med Protomaps CDN, se fotnot[^1])
- Käll-id `sweden-lm` mot `/tiles/sweden-lm.json`

[^1]: Tidigare problem: hostade `Noto Sans Bold` returnerade 404 och blankade
  stilen. Behåll därför endast Regular/Medium/Italic.

## Integration i webb och API

### API ([apps/api/src/tiles.ts](../../apps/api/src/tiles.ts))

Tile-proxyn utökas att servera flera PMTiles-filer parallellt:

- Ny route: `/tiles/sweden-lm/{z}/{x}/{y}.mvt`
- Ny TileJSON: `/tiles/sweden-lm.json`
- Befintlig route `/tiles/sweden.*` lämnas oförändrad

Källfilen styrs av URL-segmentet, inte av query-parameter, så att MapLibres
TileJSON-resolver fungerar utan extra konfiguration.

### Webb ([apps/web/src/state/store.ts](../../apps/web/src/state/store.ts))

Nytt fält i Zustand-storen:

```ts
mapSource: 'osm' | 'lm';   // default 'osm'
```

Persistat i `localStorage` på samma sätt som `styleUrl`. `MapView` väljer
stilfil utifrån kombinationen (`mapSource`, `styleVariant`).

### UI ([apps/web/src/ui/Sidebar.tsx](../../apps/web/src/ui/Sidebar.tsx))

Ny dropdown *Datakälla* med två val: **OpenStreetMap** och **Lantmäteriet
Topografi 10**. Vid byte triggas samma `map.setStyle(url, { diff: false })`
som vid stilbyte, och hjälplager (MGRS, atlas, GPX, kontur) återställs på
`style.load`/`idle` enligt befintligt mönster.

### Render-pipeline ([apps/api/src/render/route.ts](../../apps/api/src/render/route.ts))

`AtlasRenderRequest` utökas med `mapSource` så PDF använder samma källa som
webbvyn. Render-sidan ([apps/api/src/render/page/index.html](../../apps/api/src/render/page/index.html))
läser fältet och väljer rätt stil-URL. Detta är ett krav för WYSIWYG mellan
webb och PDF.

### Attribuering

Kart-foten i både webb och PDF kompletteras med `© Lantmäteriet (CC BY 4.0)`
när `mapSource === 'lm'` är aktivt. Implementeras i:

- `apps/web/src/map/MapView.tsx` – MapLibre `attributionControl`
- `apps/api/src/render/decorations.ts` – PDF-fottext

## Juridik och drift

- **Licens**: CC BY 4.0. Attribuering `© Lantmäteriet` är obligatorisk i
  alla publicerade kartor (skärm, PDF, tryck).
- **Vidaredistribution**: tillåten under samma licens. PMTiles-filen får
  hostas, men källan måste anges på alla nedladdningssidor.
- **Användarvillkor**: Geotorget kräver att din användning prövas juridiskt
  enligt dataskyddsförordningen vid beställning. Data lagras lokalt hos
  beställaren.
- **Råleverans i repo**: råfilerna under `data/raw/lantmäteriet/` ska
  behandlas som `data/`-resten — de ligger utanför git (verifiera
  `.gitignore`) och versioneras inte. Endast den genererade
  `data/sweden-lm.pmtiles` är intressant för distribution.
- **Storlek**: Råleveransen (alla 11 ZIP-filer uppackade) ligger sannolikt
  på 20–40 GB. Resulterande PMTiles uppskattningsvis 8–15 GB (mot dagens
  ~3 GB). Säkerställ diskutrymme i `data/` och eventuell CI-cache.
- **Bygge**: körs lokalt eller i CI med tillräcklig disk. Abonnemang ger
  inkrementella leveranser så att hela datasetet inte måste laddas ner varje
  vecka.

## Hybridstrategi

Rekommendationen är att låta användaren välja datakälla per session, med
följande riktlinjer:

- **Topografi 10** som default för all svensk fältkartanvändning – bättre
  detaljer för byggnader, stigar och fjällterräng.
- **OSM/Protomaps** som fallback utanför Sveriges bbox
  (`10.54,55.20,24.17,69.07`) och för användare som inte vill registrera ett
  Geotorget-konto.
- **Höjdkurvor**: använd inbyggda `hojdlinje` från `sweden-lm.pmtiles` i
  LM-läget; behåll `maplibre-contour` i OSM-läget.
- **MGRS-grid, norrpil, skalstreck** är klient-renderade och oberoende av
  vald datakälla.

## Stegvis införande

1. **Inventera leveransen** — kör `ogrinfo -al -so` per `.gpkg` för att
   bekräfta tabell- och attributnamn (delvis redan gjort via `uttag.json`).
2. **Prototyp** — bygg `sweden-lm.pmtiles` lokalt med en bbox-extraktion
   över ett begränsat område (t.ex. Stockholms kommun) för snabb iteration:
   `ogr2ogr -spat ... -t_srs EPSG:4326 ...`.
3. **Stilfil** — skapa `lantmateriet-topo10.json`, verifiera rendering i
   webbappen mot prototypens PMTiles.
4. **Källval i UI** — `mapSource` i store, dropdown i Sidebar, attribuering,
   API-route för `sweden-lm`.
5. **Sverige-täckande bygge** — kör fullt bygge, mät storlek och
   renderingsprestanda.
6. **PDF-synk** — uppdatera render-route och render-sida så att vald källa
   följer med, enligt WYSIWYG-principen.
7. **Höjdkurvor från LM** — koppla bort `maplibre-contour` i LM-läget och
   validera mot dagens utseende.
8. **Automatisering** — implementera `scripts/build-lm-pmtiles.sh` med
   token-flöde och pollning av order-API för veckovis uppdatering.
9. **Abonnemangs-CI** — schemalägg veckovis bygge (t.ex. GitHub Actions med
   self-hosted runner pga datastorlek) och publicera ny PMTiles via CDN.

## Öppna frågor och risker

- **Schema-version**: tabellnamnen i leveransen (`byggnad`, `mark`,
  `vaglinje`, …) är enklare än de som anges i dokumentationen för Topografi
  10 2026.05 (`byggnadsverk`, `markyta`, …). Verifiera vilken produktversion
  som faktiskt levererats innan stilfilen färdigställs — kör
  `ogrinfo -al -so` på ett `.gpkg` för att lista kolumner.
- **CRS-osäkerhet**: täckningspolygonen i `uttag.json` har koordinater som
  inte är direkt igenkännbara som SWEREF99 TM. Själva GeoPackage-filerna är
  dock självbeskrivande (CRS i `gpkg_spatial_ref_sys`) och `ogr2ogr` läser
  det automatiskt — verifiera med `ogrinfo` innan körning.
- **Storlek**: 8–15 GB PMTiles kan kräva tile-reduktion (filtrering bort av
  lager som inte används av nuvarande stilar, t.ex. `polcirkeln`,
  `militart_omrade`) för att hålla CDN-kostnader rimliga.
- **Saknade tematiska paket**: administrativa gränser, fastighetsindelning,
  markreglering och rättigheter ingår inte i denna leverans men listas i
  `uttag.json`. Beställ separat vid behov.
- **Glyfer**: ortnamn med å/ä/ö täcks av Noto Sans Regular/Medium.
  Specialtecken i sjönamn bör verifieras.
- **Avtalsrisk**: Geotorget kan ändra villkoren för avgiftsfri tillgång; ha
  kvar OSM-pipelinen som fallback.
- **Render-prestanda**: större PMTiles ger längre tile-hämtningstid i
  Playwright-renderaren. Kan kräva justering av timeouts i
  [apps/api/src/render/playwright.ts](../../apps/api/src/render/playwright.ts).

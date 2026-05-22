# Fältkarta Pro

Webbverktyg för att skapa flersidiga, exakt skalade fältkartor i PDF från OpenStreetMap-data. Kartorna innehåller MGRS/UTM-rutnät, MGRS-kantkoordinater, norrpil, skalstreck och sidnumrering – redo för utskrift eller fältbruk.

---

## Innehåll

- [Arkitektur](#arkitektur)
- [Stack](#stack)
- [Kom igång](#kom-igång)
- [Kartdata](#kartdata)
- [Funktioner](#funktioner)
- [Kartstilar](#kartstilar)
- [PDF-rendering – hur det fungerar](#pdf-rendering--hur-det-fungerar)
- [API-routes](#api-routes)
- [Tillståndshantering (web)](#tillståndshantering-web)
- [Delade typer (packages/shared)](#delade-typer-packagesshared)
- [Konfiguration av atlas](#konfiguration-av-atlas)
- [Filstruktur](#filstruktur)

---

## Arkitektur

```
kartvertyget/
├── apps/
│   ├── api/          – Fastify-server: tile-proxy, PDF-render-endpoint
│   └── web/          – React + Vite: kartvy, sidebar, state
├── packages/
│   └── shared/       – Delade TypeScript-typer och hjälpfunktioner
├── data/             – PMTiles-filer (ej i git, byggs lokalt)
└── scripts/          – Skript för att bygga kartdata
```

Monorepo med pnpm workspaces. `apps/web` proxar `/tiles/*` och `/render` till `apps/api` (port 8787) via Vites dev-proxy. Stilfiler (`/styles/*.json`) serveras direkt av Vite från `apps/web/public/styles/`.

---

## Stack

| Del | Teknik |
|---|---|
| Frontend | React 18, Vite 5, TypeScript 5.6 |
| Karta | MapLibre GL JS 4.7.1 |
| Tiles | PMTiles 4.x via `pmtiles` protokoll-adapter |
| Höjdkurvor | maplibre-contour 0.1.0 (AWS Terrarium DEM) |
| MGRS/UTM | `mgrs`, `proj4` |
| Tillstånd | Zustand |
| API | Fastify 5.1 + Node 25 |
| Headless render | Playwright 1.49 + Chromium |
| PDF-komposition | pdf-lib 1.17 |
| Kartdata | Protomaps-schema via PMTiles (OSM) |

---

## Kom igång

### Förutsättningar

- Node.js ≥ 20, pnpm ≥ 9
- `pmtiles` CLI: `brew install pmtiles` (för dataskripten)

### Installation

```bash
pnpm install
pnpm --filter @kvg/api exec playwright install chromium
pnpm sync:styles
```

### Starta dev-servrar

```bash
pnpm dev            # startar web (5173) + api (8787) parallellt
pnpm dev:web        # bara webbappen
pnpm dev:api        # bara API:et
```

Öppna sedan `http://localhost:5173`.

### Typkontroll

```bash
pnpm typecheck
```

---

## Kartdata

Kartdata lagras i `data/` och ingår **inte** i git. Byggs lokalt en gång.

### Vector tiles (OSM)

```bash
./scripts/build-pmtiles.sh
```

Extraherar `data/sweden.pmtiles` (zoom 0–15) från Protomaps dagliga planet-build via HTTP range-requests. Tar 3–5 minuter. Kräver `pmtiles` CLI.

Alternativt med Planetiler (långsammare, ~30–90 min):
```bash
./scripts/build-pmtiles.sh --planetiler
```

### Terrängdata (höjdkurvor)

Höjdkurvor i webbappen hämtas direkt från AWS via `maplibre-contour` och kräver ingen lokal data. Terrarium-encoding från `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`.

### PMTiles-schema (Protomaps)

Filen `data/sweden.pmtiles` innehåller följande lager:

| Lager | Innehåll |
|---|---|
| `boundaries` | Administrativa gränser |
| `buildings` | Byggnader (zoom ≥ 13) |
| `earth` | Landmassa |
| `landcover` | Marktäcke (`kind`: wood, scrub, grass, crop, wetland) |
| `landuse` | Markanvändning (park, urban, m.m.) |
| `places` | Ortsnamn |
| `pois` | Intressepunkter |
| `roads` | Vägar (`kind`: highway, major_road, medium_road, minor_road, path, track) |
| `water` | Vattenytor och vattendrag |

---

## Funktioner

### Kartvy

- **Interaktiv karta** med MapLibre GL JS centrerad på Stockholm som startvärde.
- **Persistens i webbläsaren**: atlas, ritlager, MGRS-/stilval och aktuell kartposition sparas i `localStorage` så att omladdning inte nollställer arbetet.
- **MGRS-statusrad** längst ned visar full MGRS-referens under muspekaren i realtid (zon, bokstäver och koordinatdelar) samt WGS84 decimal.
- **Textetiketter**: gatunamn och annan baskarttext kan slås av/på och påverkar både kartvyn och PDF-renderingen.
- **MGRS-visning** kan slås av/på och växla mellan fullt rutnät eller endast koordinater i ramen. I PDF visas kantkoordinater alltid när MGRS är aktivt, och de skrivs som full MGRS med zon och bokstäver. Fullt rutnät skalar med zoomnivån (10 km, 1 km, 100 m, 10 m) och har en separat inställning för större eller mindre rutor vid samma zoom.
- **Höjdkurvor** (valfri) via `maplibre-contour` med separata lager för index- och mellankurvor.

### GPX och ritning

- **GPX-import**: ladda upp en `.gpx`-fil – spår och waypoints importeras direkt på kartan.
- **Ritverktyg**: rita punkter, linjer (dubbelklicka för att avsluta) och placera ikoner (tält, eldplats, vatten, parkering, varning).
- **Rensa**: tar bort alla overlay-features.
- Overlays renderas med i PDF:en.

### Atlassidor

1. Konfigurera utskriftsparametrar (skala, papper, orientering, marginal).
2. Klicka **+ Lägg till sida** – sidan placeras i kartans mittpunkt och kartvyn zoomar automatiskt in för att visa sid-rektangeln.
3. Varje sida visas som en röd transparent rektangel på kartan med ett sidnummer.
4. Sidor kan tas bort individuellt.
5. Klicka **Generera PDF** – servern renderar alla sidor och returnerar en nedladdningsbar PDF.

---

## Kartstilar

Stilfiler ligger i `apps/web/public/styles/`. De laddas av webbappen via relativ URL och av API:et via `readFileSync`.

| Fil | Namn | Användning |
|---|---|---|
| `friluft.json` | Friluft (färg) | Standardstil för fältbruk, färgad |
| `sw-laser.json` | Svartvitt (laser) | Svartvit stil för laser/svartvit utskrift |
| `minimal.json` | Minimalistisk | Avskalad stil |
| `protomaps-light.json` | Protomaps Light | Färdig upstream-stil för allmän kartvisning |
| `protomaps-white.json` | Protomaps White | Ljus, ren print-orienterad variant |
| `protomaps-grayscale.json` | Protomaps Grayscale | Neutral gråskala byggd för samma schema |
| `protomaps-black.json` | Protomaps Black | Mörk svartgrå variant från Protomaps |

Alla stilar använder:

- En vector-källa mot `/tiles/sweden.json` (Protomaps-schema). Käll-id varierar mellan handskrivna och genererade stilar.
- Glyphs från Protomaps CDN: `https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf`.

Protomaps-stilarna genereras lokalt från `@protomaps/basemaps` via `pnpm sync:styles`, så att de förblir statiska JSON-filer som fungerar både i webbappen och i PDF-renderaren.

### sw-laser-stilen

Designad för laser-/svartvita skrivare. Vit bakgrund med svarta linjer:

- Skogar: vit fyllning + svart kontur
- Vatten: vit fyllning + svart kontur
- Byggnader: svart fyllning (zoom ≥ 13)
- Vägar: svart, varierande bredd och streckstil per typ (motorväg → stig)
- Ortsnamn: Noto Sans Medium, svart

### Stilbyte

`MapView` byter stil med `map.setStyle(url, { diff: false })` vilket gör en komplett reload. När den nya stilen är laddad (`style.load`) återställs appens hjälplager: MGRS-nät, atlas-rektanglar, GPX/ritlager och waypoint-ikoner. Om höjdkurvor är aktiverade återinförs contour-lagren efter att kartan blivit idle. Första renderingen hoppas fortfarande över via `mapLoadedRef` för att undvika kollision med konstruktorns initiala stil-laddning.

---

## PDF-rendering – hur det fungerar

```
Sidebar: POST /render
    → engine.ts: beräknar bounds per sida, pixelstorlek, startar Playwright
        → playwright.ts: öppnar headless Chromium, laddar render-page
            → page/index.html: mountar MapLibre, fitBounds, väntar på idle
        → engine.ts: tar screenshot (PNG), bäddar in i PDF via pdf-lib
        → decorations.ts: ritar ram, fulla MGRS-kantkoordinater, norrpil, skalstreck
    → returnerar PDF-bytes
```

### Steg för steg

1. **Bounds-beräkning** (`engine.ts`): Flat-jord-approximation runt sidans centrum `(lon, lat)`. Sidans geografiska yta = `(pappersbredd_mm - 2×marginal) × skala / 1000` meter.

2. **Canvas-storlek** (`engine.ts`): `imgWpx = mapWidthMm × (300 DPI / 25.4)`. Renderingen sker alltid i 300 DPI för att ge en förutsägbar fysisk utskriftsskala.

3. **Playwright-render** (`playwright.ts`): Startar ett headless Chromium-kontext med exakt `widthPx × heightPx` pixels viewport. Laddar `render-page/index.html` som är statiskt servad av API:et på `/render-page/`.

4. **MapLibre-rendering** (`page/index.html`): Mountar en MapLibre-karta med den inbyggda stil-JSON:en (absoluta tile-URLs patchade av `engine.ts`). Om `contours` är aktiverat registreras även `maplibre-contour` och contour-lager läggs ovanpå baskartan. Därefter anropas `fitBounds` för att täcka exakt sidans bounds. Sidan väntar på `map.once('idle')` – detta garanterar att alla tiles för viewport:et är laddade.

5. **Screenshot**: Playwright tar en PNG av hela viewport:en.

6. **PDF-komposition** (`engine.ts` + `decorations.ts`): PNG bäddas in på en PDF-sida i exakt fysisk mm-storlek (`pdf-lib`). Sedan ritas marginalelement:
   - Ram runt kartytan
  - MGRS antingen som fullt rutnät i kartbilden samt fulla MGRS-kantkoordinater, eller endast fulla MGRS-kantkoordinater
   - UTM-zon
   - Norrpil
   - Skalstreck (1 km och 500 m)
   - Datum (ISO 8601)
   - Sidnummer (`N/totalt`)
   - OSM-attribution

## API-routes

Servern körs på `127.0.0.1:8787` (konfigurerbar via `PORT`/`HOST`).

| Method | Path | Beskrivning |
|---|---|---|
| `GET` | `/tiles/:name.json` | TileJSON för en PMTiles-fil i `data/` |
| `GET` | `/tiles/:name/:z/:x/:y.mvt` | Enskild MVT-tile ur PMTiles-filen |
| `POST` | `/render` | Tar emot `RenderRequest` JSON, returnerar PDF |
| `GET` | `/render-page/index.html` | Statisk HTML som Playwright laddar för rendering |
| `GET` | `/health` | Hälsokontroll, returnerar `{"ok":true,"time":"..."}` |

### POST /render

Request body: `RenderRequest` (se [Delade typer](#delade-typer-packagesshared)).

Svarar med `Content-Type: application/pdf` och `Content-Disposition: attachment; filename="atlas-{timestamp}.pdf"`.

Returnerar 400 om `atlas.pages` saknas eller är tom.

---

## Tillståndshantering (web)

All applikationsstate hanteras med **Zustand** i `apps/web/src/state/store.ts`.

State persisteras i webbläsarens `localStorage` under nyckeln `kvg-web-state`, så att sidor, ritlager, kartkamera och visningsval återställs efter omladdning.

| State-nyckel | Typ | Beskrivning |
|---|---|---|
| `styleId` | `StyleId` | Aktiv kartstil (`friluft`, `sw-laser`, `minimal`) |
| `labels` | `boolean` | Gatunamn och annan baskarttext på/av |
| `contours` | `boolean` | Höjdkurvor på/av |
| `mgrsGrid` | `boolean` | MGRS-visning på/av i kartvy och PDF |
| `mgrsMode` | `'full'│'frame'` | Fullt MGRS-rutnät eller endast MGRS i ramen |
| `mgrsGridSizeBias` | `-1│0│1` | Gör MGRS-rutorna större, standard eller mindre vid samma zoom |
| `overlays` | `Overlays` | GPX-spår och waypoints som GeoJSON |
| `atlas` | `AtlasSpec` | Alla utskriftsinställningar inkl. sidor |
| `drawMode` | `'none'│'waypoint'│'track'│'icon'` | Aktivt ritverktyg |
| `iconName` | `string│null` | Vald ikontyp för `icon`-läge |

`setStyleId`, `setLabels`, `setContours`, `setMgrsGrid`, `setMgrsMode` och `setMgrsGridSizeBias` synkar även till `atlas` så att PDF-renderingen alltid har rätt värden.

`MapView` exponerar kartobjektet som `window.__kvgMap` för att `Sidebar` ska kunna anropa `fitBounds` vid sidläggning utan att skapa ett cirkulärt beroende.

---

## Delade typer (packages/shared)

`packages/shared/src/index.ts` exporterar typer och funktioner som används av både `web` och `api`.

### Viktiga typer

```typescript
type StyleId = 'friluft' | 'sw-laser' | 'minimal';
type Scale = 5000 | 10000 | 15000 | 20000 | 25000 | 40000 | 50000 | 75000 | 100000;
type PaperSize = 'A5' | 'A4' | 'A3';
type Orientation = 'portrait' | 'landscape';

interface PageSpec {
  id: string;
  center: [number, number];   // [lon, lat] WGS84
  rotation?: number;           // grader medurs, 0 = norr upp (ej implementerat i UI)
}

interface AtlasSpec {
  scale: Scale;
  paper: PaperSize;
  orientation: Orientation;
  margin: number;              // mm, subtraheras på alla fyra sidor
  overlap: number;             // mm, rådgivande (ej implementerat)
  styleId: StyleId;
  labels: boolean;
  contours: boolean;
  pages: PageSpec[];
}

interface Overlays {
  tracks: FeatureCollection<LineString>;
  waypoints: FeatureCollection<Point>;
}

interface RenderRequest {
  atlas: AtlasSpec;
  overlays: Overlays;
}
```

### Hjälpfunktioner

**`pageMetersOnGround(atlas)`** – Beräknar sidans geografiska utbredning i meter baserat på skala, papper, orientering och marginal. Tar hänsyn till att marginalerna subtraheras från utskriftsytan.

```typescript
const { widthM, heightM, mapWidthMm, mapHeightMm } = pageMetersOnGround(atlas);
```

**`PAPER_SIZES`** – Konstant med pappersbredd/höjd i mm:

```typescript
const PAPER_SIZES = {
  A5: { width: 148, height: 210 },
  A4: { width: 210, height: 297 },
  A3: { width: 297, height: 420 },
} as const;
```

**`PRINT_DPI = 300`**, **`MM_PER_INCH = 25.4`** – Konstanter för pixelberäkning.

---

## Konfiguration av atlas

Standardvärden vid appstart:

| Parameter | Standardvärde | Beskrivning |
|---|---|---|
| Skala | 1:25 000 | Kartskala |
| Papper | A4 | A5, A4 eller A3 |
| Orientering | Liggande | Liggande eller stående |
| Marginal | 15 mm | Marginal för kartyta och dekorationer |

Vanliga skalor i UI: `1:5 000`, `1:10 000`, `1:15 000`, `1:20 000`, `1:25 000`, `1:40 000`, `1:50 000`, `1:75 000`, `1:100 000`.

---

## Filstruktur

```
apps/
  api/
    src/
      server.ts          – Fastify-app, plugin-registrering, statiska routes
      tiles.ts           – PMTiles-proxy (TileJSON + MVT-tiles)
      render/
        route.ts         – POST /render endpoint
        engine.ts        – Atlas-rendering: bounds, pixelstorlek, PDF-komposition
        playwright.ts    – Headless Chromium, screenshot
        decorations.ts   – MGRS-rutnät eller kantkoordinater, norrpil, skalstreck, attribution
        page/
          index.html     – Statisk render-sida som Playwright laddar

  web/
    public/
      styles/
        friluft.json     – Färg outdoor-stil
        sw-laser.json    – Svartvit laser-stil
        minimal.json     – Minimalistisk stil
      icons/             – PNG-ikoner för waypoints (tent, fire, water, parking, warning)
    src/
      main.tsx           – React-entry, StrictMode
      App.tsx            – Layout: Sidebar + MapView + statusbar
      index.css          – Global styling, dark sidebar
      map/
        MapView.tsx      – MapLibre-instans, overlay-lager, stilbyte, MGRS-visning, höjdkurvor
        atlasGeom.ts     – Beräknar GeoJSON-rektanglar för atlas-sidor
        mgrsGrid.ts      – Re-export av delad MGRS/UTM-grid-beräkning
      state/
        store.ts         – Zustand-store, all applikationsstate
      ui/
        Sidebar.tsx      – Alla UI-kontroller
      utils/
        coords.ts        – MGRS-formattering (lon/lat → MGRS-sträng)

packages/
  shared/
    src/
      index.ts           – Typer (AtlasSpec, PageSpec, m.m.) och hjälpfunktioner

scripts/
  build-pmtiles.sh       – Bygger data/sweden.pmtiles (Protomaps-extrakt eller Planetiler)
  build-terrain.sh       – Bygger terrängdata (ej aktivt i webbappen, används ej)

data/                    – Genererade filer (ej i git)
  sweden.pmtiles         – OSM vector tiles, zoom 0–15, ~4 GB
```


- Webben: <http://127.0.0.1:5173>
- API: <http://127.0.0.1:8787>

## Arkitektur i korthet

Klienten visar kartan, GPX, ritlager, MGRS-grid och atlas-sidornas geografiska rektanglar. När användaren klickar **Generera PDF** skickas `AtlasSpec` + overlays till backend. Backend startar headless Chromium, laddar samma MapLibre-style vid exakt pixelmått (`mm × 300 dpi / 25.4`), tar screenshot per sida och bäddar in i en `pdf-lib`-sammansatt PDF där varje sida har exakta mm-mått. Marginal-element (norrpil, skalstreck, MGRS-kantkoordinater, datum, sidnummer, attribution) ritas i PDF:n.

Detta säkerställer att 1 km på papperet motsvarar exakt `1000 / scale × 1000` mm – t.ex. 40 mm vid 1:25 000.

## Status

Detta är en pågående MVP. Se [/memories/session/plan.md](./../../memories/session/plan.md) för rullande planering.

# Köra Kartvertyget i en Docker-container

Hela appen (Vite-byggd web-frontend + Fastify-API + Playwright för PDF-render)
paketeras till en enda image. Containern serverar UI:t, API:t och valfri
PMTiles-proxy på samma port (default 8080).

## Quickstart

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/data:/data:ro" \
  -e PMTILES_OSM_FILE=/data/sweden-osm.pmtiles \
  ghcr.io/nicklasandersson/kartverktyget:latest
```

Öppna `http://localhost:8080`. PDF-rendering (Playwright/Chromium) fungerar
direkt — inga extra steg.

## Bygga lokalt

```bash
docker build -t kartvertyget:dev .
docker run --rm -p 8080:8080 -v "$PWD/data:/data:ro" \
  -e PMTILES_OSM_FILE=/data/sweden-osm.pmtiles \
  kartvertyget:dev
```

Image-storlek ~1 GB (Playwright-basen är ~700 MB av detta).

## GitHub-byggd image

Workflow [.github/workflows/docker.yml](../.github/workflows/docker.yml)
bygger och publicerar till `ghcr.io/<owner>/<repo>` vid push till `main` och
vid taggning `v*.*.*`. PR:er bygger utan push. För att använda imagen krävs
att förrådet eller dess Package är publikt (eller att klienten loggar in mot
GHCR).

## PMTiles-källor

Appen behöver minst en PMTiles-källa. Det finns tre lägen, valda per källa via
miljövariabler. Källnamnet (här `OSM` och `LM`) väljs fritt; konventionen i
default-stilarna är `osm` för Protomaps-temat och `lm` för Lantmäteriet-temat.

### Lägen

| Variabel                        | Lokal fil | Privat fjärr (proxy) | Publik fjärr (direkt) |
|---------------------------------|:---------:|:--------------------:|:---------------------:|
| `PMTILES_<NAME>_FILE`           |     X     |                      |                       |
| `PMTILES_<NAME>_URL`            |           |          X           |           X           |
| `PMTILES_<NAME>_AUTH`           |           |       (valfri)       |                       |
| `PMTILES_<NAME>_PUBLIC=true`    |           |                      |           X           |

- **Lokal fil**: mounta `.pmtiles` på `/data/...` och peka ut filen.
  Containern servar den med Range-stöd via `/pmtiles/<name>`.
- **Privat fjärr (proxy)**: containern hämtar pmtiles över HTTP, lägger på
  `Authorization`-headern, och cachear bytes i minnet medan den proxar Range-
  requests till browsern. Credentials syns aldrig i klienten.
- **Publik fjärr (direkt)**: browsern hämtar pmtiles direkt från URL:en.
  Sparar bandbredd på containern men kräver att URL:en är CORS-aktiverad.

### Exempel: kombinera lokal LM + publik OSM

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/data:/data:ro" \
  -e PMTILES_LM_FILE=/data/sweden-lm.pmtiles \
  -e PMTILES_OSM_URL=https://kartverktyget.s3.eu-central-003.backblazeb2.com/sweden-osm.pmtiles \
  -e PMTILES_OSM_PUBLIC=true \
  ghcr.io/nicklasandersson/kartverktyget:latest
```

### Exempel: privat fjärrkälla med Bearer-token

```bash
docker run --rm -p 8080:8080 \
  -e PMTILES_OSM_URL=https://tiles.example.com/sweden.pmtiles \
  -e PMTILES_OSM_AUTH="Bearer $MY_TOKEN" \
  ghcr.io/nicklasandersson/kartverktyget:latest
```

Browsern hämtar `pmtiles://http://localhost:8080/pmtiles/osm` — `MY_TOKEN`
syns aldrig i nätverkstrafiken klientsidan.

## Bakom en reverse-proxy

Om appen körs bakom nginx/Caddy/Traefik på en annan host, sätt antingen:

- `KVG_PUBLIC_BASE_URL=https://karta.example.com` (explicit), eller
- skicka `X-Forwarded-Proto` + `X-Forwarded-Host` från proxyn (default i
  alla gängse reverse-proxies).

Stilarna serverade på `/styles/*.json` får då rätt absolut `pmtiles://`-URL
oavsett intern container-port.

## Alla miljövariabler

| Variabel                        | Default                  | Syfte |
|---------------------------------|--------------------------|-------|
| `PORT`                          | `8080`                   | Lyssnar-port |
| `HOST`                          | `0.0.0.0`                | Lyssnar-adress |
| `KVG_PUBLIC_BASE_URL`           | härleds från request     | Public origin (när bakom proxy) |
| `KVG_DATA_DIR`                  | `/data`                  | Sökväg där `.pmtiles` letas (för bakåtkompat-routen `/tiles/`) |
| `KVG_STYLES_DIR`                | `/app/web/styles`        | Stilfiler som lästs in vid request |
| `PMTILES_<NAME>_FILE`           | —                        | Lokal fil för källa `<name>` |
| `PMTILES_<NAME>_URL`            | —                        | Fjärr-URL för källa `<name>` |
| `PMTILES_<NAME>_AUTH`           | —                        | Authorization-header för fjärr-URL |
| `PMTILES_<NAME>_PUBLIC`         | `false`                  | Om `true`: ge URL:en direkt till browsern (ingen proxy) |

## Endpoints i containern

| URL                       | Beskrivning |
|---------------------------|-------------|
| `/`                       | Web-frontenden (SPA) |
| `/health`                 | Hälsokoll, returnerar `{ ok: true }` |
| `/styles`                 | Lista tillgängliga stilar |
| `/styles/:name.json`      | MapLibre style-JSON med omskriven `pmtiles://`-URL |
| `/pmtiles/:name`          | Range-served PMTiles (lokal fil eller proxy) |
| `/render`                 | POST: rendera en atlas till PDF (Playwright) |
| `/tiles/:name/...`        | Bakåtkompatibel fil-tile-server (läser från `KVG_DATA_DIR`) |

## docker-compose

Se [docker-compose.example.yml](../docker-compose.example.yml) för en
mall med alla tre lägen.

## Begränsningar

- Imagen är **amd64** i default-workflowen. Bygg om lokalt för andra plattformar
  (`--platform linux/arm64`); notera att Playwright-basimagen finns för både
  amd64 och arm64.
- PMTiles-proxyn cachear bara per request (ingen disk-cache). Vid hög
  trafik mot privat fjärrkälla, lägg en CDN/proxy framför kvg-containern
  eller utöka `pmtilesProxy.ts` med en cache-strategi.
- Render-rutten kräver att Chromium kan binda till localhost:`$PORT` — vid
  custom `--network host`-setup, säkerställ att `127.0.0.1` är åtkomligt
  från containerns processer.

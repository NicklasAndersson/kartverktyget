import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import {
  PRINT_DPI,
  MM_PER_INCH,
  PAPER_SIZES,
  applyLabelSizeToStyleLayers,
  applyRoadSizeToStyleLayers,
  isBaseMapTextLayer,
  pageMetersOnGround,
  type RenderRequest,
  type AtlasSpec,
  type PageSpec,
} from '@kvg/shared';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { renderMapPng } from './playwright.js';
import { drawPageDecorations } from './decorations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Renderar en hel atlas till en sammansatt PDF-buffer.
 *
 * Per sida:
 *  1. Beräkna geografiska bounds från centrum + skala + pappersmått (minus marginal).
 *  2. Be Playwright/MapLibre rendera en PNG av kartytan i exakt pixelmått (DPI × mm/25.4).
 *  3. Lägg PNG-en på en PDF-sida med exakta mm-mått så att fysisk skala bevaras.
 *  4. Rita norrpil, skalstreck, MGRS-kantkoordinater, datum, attribution m.m. i marginalen.
 */
export async function renderAtlas(req: RenderRequest, log: FastifyBaseLogger): Promise<Uint8Array> {
  const { atlas, overlays } = req;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const paperSize = PAPER_SIZES[atlas.paper];
  const pageWmm = atlas.orientation === 'landscape' ? paperSize.height : paperSize.width;
  const pageHmm = atlas.orientation === 'landscape' ? paperSize.width : paperSize.height;
  const { mapWidthMm, mapHeightMm, widthM, heightM } = pageMetersOnGround(atlas);

  // Pixelmått i renderbilden (1 px = 1/DPI tum).
  const pxPerMm = PRINT_DPI / MM_PER_INCH;
  const imgWpx = Math.round(mapWidthMm * pxPerMm);
  const imgHpx = Math.round(mapHeightMm * pxPerMm);

  log.info(
    { pages: atlas.pages.length, scale: atlas.scale, mapWidthMm, mapHeightMm, imgWpx, imgHpx, widthM, heightM },
    'render start',
  );

  for (let i = 0; i < atlas.pages.length; i++) {
    const page = atlas.pages[i]!;
    const bounds = pageBoundsMeters(page, widthM, heightM);
    const pngBytes = await renderMapPng({
      style: styleJsonFor(atlas.styleId, atlas.labels, atlas.labelSize, atlas.roadSize),
      bounds,
      widthPx: imgWpx,
      heightPx: imgHpx,
      overlays,
      contours: atlas.contours,
    });

    const png = await pdf.embedPng(pngBytes);
    // PDF använder punkter (1 pt = 1/72 tum). 1 mm = 72/25.4 pt.
    const ptPerMm = 72 / MM_PER_INCH;
    const pdfPage = pdf.addPage([pageWmm * ptPerMm, pageHmm * ptPerMm]);
    pdfPage.drawImage(png, {
      x: atlas.margin * ptPerMm,
      y: atlas.margin * ptPerMm,
      width: mapWidthMm * ptPerMm,
      height: mapHeightMm * ptPerMm,
    });
    drawPageDecorations({
      pdfPage,
      font,
      fontBold,
      atlas,
      page,
      pageIndex: i,
      totalPages: atlas.pages.length,
      bounds,
      pageWmm,
      pageHmm,
      mapWidthMm,
      mapHeightMm,
      ptPerMm,
    });
  }

  return pdf.save();
}

/**
 * Läser stil-JSON från disk och patchar käll-URL:en till att vara absolut mot API-porten.
 * Playwright-browsern laddar render-page från 8787 → tiles måste hämtas från 8787 (same origin).
 */
function styleJsonFor(
  id: AtlasSpec['styleId'],
  labels: boolean,
  labelSize: AtlasSpec['labelSize'],
  roadSize: AtlasSpec['roadSize'],
): object {
  const apiPort = process.env.PORT ?? '8787';
  const styleDir = join(__dirname, '../../../../apps/web/public/styles');
  const raw = readFileSync(join(styleDir, `${id}.json`), 'utf8');
  const style = JSON.parse(raw) as {
    sources: Record<string, { url?: string; tiles?: string[] }>;
    layers?: Array<{ id?: string; type?: string; layout?: Record<string, unknown> }>;
  };
  for (const src of Object.values(style.sources)) {
    if (src.url?.startsWith('/tiles/')) {
      src.url = `http://127.0.0.1:${apiPort}${src.url}`;
    }
    if (src.tiles) {
      src.tiles = src.tiles.map((t) =>
        t.startsWith('/tiles/') ? `http://127.0.0.1:${apiPort}${t}` : t,
      );
    }
  }
  if (style.layers) {
    style.layers = applyLabelSizeToStyleLayers(style.layers, labelSize);
    style.layers = applyRoadSizeToStyleLayers(style.layers, roadSize);
  }
  if (!labels && style.layers) {
    for (const layer of style.layers) {
      if (!isBaseMapTextLayer(layer)) continue;
      layer.layout = { ...(layer.layout ?? {}), visibility: 'none' };
    }
  }
  return style;
}

/**
 * Beräknar geografiska bounds för en sida.
 * Använder en lokal flat-jord-approximation kring sidans centrum:
 * 1 grader latitud ≈ 111320 m, 1 grader longitud ≈ 111320 m * cos(lat).
 * För skalor ≤ 1:50 000 och pappersytor ≤ ~A3 ger detta < ~0,1% fel på fysisk skala,
 * vilket är acceptabelt jämfört med skrivartoleranser. För högre precision kan UTM
 * användas i en senare version.
 */
function pageBoundsMeters(
  page: PageSpec,
  widthM: number,
  heightM: number,
): { west: number; south: number; east: number; north: number } {
  const [lon, lat] = page.center;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLat = heightM / 2 / mPerDegLat;
  const dLon = widthM / 2 / mPerDegLon;
  return {
    west: lon - dLon,
    east: lon + dLon,
    south: lat - dLat,
    north: lat + dLat,
  };
}

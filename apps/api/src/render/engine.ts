import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
import { loadStyle, resolveStylesDir } from '../styles.js';

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
      style: await styleJsonFor(atlas.styleId, atlas.mapSource, atlas.labels, atlas.labelSize, atlas.roadSize),
      bounds,
      widthPx: imgWpx,
      heightPx: imgHpx,
      overlays,
      watercourses: atlas.watercourses !== false,
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
 * Hämtar stil-JSON via vår egen /styles/-endpoint (samma omskrivning av
 * `pmtiles://`-URL:er som webb-klienten får) och applicerar label/road-
 * scaling samt eventuell labels-off. Returnerar ett vanligt JSON-objekt
 * som Playwright skickar vidare till MapLibre.
 */
async function styleJsonFor(
  id: AtlasSpec['styleId'],
  mapSource: AtlasSpec['mapSource'],
  labels: boolean,
  labelSize: AtlasSpec['labelSize'],
  roadSize: AtlasSpec['roadSize'],
): Promise<object> {
  const apiPort = process.env.PORT ?? '8787';
  const styleName = mapSource === 'lm' ? 'lantmateriet-topo10' : id;
  // Hämta från vår egen /styles/-route så att pmtiles://-URL:erna redan är
  // omskrivna utifrån aktuell PMTILES_*-konfiguration. Same-host, så även
  // proxy-läget (med inbakade credentials) fungerar transparent.
  const res = await fetch(`http://127.0.0.1:${apiPort}/styles/${styleName}.json`);
  if (!res.ok) throw new Error(`failed to load style ${styleName}: HTTP ${res.status}`);
  const style = (await res.json()) as {
    sources: Record<string, { url?: string; tiles?: string[] }>;
    layers?: Array<{ id?: string; type?: string; layout?: Record<string, unknown> }>;
  };
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

import type { PDFPage, PDFFont } from 'pdf-lib';
import { degrees, rgb } from 'pdf-lib';
import proj4 from 'proj4';
import * as mgrsModule from 'mgrs';
import { MM_PER_INCH, PRINT_DPI, computeMgrsGrid, formatMgrs, utmZoneFromLon, type AtlasSpec, type PageSpec } from '@kvg/shared';

const mgrs = ('default' in mgrsModule ? mgrsModule.default : mgrsModule) as typeof import('mgrs');

interface DecoArgs {
  pdfPage: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  atlas: AtlasSpec;
  page: PageSpec;
  pageIndex: number;
  totalPages: number;
  bounds: { west: number; south: number; east: number; north: number };
  pageWmm: number;
  pageHmm: number;
  mapWidthMm: number;
  mapHeightMm: number;
  ptPerMm: number;
}

/**
 * Ritar marginal-element: ram, MGRS-kantkoordinater,
 * norrpil, skalstreck, UTM-zon, datum, sidnummer, OSM-attribution.
 */
export function drawPageDecorations(a: DecoArgs) {
  const { pdfPage, font, fontBold, atlas, page, pageIndex, totalPages, bounds, ptPerMm, mapWidthMm, mapHeightMm } = a;
  const marginPt = atlas.margin * ptPerMm;
  const mapXPt = marginPt;
  const mapYPt = marginPt;
  const mapWPt = mapWidthMm * ptPerMm;
  const mapHPt = mapHeightMm * ptPerMm;

  // 1. Ram runt kartytan.
  pdfPage.drawRectangle({
    x: mapXPt,
    y: mapYPt,
    width: mapWPt,
    height: mapHPt,
    borderColor: rgb(0, 0, 0),
    borderWidth: 0.6,
  });

  // 2. UTM-zon från sidans centrum.
  const [clon, clat] = page.center;
  const zoneNum = utmZoneFromLon(clon);
  const zoneLetter = utmLatBand(clat);
  const utmDef = `+proj=utm +zone=${zoneNum}${clat < 0 ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
  const fromWgs = proj4('WGS84', utmDef);

  // 3. MGRS: fullt grid inne i kartan vid behov, men alltid kantkoordinater när MGRS är aktivt.
  if (atlas.mgrsGrid) {
    if (atlas.mgrsMode === 'full') {
      drawPdfMgrsGrid({ pdfPage, font, bounds, mapXPt, mapYPt, mapWPt, mapHPt, atlas, mapWidthMm, mapHeightMm });
    }
    drawFrameMgrs({ pdfPage, font, mapXPt, mapYPt, mapWPt, mapHPt, atlas, utmDef, fromWgs, clon, clat, mapWidthMm, mapHeightMm });
  }

  // 4. Toppmarginal: titel och metadata.
  const topY = mapYPt + mapHPt + 14;
  pdfPage.drawText(`Fältkarta · 1:${atlas.scale.toLocaleString('sv-SE')}`, {
    x: mapXPt,
    y: topY,
    size: 10,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  const utmLabel = `UTM Zone ${zoneNum}${zoneLetter}  ·  WGS84`;
  pdfPage.drawText(utmLabel, {
    x: mapXPt + 180,
    y: topY,
    size: 8,
    font,
    color: rgb(0, 0, 0),
  });

  // 5. Centrum-MGRS i toppraden, högerställd (informativt). Här har vi gott
  // om utrymme och slipper krocka med skalstrecket nedanför kartan.
  try {
    const mgrsStr = formatMgrs(mgrs.forward([clon, clat], 4));
    const mgrsLine = `Centrum MGRS: ${mgrsStr}`;
    const mgrsSize = 7;
    pdfPage.drawText(mgrsLine, {
      x: mapXPt + mapWPt - font.widthOfTextAtSize(mgrsLine, mgrsSize),
      y: topY,
      size: mgrsSize,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  } catch {
    /* ignore */
  }

  // 6. Bottommarginal: datum + sidnr (vänster) och attribution (centrerad).
  // Sidnumret ligger ihop med datumet så högerkanten är fri för norrpilen.
  const botY = mapYPt - 14;
  const dateStr = new Date().toISOString().slice(0, 10);
  const footerLeft = `${dateStr}  ·  Sida ${pageIndex + 1} / ${totalPages}`;
  pdfPage.drawText(footerLeft, { x: mapXPt, y: botY, size: 7, font, color: rgb(0, 0, 0) });
  // Endast Lantmäteriets attribution ritas (krävs av CC BY 4.0). OSM-rendering
  // utelämnas medvetet enligt önskemål.
  if (atlas.mapSource === 'lm') {
    const attribution = '© Lantmäteriet (CC BY 4.0)';
    pdfPage.drawText(attribution, {
      x: mapXPt + (mapWPt - font.widthOfTextAtSize(attribution, 6)) / 2,
      y: botY,
      size: 6,
      font,
      color: rgb(0, 0, 0),
    });
  }

  // 7. Skalstreck centrerat horisontellt under kartan, en bit under
  // datum/attribution-raden så det inte överlappar texten.
  const scaleTotalM = atlas.scale >= 25000 ? 2000 : 500;
  const scaleWidthPt = ((scaleTotalM * 1000) / atlas.scale) * ptPerMm;
  drawScaleBar({
    pdfPage,
    font,
    x: mapXPt + (mapWPt - scaleWidthPt) / 2,
    y: mapYPt - 34,
    scale: atlas.scale,
    ptPerMm,
  });

  // 8. Norrpil i nedre högra hörnet.
  drawNorthArrow({
    pdfPage,
    font: fontBold,
    cx: mapXPt + mapWPt - 14,
    cy: mapYPt - 28,
  });
}

function drawFrameMgrs(args: {
  pdfPage: PDFPage;
  font: PDFFont;
  mapXPt: number;
  mapYPt: number;
  mapWPt: number;
  mapHPt: number;
  atlas: AtlasSpec;
  utmDef: string;
  fromWgs: proj4.Converter;
  clon: number;
  clat: number;
  mapWidthMm: number;
  mapHeightMm: number;
}) {
  const { pdfPage, font, mapXPt, mapYPt, mapWPt, mapHPt, atlas, utmDef, fromWgs, clon, clat, mapWidthMm, mapHeightMm } = args;
  const centerProj = fromWgs.forward([clon, clat]);
  if (!Array.isArray(centerProj) || centerProj.length < 2 || typeof centerProj[0] !== 'number' || typeof centerProj[1] !== 'number') {
    throw new Error(`proj4.forward returned unexpected result for center [${clon}, ${clat}]`);
  }
  const centerE = centerProj[0];
  const centerN = centerProj[1];
  const halfWm = (mapWidthMm * atlas.scale) / 2000;
  const halfHm = (mapHeightMm * atlas.scale) / 2000;
  const westE = centerE - halfWm;
  const eastE = centerE + halfWm;
  const southN = centerN - halfHm;
  const northN = centerN + halfHm;
  const fontSize = 7.5;
  const sideFontSize = 7;
  const topOffset = 3;
  const sideOffset = 4;

  const firstE = Math.ceil(westE / 1000) * 1000;
  for (let easting = firstE; easting <= eastE; easting += 1000) {
    const xPt = mapXPt + ((easting - westE) / (eastE - westE)) * mapWPt;
    const bottomLabel = formatEdgeMgrsLabel(utmDef, easting, southN);
    const topLabel = formatEdgeMgrsLabel(utmDef, easting, northN);
    const bottomWidth = font.widthOfTextAtSize(bottomLabel, fontSize);
    const topWidth = font.widthOfTextAtSize(topLabel, fontSize);
    pdfPage.drawText(bottomLabel, {
      x: clamp(xPt - bottomWidth / 2, mapXPt, mapXPt + mapWPt - bottomWidth),
      y: mapYPt - fontSize - topOffset,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
    pdfPage.drawText(topLabel, {
      x: clamp(xPt - topWidth / 2, mapXPt, mapXPt + mapWPt - topWidth),
      y: mapYPt + mapHPt + topOffset,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
  }

  const firstN = Math.ceil(southN / 1000) * 1000;
  for (let northing = firstN; northing <= northN; northing += 1000) {
    const yPt = mapYPt + ((northing - southN) / (northN - southN)) * mapHPt;
    const leftLabel = formatEdgeMgrsLabel(utmDef, westE, northing);
    const rightLabel = formatEdgeMgrsLabel(utmDef, eastE, northing);
    const leftWidth = font.widthOfTextAtSize(leftLabel, sideFontSize);
    const rightWidth = font.widthOfTextAtSize(rightLabel, sideFontSize);
    pdfPage.drawText(leftLabel, {
      x: mapXPt - sideOffset - sideFontSize,
      y: clamp(yPt - leftWidth / 2, mapYPt, mapYPt + mapHPt - leftWidth),
      size: sideFontSize,
      font,
      color: rgb(0, 0, 0),
      rotate: degrees(90),
    });
    pdfPage.drawText(rightLabel, {
      x: mapXPt + mapWPt + sideOffset,
      y: clamp(yPt + rightWidth / 2, mapYPt + rightWidth, mapYPt + mapHPt),
      size: sideFontSize,
      font,
      color: rgb(0, 0, 0),
      rotate: degrees(-90),
    });
  }
}

function drawPdfMgrsGrid(args: {
  pdfPage: PDFPage;
  font: PDFFont;
  bounds: { west: number; south: number; east: number; north: number };
  mapXPt: number;
  mapYPt: number;
  mapWPt: number;
  mapHPt: number;
  atlas: AtlasSpec;
  mapWidthMm: number;
  mapHeightMm: number;
}) {
  const { pdfPage, font, bounds, mapXPt, mapYPt, mapWPt, mapHPt, atlas, mapWidthMm, mapHeightMm } = args;
  const widthPx = Math.round(mapWidthMm * (PRINT_DPI / MM_PER_INCH));
  const heightPx = Math.round(mapHeightMm * (PRINT_DPI / MM_PER_INCH));
  const zoom = estimateMapZoom(bounds, widthPx, heightPx);
  const grid = computeMgrsGrid({ ...bounds, zoom, sizeBias: atlas.mgrsGridSizeBias });

  for (const feature of grid.features) {
    if (feature.geometry.type === 'LineString') {
      drawGridLine(pdfPage, feature.geometry.coordinates as [number, number][], bounds, mapXPt, mapYPt, mapWPt, mapHPt);
      continue;
    }
    if (feature.geometry.type === 'Point') {
      drawGridLabel(
        pdfPage,
        font,
        feature.geometry.coordinates as [number, number],
        typeof feature.properties?.label === 'string' ? feature.properties.label : '',
        bounds,
        mapXPt,
        mapYPt,
        mapWPt,
        mapHPt,
      );
    }
  }
}

function drawGridLine(
  pdfPage: PDFPage,
  coordinates: [number, number][],
  bounds: { west: number; south: number; east: number; north: number },
  mapXPt: number,
  mapYPt: number,
  mapWPt: number,
  mapHPt: number,
) {
  for (let i = 1; i < coordinates.length; i++) {
    const start = projectToPage(coordinates[i - 1]!, bounds, mapXPt, mapYPt, mapWPt, mapHPt);
    const end = projectToPage(coordinates[i]!, bounds, mapXPt, mapYPt, mapWPt, mapHPt);
    pdfPage.drawLine({ start, end, thickness: 0.35, color: rgb(0.15, 0.15, 0.15), opacity: 0.5 });
  }
}

function drawGridLabel(
  pdfPage: PDFPage,
  font: PDFFont,
  coordinates: [number, number],
  label: string,
  bounds: { west: number; south: number; east: number; north: number },
  mapXPt: number,
  mapYPt: number,
  mapWPt: number,
  mapHPt: number,
) {
  if (!label) return;
  const pos = projectToPage(coordinates, bounds, mapXPt, mapYPt, mapWPt, mapHPt);
  const size = 5.5;
  const width = font.widthOfTextAtSize(label, size);
  pdfPage.drawText(label, {
    x: pos.x - width / 2,
    y: pos.y - size / 2,
    size,
    font,
    color: rgb(0.05, 0.05, 0.05),
    opacity: 0.75,
  });
}

function projectToPage(
  lonLat: [number, number],
  bounds: { west: number; south: number; east: number; north: number },
  mapXPt: number,
  mapYPt: number,
  mapWPt: number,
  mapHPt: number,
) {
  const x = mapXPt + ((lonLat[0] - bounds.west) / (bounds.east - bounds.west)) * mapWPt;
  const y = mapYPt + ((lonLat[1] - bounds.south) / (bounds.north - bounds.south)) * mapHPt;
  return { x, y };
}

export function estimateMapZoom(
  bounds: { west: number; south: number; east: number; north: number },
  widthPx: number,
  heightPx: number,
) {
  const lonSpan = Math.max(1e-9, normalizeLonSpan(bounds.east - bounds.west));
  const zoomX = Math.log2((widthPx * 360) / (512 * lonSpan));
  const mercNorth = mercatorY(bounds.north);
  const mercSouth = mercatorY(bounds.south);
  const mercSpan = Math.max(1e-9, Math.abs(mercSouth - mercNorth));
  const zoomY = Math.log2(heightPx / (512 * mercSpan));
  return Math.max(0, Math.min(22, Math.min(zoomX, zoomY)));
}

function mercatorY(lat: number) {
  const sin = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

function normalizeLonSpan(span: number) {
  if (span < 0) return span + 360;
  return span;
}

export function formatEdgeMgrsLabel(utmDef: string, easting: number, northing: number): string {
  try {
    const lonLat = proj4(utmDef, 'WGS84', [easting, northing]);
    if (!Array.isArray(lonLat) || lonLat.length < 2 || typeof lonLat[0] !== 'number' || typeof lonLat[1] !== 'number') {
      return 'MGRS';
    }
    return formatMgrs(mgrs.forward([lonLat[0], lonLat[1]], 2));
  } catch {
    return 'MGRS';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function utmLatBand(lat: number): string {
  // MGRS latitudband C..X (utelämnar I och O).
  const bands = 'CDEFGHJKLMNPQRSTUVWX';
  if (lat < -80 || lat >= 84) return 'Z';
  const idx = Math.floor((lat + 80) / 8);
  return bands[Math.min(Math.max(idx, 0), bands.length - 1)] ?? 'Z';
}

function drawScaleBar(args: {
  pdfPage: PDFPage;
  font: PDFFont;
  x: number;
  y: number;
  scale: number;
  ptPerMm: number;
}) {
  const { pdfPage, font, x, y, scale, ptPerMm } = args;
  // Skalstrecksenheter: välj 1 km för 1:25k/1:50k, 500 m för 1:10k.
  const totalM = scale >= 25000 ? 2000 : 500;
  const step = totalM / 4;
  const widthMm = (totalM * 1000) / scale; // mm på papper
  const stepMm = widthMm / 4;
  const h = 3; // mm
  for (let i = 0; i < 4; i++) {
    const xi = x + i * stepMm * ptPerMm;
    pdfPage.drawRectangle({
      x: xi,
      y,
      width: stepMm * ptPerMm,
      height: h * ptPerMm,
      color: i % 2 === 0 ? rgb(0, 0, 0) : rgb(1, 1, 1),
      borderColor: rgb(0, 0, 0),
      borderWidth: 0.4,
    });
    const label = i === 0 ? '0' : `${(i * step) / (step >= 1000 ? 1000 : 1)}${step >= 1000 ? ' km' : ' m'}`;
    pdfPage.drawText(label, { x: xi, y: y - 8, size: 6, font, color: rgb(0, 0, 0) });
  }
  // Sluta med totalt-värde.
  const endLabel = `${totalM >= 1000 ? totalM / 1000 + ' km' : totalM + ' m'}`;
  pdfPage.drawText(endLabel, { x: x + widthMm * ptPerMm, y: y - 8, size: 6, font, color: rgb(0, 0, 0) });
}

function drawNorthArrow(args: { pdfPage: PDFPage; font: PDFFont; cx: number; cy: number }) {
  const { pdfPage, font, cx, cy } = args;
  const size = 14;
  // Triangel pekande uppåt.
  pdfPage.drawLine({ start: { x: cx, y: cy - size }, end: { x: cx, y: cy + size }, thickness: 1, color: rgb(0, 0, 0) });
  pdfPage.drawLine({
    start: { x: cx, y: cy + size },
    end: { x: cx - size * 0.4, y: cy + size * 0.3 },
    thickness: 1,
    color: rgb(0, 0, 0),
  });
  pdfPage.drawLine({
    start: { x: cx, y: cy + size },
    end: { x: cx + size * 0.4, y: cy + size * 0.3 },
    thickness: 1,
    color: rgb(0, 0, 0),
  });
  pdfPage.drawText('N', { x: cx - 3, y: cy + size + 2, size: 8, font, color: rgb(0, 0, 0) });
}

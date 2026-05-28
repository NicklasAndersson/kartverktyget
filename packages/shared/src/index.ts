import proj4 from 'proj4';
import * as mgrsModule from 'mgrs';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';

const mgrs = ('default' in mgrsModule ? mgrsModule.default : mgrsModule) as typeof import('mgrs');

/** Fördefinierade kartstilar. */
export type StyleId =
  | 'friluft'
  | 'sw-laser'
  | 'minimal'
  | 'protomaps-light'
  | 'protomaps-dark'
  | 'protomaps-white'
  | 'protomaps-grayscale'
  | 'protomaps-black'
  | 'protomaps-bio'
  | 'protomaps-seafoam'
  | 'protomaps-dusk-rose'
  | 'protomaps-flat';

/**
 * Underliggande datakälla för baskartan.
 * - `osm`: Protomaps/OpenStreetMap (sweden.pmtiles), global täckning.
 * - `lm`: Lantmäteriets Topografi 10 (sweden-lm.pmtiles), endast Sverige.
 */
export type MapSource = 'osm' | 'lm';

export const DEFAULT_MAP_SOURCE: MapSource = 'osm';

/** Käll-id (matchar nyckeln i `style.sources`) per datakälla. */
export const MAP_SOURCE_KEY: Record<MapSource, string> = {
  osm: 'osm',
  lm: 'lm',
};

/** Vanliga kartskalor (denominator i 1:N). */
export const COMMON_SCALES = [5000, 10000, 15000, 20000, 25000, 40000, 50000, 75000, 100000] as const;
export type Scale = (typeof COMMON_SCALES)[number];

/** Pappersstorlekar (mm). */
export const PAPER_SIZES = {
  A5: { width: 148, height: 210 },
  A4: { width: 210, height: 297 },
  A3: { width: 297, height: 420 },
} as const;

export type PaperSize = keyof typeof PAPER_SIZES;
export type Orientation = 'portrait' | 'landscape';
export type SizePreset = 'small' | 'medium' | 'large' | 'xl';
export type LabelSize = number;

export const LABEL_SIZE_FACTORS: Record<SizePreset, number> = {
  small: 0.75,
  medium: 1.3,
  large: 1.6,
  xl: 1.95,
};

export const ROAD_SIZE_FACTORS: Record<SizePreset, number> = {
  small: 0.8,
  medium: 1,
  large: 1.3,
  xl: 1.6,
};

export const DEFAULT_LABEL_SIZE = LABEL_SIZE_FACTORS.medium;
export const DEFAULT_ROAD_SIZE = ROAD_SIZE_FACTORS.medium;
export const LABEL_SIZE_RANGE = { min: LABEL_SIZE_FACTORS.small, max: 4.8, step: 0.05 } as const;
export const ROAD_SIZE_RANGE = { min: ROAD_SIZE_FACTORS.small, max: 4, step: 0.05 } as const;

/** Inställningar för en enskild atlas-sida. */
export interface PageSpec {
  id: string;
  /** Centerkoordinat (lon, lat) WGS84 för sidan. */
  center: [number, number];
  /** Roterad utskrift i grader, medurs. 0 = norr upp. */
  rotation?: number;
}

/** Atlas = en samling sidor med gemensamma layout-parametrar. */
export interface AtlasSpec {
  scale: Scale;
  paper: PaperSize;
  orientation: Orientation;
  /** Pappersmarginal i mm (där kantkoordinater och layout-element ritas). */
  margin: number;
  /** Överlapp mellan sidor i mm (rådgivande, används vid auto-snap). */
  overlap: number;
  styleId: StyleId;
  /**
   * Vilken datakälla baskartan ritas från. `styleId` används endast när
   * `mapSource === 'osm'`; för `lm` är stilen `lantmateriet-topo10`.
   */
  mapSource: MapSource;
  /** Visa gatunamn och andra baskart-etiketter. */
  labels: boolean;
  /** Relativ storlek för baskartans etiketter. */
  labelSize: LabelSize;
  /** Relativ storlek för baskartans vägar. */
  roadSize: LabelSize;
  /** Visa vattendrag som ett extra hjälplager ovanpå baskartan. */
  watercourses: boolean;
  /** Visa MGRS-koordinater i utskrift och förhandsvisning. */
  mgrsGrid: boolean;
  /** Fullt rutnät eller endast MGRS i ramen. */
  mgrsMode: 'full' | 'frame';
  /** Gör MGRS-rutorna större eller mindre vid samma zoom. */
  mgrsGridSizeBias: -1 | 0 | 1;
  /** Visa höjdkurvor (genereras via maplibre-contour). */
  contours: boolean;
  pages: PageSpec[];
}

/** Användarens overlay-data (GPX, ritat, ikoner) som GeoJSON-features. */
export interface Overlays {
  tracks: FeatureCollection<LineString>;
  waypoints: FeatureCollection<Point>;
}

/** Request-body till POST /render. */
export interface RenderRequest {
  atlas: AtlasSpec;
  overlays: Overlays;
}

/** Konstanter. */
export const PRINT_DPI = 300;
export const MM_PER_INCH = 25.4;

export interface StyleLayerLike {
  id?: string;
  type?: string;
  source?: string;
  'source-layer'?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

export function isBaseMapTextLayer(layer: StyleLayerLike): boolean {
  if (layer.type !== 'symbol') return false;
  if (layer.id?.startsWith('kvg-')) return false;
  return Object.prototype.hasOwnProperty.call(layer.layout ?? {}, 'text-field');
}

export function isBaseRoadLayer(layer: StyleLayerLike): boolean {
  if (layer.type !== 'line') return false;
  if (layer.id?.startsWith('kvg-')) return false;
  const sourceLayer = layer['source-layer'];
  if (layer.source === 'osm' && sourceLayer === 'roads') return true;
  // Lantmäteriet-stilen använder samma två lager (roads + roads_minor) som vi
  // skalar via vägbredds-reglaget.
  if (layer.source === 'lm' && (sourceLayer === 'roads' || sourceLayer === 'roads_minor')) return true;
  return false;
}

export function applyLabelSizeToStyleLayers<T extends StyleLayerLike>(layers: T[], labelSize: LabelSize): T[] {
  return layers.map((layer) => {
    if (!isBaseMapTextLayer(layer)) return layer;
    if (!layer.layout) return layer;
    const textSize = layer.layout['text-size'];
    if (textSize == null) return layer;

    return {
      ...layer,
      layout: {
        ...layer.layout,
        'text-size': scaleStyleValue(textSize, labelSize),
      },
    };
  });
}

export function applyRoadSizeToStyleLayers<T extends StyleLayerLike>(layers: T[], roadSize: LabelSize): T[] {
  return layers.map((layer) => {
    if (!isBaseRoadLayer(layer)) return layer;
    if (!layer.paint) return layer;
    const lineWidth = layer.paint['line-width'];
    if (lineWidth == null) return layer;

    return {
      ...layer,
      paint: {
        ...layer.paint,
        'line-width': scaleStyleValue(lineWidth, roadSize),
      },
    };
  });
}

export function normalizeLabelSize(value: unknown): LabelSize {
  return normalizeSizeFactor(value, LABEL_SIZE_FACTORS, DEFAULT_LABEL_SIZE, LABEL_SIZE_RANGE.min, LABEL_SIZE_RANGE.max);
}

export function normalizeRoadSize(value: unknown): LabelSize {
  return normalizeSizeFactor(value, ROAD_SIZE_FACTORS, DEFAULT_ROAD_SIZE, ROAD_SIZE_RANGE.min, ROAD_SIZE_RANGE.max);
}

function scaleStyleValue(value: unknown, factor: number): unknown {
  if (typeof value === 'number') {
    return roundLabelSize(value * factor);
  }
  if (Array.isArray(value)) {
    const [operator, ...rest] = value;
    if (operator === 'interpolate' && rest.length >= 3) {
      const head = rest.slice(0, 2);
      const stops = rest.slice(2).map((item, index) =>
        index % 2 === 1 ? scaleStyleValue(item, factor) : item,
      );
      return [operator, ...head, ...stops];
    }
    if (operator === 'step' && rest.length >= 2) {
      const input = rest[0];
      const base = scaleStyleValue(rest[1], factor);
      const stops = rest.slice(2).map((item, index) =>
        index % 2 === 1 ? scaleStyleValue(item, factor) : item,
      );
      return [operator, input, base, ...stops];
    }
    return value.map((item) => scaleStyleValue(item, factor));
  }
  return value;
}

function roundLabelSize(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeSizeFactor(
  value: unknown,
  presets: Record<SizePreset, number>,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return roundLabelSize(clamp(value, min, max));
  }
  if (typeof value === 'string' && value in presets) {
    return presets[value as SizePreset];
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Beräknar UTM-zon (1..60) för en given longitud i grader. Hanterar wrap-around
 * vid antimeridianen så att lon ≥ 180 eller lon < -180 normaliseras korrekt
 * istället för att producera ogiltiga zoner som 0 eller 61.
 */
export function utmZoneFromLon(lon: number): number {
  const normalized = ((lon + 180) % 360 + 360) % 360; // i [0, 360)
  const zone = Math.floor(normalized / 6) + 1;
  return zone === 61 ? 60 : zone;
}

export function formatMgrs(mgrs: string): string {
  const match = mgrs.match(/^(\d{1,2})([C-X])([A-Z]{2})(\d*)$/i);
  if (!match) return mgrs;

  const zone = match[1];
  const band = match[2];
  const square = match[3];
  if (!zone || !band || !square) return mgrs;
  const digits = match[4] ?? '';
  if (!digits) return `${zone}${band.toUpperCase()} ${square.toUpperCase()}`;

  const half = Math.floor(digits.length / 2);
  const easting = digits.slice(0, half);
  const northing = digits.slice(half);
  return `${zone}${band.toUpperCase()} ${square.toUpperCase()} ${easting} ${northing}`;
}

/**
 * Geografisk storlek (i meter) för en sida vid given skala och pappersorientering.
 * Marginalen subtraheras från den utskrivna kart-ytan.
 */
export function pageMetersOnGround(atlas: Pick<AtlasSpec, 'scale' | 'paper' | 'orientation' | 'margin'>): {
  widthM: number;
  heightM: number;
  mapWidthMm: number;
  mapHeightMm: number;
} {
  const size = PAPER_SIZES[atlas.paper];
  const w = atlas.orientation === 'landscape' ? size.height : size.width;
  const h = atlas.orientation === 'landscape' ? size.width : size.height;
  const mapWidthMm = w - 2 * atlas.margin;
  const mapHeightMm = h - 2 * atlas.margin;
  return {
    mapWidthMm,
    mapHeightMm,
    widthM: (mapWidthMm * atlas.scale) / 1000,
    heightM: (mapHeightMm * atlas.scale) / 1000,
  };
}

export function computeMgrsGrid(args: {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
  sizeBias: -1 | 0 | 1;
}): FeatureCollection {
  const config = gridConfigForZoom(args.zoom, args.sizeBias);
  if (!config) return { type: 'FeatureCollection', features: [] };

  const { west, south, east, north } = args;
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  const zone = utmZoneFromLon(centerLon);
  const isSouthernHemisphere = centerLat < 0;
  const utmDef = `+proj=utm +zone=${zone}${isSouthernHemisphere ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;

  const corners: [number, number][] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
  const utmCorners = corners.map((corner) => proj4('WGS84', utmDef, corner));
  const minE = Math.min(...utmCorners.map((corner) => corner[0]));
  const maxE = Math.max(...utmCorners.map((corner) => corner[0]));
  const minN = Math.min(...utmCorners.map((corner) => corner[1]));
  const maxN = Math.max(...utmCorners.map((corner) => corner[1]));

  const features: Feature[] = [];
  const { stepMeters, precision } = config;
  const maxLines = 250;

  const firstE = Math.ceil(minE / stepMeters) * stepMeters;
  const lineCountE = Math.min(maxLines, Math.ceil((maxE - firstE) / stepMeters) + 1);
  for (let i = 0; i < lineCountE; i++) {
    const easting = firstE + i * stepMeters;
    if (easting > maxE) break;
    const segments: [number, number][] = [];
    const samples = 32;
    for (let sample = 0; sample <= samples; sample++) {
      const northing = minN + ((maxN - minN) * sample) / samples;
      const lonLat = proj4(utmDef, 'WGS84', [easting, northing]);
      segments.push([lonLat[0]!, lonLat[1]!]);
    }
    features.push({
      type: 'Feature',
      properties: { kind: 'easting', value: easting },
      geometry: { type: 'LineString', coordinates: segments } satisfies LineString,
    });
  }

  const firstN = Math.ceil(minN / stepMeters) * stepMeters;
  const lineCountN = Math.min(maxLines, Math.ceil((maxN - firstN) / stepMeters) + 1);
  for (let i = 0; i < lineCountN; i++) {
    const northing = firstN + i * stepMeters;
    if (northing > maxN) break;
    const segments: [number, number][] = [];
    const samples = 32;
    for (let sample = 0; sample <= samples; sample++) {
      const easting = minE + ((maxE - minE) * sample) / samples;
      const lonLat = proj4(utmDef, 'WGS84', [easting, northing]);
      segments.push([lonLat[0]!, lonLat[1]!]);
    }
    features.push({
      type: 'Feature',
      properties: { kind: 'northing', value: northing },
      geometry: { type: 'LineString', coordinates: segments } satisfies LineString,
    });
  }

  const centerN = (minN + maxN) / 2;
  const centerE = (minE + maxE) / 2;
  const labelStride = Math.max(1, Math.ceil(Math.max(lineCountE, lineCountN) / 12));
  for (let i = 0; i < lineCountE; i++) {
    if (i % labelStride !== 0) continue;
    const easting = firstE + i * stepMeters;
    if (easting > maxE) break;
    const lonLat = proj4(utmDef, 'WGS84', [easting, centerN]);
    features.push({
      type: 'Feature',
      properties: { label: gridLabel([lonLat[0]!, lonLat[1]!], precision) },
      geometry: { type: 'Point', coordinates: [lonLat[0]!, lonLat[1]!] } satisfies Point,
    });
  }
  for (let i = 0; i < lineCountN; i++) {
    if (i % labelStride !== 0) continue;
    const northing = firstN + i * stepMeters;
    if (northing > maxN) break;
    const lonLat = proj4(utmDef, 'WGS84', [centerE, northing]);
    features.push({
      type: 'Feature',
      properties: { label: gridLabel([lonLat[0]!, lonLat[1]!], precision) },
      geometry: { type: 'Point', coordinates: [lonLat[0]!, lonLat[1]!] } satisfies Point,
    });
  }

  return { type: 'FeatureCollection', features };
}

function gridConfigForZoom(zoom: number, sizeBias: -1 | 0 | 1): { stepMeters: number; precision: number } | null {
  const effectiveZoom = zoom + sizeBias * 2;
  if (effectiveZoom < 7) return null;
  if (effectiveZoom < 10) return { stepMeters: 10000, precision: 1 };
  if (effectiveZoom < 13) return { stepMeters: 1000, precision: 2 };
  if (effectiveZoom < 16) return { stepMeters: 100, precision: 3 };
  return { stepMeters: 10, precision: 4 };
}

function gridLabel(lonLat: [number, number], precision: number): string {
  try {
    return formatMgrs(mgrs.forward(lonLat, precision));
  } catch {
    return '—';
  }
}

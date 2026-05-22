import { useEffect, useRef } from 'react';
import maplibregl, { Map as MLMap, MapLayerMouseEvent } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import mlcontour from 'maplibre-contour';
import type { FeatureCollection } from 'geojson';
import { LABEL_SIZE_FACTORS, ROAD_SIZE_FACTORS, isBaseMapTextLayer, isBaseRoadLayer, type LabelSize } from '@kvg/shared';
import { useStore } from '../state/store.js';
import { computeMgrsGrid } from './mgrsGrid.js';
import { computeAtlasPageRects } from './atlasGeom.js';
import { latlonToMgrs } from '../utils/coords.js';

// Registrera PMTiles-protokollet globalt (en gång).
const protocol = new Protocol();
if (!(maplibregl as unknown as { __pmtilesRegistered?: boolean }).__pmtilesRegistered) {
  maplibregl.addProtocol('pmtiles', protocol.tile);
  (maplibregl as unknown as { __pmtilesRegistered?: boolean }).__pmtilesRegistered = true;
}

// Registrera maplibre-contour protokollet globalt (en gång).
const demSource = new mlcontour.DemSource({
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  maxzoom: 13,
  worker: true,
});
if (!(maplibregl as unknown as { __contourRegistered?: boolean }).__contourRegistered) {
  demSource.setupMaplibre(maplibregl);
  (maplibregl as unknown as { __contourRegistered?: boolean }).__contourRegistered = true;
}

const STOCKHOLM_CENTER: [number, number] = [18.0686, 59.3293];

export function MapView({ onCursor }: { onCursor: (s: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const warnedCoverageRef = useRef(new Set<string>());
  // Sätts till true när kartan har laddat sin första stil (load-event).
  // Style-effekten ska bara anropa setStyle EFTER att load har avfyrats –
  // annars kolliderar setStyle med konstruktorns asynkrona stil-laddning.
  const mapLoadedRef = useRef(false);

  const styleId = useStore((s) => s.styleId);
  const labels = useStore((s) => s.labels);
  const labelSize = useStore((s) => s.labelSize);
  const roadSize = useStore((s) => s.roadSize);
  const contours = useStore((s) => s.contours);
  const mgrsGrid = useStore((s) => s.mgrsGrid);
  const mgrsMode = useStore((s) => s.mgrsMode);
  const mgrsGridSizeBias = useStore((s) => s.mgrsGridSizeBias);
  const overlays = useStore((s) => s.overlays);
  const atlas = useStore((s) => s.atlas);
  const drawMode = useStore((s) => s.drawMode);
  const iconName = useStore((s) => s.iconName);
  const addWaypoint = useStore((s) => s.addWaypoint);
  const addTrack = useStore((s) => s.addTrack);
  const setMapView = useStore((s) => s.setMapView);

  // Init.
  useEffect(() => {
    if (!containerRef.current) return;
    const initialView = useStore.getState().mapView;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: `/styles/${styleId}.json`,
      center: initialView.center ?? STOCKHOLM_CENTER,
      zoom: initialView.zoom ?? 11,
      bearing: initialView.bearing ?? 0,
      pitch: initialView.pitch ?? 0,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    (window as unknown as { __kvgMap?: MLMap }).__kvgMap = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('mousemove', (e) => {
      onCursor(`${latlonToMgrs(e.lngLat.lng, e.lngLat.lat)}  ·  ${e.lngLat.lng.toFixed(5)}, ${e.lngLat.lat.toFixed(5)}`);
    });

    map.on('load', () => {
      mapLoadedRef.current = true;
      restoreMapState(map);
    });

    map.on('moveend', () => {
      const state = useStore.getState();
      updateGrid(map, state.mgrsGrid, state.mgrsMode, state.mgrsGridSizeBias);
      state.setMapView({
        center: [map.getCenter().lng, map.getCenter().lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      });
    });
    if (import.meta.env.DEV) {
      map.on('idle', () => warnAboutMissingStyleCoverage(map, warnedCoverageRef.current));
    }

    return () => {
      mapLoadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // styleId-byte hanteras separat nedan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setMapView]);

  // Stilbyte: ladda om style, återinför lagren.
  useEffect(() => {
    // Hoppa över om kartan ännu inte har laddat sin ursprungliga stil –
    // konstruktorn hanterar den. Detta är robust mot React StrictMode (dubbla körningar).
    if (!mapLoadedRef.current) return;
    const map = mapRef.current;
    if (!map) return;
    const restoreAfterStyleLoad = () => {
      if (mapRef.current !== map) return;
      restoreMapState(map);
    };
    map.once('style.load', restoreAfterStyleLoad);
    map.setStyle(`/styles/${styleId}.json`, { diff: false });
    return () => {
      map.off('style.load', restoreAfterStyleLoad);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleId]);

  // Reagera på overlay-/atlas-ändringar.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('kvg-tracks')) return;
    updateOverlays(map, overlays);
  }, [overlays]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('kvg-atlas')) return;
    updateAtlas(map, atlas);
  }, [atlas]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyBaseTextVisibility(map, labels);
  }, [labels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyBaseTextSize(map, labelSize);
  }, [labelSize]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyBaseRoadSize(map, roadSize);
  }, [roadSize]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('kvg-grid')) return;
    updateGrid(map, mgrsGrid, mgrsMode, mgrsGridSizeBias);
  }, [mgrsGrid, mgrsMode, mgrsGridSizeBias]);

  // Höjdkurvor: lägg till/ta bort contour-lager vid toggle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const syncContours = () => {
      if (contours) {
        addContourLayers(map);
      } else {
        removeContourLayers(map);
      }
    };
    if (!map.isStyleLoaded()) {
      map.once('idle', syncContours);
      return () => {
        map.off('idle', syncContours);
      };
    }
    syncContours();
  }, [contours]);

  // Klickhantering för ritläge.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let trackBuffer: [number, number][] = [];

    const onClick = (e: MapLayerMouseEvent) => {
      const ll: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (drawMode === 'waypoint') {
        addWaypoint({ type: 'Point', coordinates: ll });
      } else if (drawMode === 'icon' && iconName) {
        addWaypoint({ type: 'Point', coordinates: ll }, { icon: iconName });
      } else if (drawMode === 'track') {
        trackBuffer.push(ll);
      }
    };
    const onDbl = (e: MapLayerMouseEvent) => {
      if (drawMode === 'track' && trackBuffer.length >= 2) {
        e.preventDefault();
        addTrack({ type: 'LineString', coordinates: [...trackBuffer] });
        trackBuffer = [];
      }
    };

    map.on('click', onClick);
    map.on('dblclick', onDbl);
    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDbl);
    };
  }, [drawMode, iconName, addWaypoint, addTrack]);

  return <div ref={containerRef} id="map" />;
}

// ---------------- helpers ----------------

const ICON_NAMES = ['tent', 'fire', 'water', 'parking', 'warning'] as const;
const MONITORED_KINDS: Record<'landcover' | 'landuse', readonly string[]> = {
  landcover: ['wood', 'scrub', 'grass', 'crop', 'wetland'],
  landuse: [
    'forest',
    'wood',
    'scrub',
    'nature_reserve',
    'meadow',
    'grass',
    'grassland',
    'farmland',
    'garden',
    'allotments',
    'golf_course',
    'recreation_ground',
    'pitch',
    'playground',
    'wetland',
    'park',
    'national_park',
    'protected_area',
  ],
};

type CoverageInfo = { wildcard: boolean; kinds: Set<string> };

type TextVisibilityMap = Map<string, 'visible' | 'none' | undefined>;

type TextSizeMap = Map<string, unknown>;

type RoadSizeMap = Map<string, unknown>;

type MapWithLabelState = MLMap & {
  __kvgBaseTextVisibility?: TextVisibilityMap;
  __kvgBaseTextSize?: TextSizeMap;
  __kvgBaseRoadSize?: RoadSizeMap;
};

function restoreMapState(map: MLMap) {
  rememberBaseTextVisibility(map);
  const { atlas, overlays, contours, mgrsGrid, mgrsMode, mgrsGridSizeBias, labels } = useStore.getState();
  rememberBaseTextSize(map);
  rememberBaseRoadSize(map);
  applyBaseTextSize(map, atlas.labelSize);
  applyBaseRoadSize(map, atlas.roadSize);
  applyBaseTextVisibility(map, labels);
  setupOverlayLayers(map);
  setupGridLayer(map);
  setupAtlasLayer(map);
  updateGrid(map, mgrsGrid, mgrsMode, mgrsGridSizeBias);
  updateAtlas(map, atlas);
  updateOverlays(map, overlays);
  if (contours) {
    addContourLayers(map);
  }
}

async function loadIcons(map: MLMap) {
  for (const name of ICON_NAMES) {
    if (map.hasImage(name)) continue;
    try {
      const img = await map.loadImage(`/icons/${name}.png`);
      if (!map.hasImage(name)) map.addImage(name, img.data);
    } catch {
      /* ignore – ikon kan saknas under utveckling */
    }
  }
}

function warnAboutMissingStyleCoverage(map: MLMap, warned: Set<string>) {
  const style = map.getStyle();
  if (!style?.layers) return;
  const coverage = collectStyleCoverage(style.layers as Array<Record<string, unknown>>);

  for (const sourceLayer of Object.keys(MONITORED_KINDS) as Array<keyof typeof MONITORED_KINDS>) {
    const presentKinds = new Set(
      map
        .querySourceFeatures('osm', { sourceLayer })
        .map((feature) => feature.properties?.kind)
        .filter((kind): kind is string => typeof kind === 'string' && MONITORED_KINDS[sourceLayer].includes(kind)),
    );
    if (presentKinds.size === 0) continue;

    const layerCoverage = coverage.get(sourceLayer);
    if (layerCoverage?.wildcard) continue;

    const missingKinds = [...presentKinds].filter((kind) => !layerCoverage?.kinds.has(kind)).sort();
    if (missingKinds.length === 0) continue;

    const warningKey = `${style.name}:${sourceLayer}:${missingKinds.join(',')}`;
    if (warned.has(warningKey)) continue;
    warned.add(warningKey);
    console.warn(
      `[kvg/style] ${style.name} saknar stilregler för ${sourceLayer}: ${missingKinds.join(', ')}`,
    );
  }
}

function collectStyleCoverage(layers: Array<Record<string, unknown>>) {
  const coverage = new Map<string, CoverageInfo>();

  for (const layer of layers) {
    if (layer.source !== 'osm') continue;
    const sourceLayer = layer['source-layer'];
    if (sourceLayer !== 'landcover' && sourceLayer !== 'landuse') continue;

    const current = coverage.get(sourceLayer) ?? { wildcard: false, kinds: new Set<string>() };
    const kinds = extractKindsFromFilter(layer.filter);
    if (kinds === '*') {
      current.wildcard = true;
    } else if (kinds) {
      for (const kind of kinds) current.kinds.add(kind);
    }
    coverage.set(sourceLayer, current);
  }

  return coverage;
}

function rememberBaseTextVisibility(map: MLMap) {
  const visibility = new Map<string, 'visible' | 'none' | undefined>();
  const layers = map.getStyle().layers ?? [];
  for (const layer of layers) {
    if (!isBaseMapTextLayer(layer)) continue;
    visibility.set(layer.id, normalizeVisibility(layer.layout?.visibility));
  }
  (map as MapWithLabelState).__kvgBaseTextVisibility = visibility;
}

function rememberBaseTextSize(map: MLMap) {
  const textSizes = new Map<string, unknown>();
  const layers = map.getStyle().layers ?? [];
  for (const layer of layers) {
    if (!isBaseMapTextLayer(layer)) continue;
    textSizes.set(layer.id, (layer.layout as Record<string, unknown> | undefined)?.['text-size']);
  }
  (map as MapWithLabelState).__kvgBaseTextSize = textSizes;
}

function rememberBaseRoadSize(map: MLMap) {
  const roadSizes = new Map<string, unknown>();
  const layers = map.getStyle().layers ?? [];
  for (const layer of layers) {
    if (!isBaseRoadLayer(layer)) continue;
    roadSizes.set(layer.id, (layer.paint as Record<string, unknown> | undefined)?.['line-width']);
  }
  (map as MapWithLabelState).__kvgBaseRoadSize = roadSizes;
}

function applyBaseTextVisibility(map: MLMap, visible: boolean) {
  const layers = map.getStyle().layers ?? [];
  const storedVisibility = (map as MapWithLabelState).__kvgBaseTextVisibility ?? new Map<string, 'visible' | 'none' | undefined>();
  for (const layer of layers) {
    if (!isBaseMapTextLayer(layer) || !layer.id) continue;
    const visibility = visible ? storedVisibility.get(layer.id) ?? 'visible' : 'none';
    map.setLayoutProperty(layer.id, 'visibility', visibility);
  }
}

function applyBaseTextSize(map: MLMap, labelSize: LabelSize) {
  const factor = LABEL_SIZE_FACTORS[labelSize];
  const layers = map.getStyle().layers ?? [];
  const baseTextSizes = (map as MapWithLabelState).__kvgBaseTextSize ?? new Map<string, unknown>();
  for (const layer of layers) {
    if (!isBaseMapTextLayer(layer) || !layer.id) continue;
    const originalTextSize = baseTextSizes.get(layer.id);
    if (originalTextSize == null) continue;
    map.setLayoutProperty(layer.id, 'text-size', scaleTextSizeExpression(originalTextSize, factor));
  }
}

function applyBaseRoadSize(map: MLMap, roadSize: LabelSize) {
  const factor = ROAD_SIZE_FACTORS[roadSize];
  const layers = map.getStyle().layers ?? [];
  const baseRoadSizes = (map as MapWithLabelState).__kvgBaseRoadSize ?? new Map<string, unknown>();
  for (const layer of layers) {
    if (!isBaseRoadLayer(layer) || !layer.id) continue;
    const originalRoadSize = baseRoadSizes.get(layer.id);
    if (originalRoadSize == null) continue;
    map.setPaintProperty(layer.id, 'line-width', scaleTextSizeExpression(originalRoadSize, factor));
  }
}

function scaleTextSizeExpression(value: unknown, factor: number): unknown {
  if (typeof value === 'number') return roundTextSize(value * factor);
  if (!Array.isArray(value)) return value;

  const [operator, ...rest] = value;
  if (operator === 'interpolate' && rest.length >= 3) {
    const head = rest.slice(0, 2);
    const stops = rest.slice(2).map((item, index) =>
      index % 2 === 1 ? scaleTextSizeExpression(item, factor) : item,
    );
    return [operator, ...head, ...stops];
  }
  if (operator === 'step' && rest.length >= 2) {
    const input = rest[0];
    const base = scaleTextSizeExpression(rest[1], factor);
    const stops = rest.slice(2).map((item, index) =>
      index % 2 === 1 ? scaleTextSizeExpression(item, factor) : item,
    );
    return [operator, input, base, ...stops];
  }
  return value.map((item) => scaleTextSizeExpression(item, factor));
}

function roundTextSize(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeVisibility(value: unknown): 'visible' | 'none' | undefined {
  return value === 'none' || value === 'visible' ? value : undefined;
}

function extractKindsFromFilter(filter: unknown): '*' | string[] | null {
  if (filter == null) return '*';
  if (!Array.isArray(filter) || filter.length === 0) return null;

  const [operator, ...rest] = filter;
  if (operator === '==') {
    return isKindGetExpression(rest[0]) && typeof rest[1] === 'string' ? [rest[1]] : null;
  }
  if (operator === 'in') {
    return isKindGetExpression(rest[0]) ? rest.slice(1).filter((value): value is string => typeof value === 'string') : null;
  }
  if (operator === 'match') {
    if (!isKindGetExpression(rest[0])) return null;
    const values = rest.slice(1, -1).flatMap((value) =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : typeof value === 'string' ? [value] : [],
    );
    return values.length > 0 ? values : null;
  }
  if (operator === 'any') {
    const values = rest.flatMap((part) => {
      const parsed = extractKindsFromFilter(part);
      return parsed && parsed !== '*' ? parsed : [];
    });
    return values.length > 0 ? [...new Set(values)] : null;
  }
  if (operator === 'all') {
    const values = rest.flatMap((part) => {
      const parsed = extractKindsFromFilter(part);
      return parsed && parsed !== '*' ? parsed : [];
    });
    return values.length > 0 ? [...new Set(values)] : null;
  }

  return null;
}

function isKindGetExpression(value: unknown): value is ['get', 'kind'] {
  return Array.isArray(value) && value[0] === 'get' && value[1] === 'kind';
}

function setupOverlayLayers(map: MLMap) {
  if (!map.getSource('kvg-tracks')) {
    map.addSource('kvg-tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'kvg-tracks-line',
      type: 'line',
      source: 'kvg-tracks',
      paint: { 'line-color': '#c0392b', 'line-width': 2.5, 'line-opacity': 0.9 },
    });
  }
  if (!map.getSource('kvg-waypoints')) {
    map.addSource('kvg-waypoints', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'kvg-waypoints-circle',
      type: 'circle',
      source: 'kvg-waypoints',
      filter: ['!', ['has', 'icon']],
      paint: {
        'circle-radius': 5,
        'circle-color': '#c0392b',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'kvg-waypoints-icon',
      type: 'symbol',
      source: 'kvg-waypoints',
      filter: ['has', 'icon'],
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': 0.6,
        'icon-allow-overlap': true,
      },
    });
    loadIcons(map);
  }
}

function updateOverlays(map: MLMap, overlays: { tracks: FeatureCollection; waypoints: FeatureCollection }) {
  const t = map.getSource('kvg-tracks') as maplibregl.GeoJSONSource | undefined;
  const w = map.getSource('kvg-waypoints') as maplibregl.GeoJSONSource | undefined;
  if (t) t.setData(overlays.tracks);
  if (w) w.setData(overlays.waypoints);
}

function setupGridLayer(map: MLMap) {
  if (!map.getSource('kvg-grid')) {
    map.addSource('kvg-grid', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'kvg-grid-line',
      type: 'line',
      source: 'kvg-grid',
      paint: { 'line-color': '#000', 'line-width': 0.6, 'line-opacity': 0.6 },
    });
    map.addLayer({
      id: 'kvg-grid-label',
      type: 'symbol',
      source: 'kvg-grid',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 10,
        'text-font': ['Noto Sans Regular'],
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': '#000',
        'text-halo-color': '#fff',
        'text-halo-width': 1.5,
      },
    });
  }
}

function updateGrid(map: MLMap, enabled: boolean, mode: 'full' | 'frame', sizeBias: -1 | 0 | 1) {
  if (!enabled || mode !== 'full') {
    const src = map.getSource('kvg-grid') as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  const b = map.getBounds();
  const fc = computeMgrsGrid({
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
    zoom: map.getZoom(),
    sizeBias,
  });
  const src = map.getSource('kvg-grid') as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(fc);
}

function setupAtlasLayer(map: MLMap) {
  if (!map.getSource('kvg-atlas')) {
    map.addSource('kvg-atlas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'kvg-atlas-fill',
      type: 'fill',
      source: 'kvg-atlas',
      paint: { 'fill-color': '#e74c3c', 'fill-opacity': 0.08 },
    });
    map.addLayer({
      id: 'kvg-atlas-line',
      type: 'line',
      source: 'kvg-atlas',
      paint: { 'line-color': '#e74c3c', 'line-width': 2 },
    });
    map.addLayer({
      id: 'kvg-atlas-label',
      type: 'symbol',
      source: 'kvg-atlas',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 14,
        'text-font': ['Noto Sans Medium'],
      },
      paint: { 'text-color': '#c0392b', 'text-halo-color': '#fff', 'text-halo-width': 2 },
    });
  }
}

function updateAtlas(map: MLMap, atlas: ReturnType<typeof useStore.getState>['atlas']) {
  const fc = computeAtlasPageRects(atlas);
  const src = map.getSource('kvg-atlas') as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(fc);
}

// ----------- höjdkurvor (maplibre-contour) -----------

const CONTOUR_URL = demSource.contourProtocolUrl({
  thresholds: {
    11: [50, 200],
    12: [25, 100],
    13: [10, 50],
    14: [5, 20],
  },
  multiplier: 1,      // terrarium är redan i meter
  overzoom: 1,
});

function addContourLayers(map: MLMap) {
  if (map.getSource('kvg-contours')) return;
  map.addSource('kvg-contours', {
    type: 'vector',
    tiles: [CONTOUR_URL],
    minzoom: 1,
    maxzoom: 14,
  });
  map.addLayer({
    id: 'kvg-contour-minor',
    type: 'line',
    source: 'kvg-contours',
    'source-layer': 'contours',
    filter: ['!=', ['get', 'level'], 1],
    paint: {
      'line-color': '#c47533',
      'line-width': 0.6,
      'line-opacity': 0.7,
    },
  });
  map.addLayer({
    id: 'kvg-contour-major',
    type: 'line',
    source: 'kvg-contours',
    'source-layer': 'contours',
    filter: ['==', ['get', 'level'], 1],
    paint: {
      'line-color': '#a0522d',
      'line-width': 1.2,
      'line-opacity': 0.9,
    },
  });
}

function removeContourLayers(map: MLMap) {
  if (map.getLayer('kvg-contour-major')) map.removeLayer('kvg-contour-major');
  if (map.getLayer('kvg-contour-minor')) map.removeLayer('kvg-contour-minor');
  if (map.getSource('kvg-contours')) map.removeSource('kvg-contours');
}

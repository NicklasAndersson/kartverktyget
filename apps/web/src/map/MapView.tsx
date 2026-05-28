import { useEffect, useRef } from 'react';
import maplibregl, { Map as MLMap, MapLayerMouseEvent } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import mlcontour from 'maplibre-contour';
import type { FeatureCollection } from 'geojson';
import { isBaseMapTextLayer, isBaseRoadLayer, type LabelSize, type MapSource } from '@kvg/shared';
import { useStore } from '../state/store.js';
import { computeMgrsGrid } from './mgrsGrid.js';
import { computeAtlasPageRects } from './atlasGeom.js';
import { latlonToMgrs } from '../utils/coords.js';

// Registrera PMTiles-protokollet globalt (en gång per modul-laddning). Att
// hålla flaggan modul-lokal undviker kollisioner och varningar från MapLibre
// vid Vite HMR när filen omladdas men maplibregl-instansen återanvänds.
let pmtilesRegistered = false;
const protocol = new Protocol();
if (!pmtilesRegistered) {
  maplibregl.addProtocol('pmtiles', protocol.tile);
  pmtilesRegistered = true;
}

// Registrera maplibre-contour protokollet globalt (en gång per modul-laddning).
let contourRegistered = false;
const demSource = new mlcontour.DemSource({
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  maxzoom: 13,
  worker: true,
});
if (!contourRegistered) {
  demSource.setupMaplibre(maplibregl);
  contourRegistered = true;
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
  const mapSource = useStore((s) => s.mapSource);
  const labels = useStore((s) => s.labels);
  const labelSize = useStore((s) => s.labelSize);
  const roadSize = useStore((s) => s.roadSize);
  const watercourses = useStore((s) => s.watercourses);
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
      style: styleUrlFor(useStore.getState().mapSource, styleId),
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

    setupAtlasDrag(map);

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
    map.setStyle(styleUrlFor(mapSource, styleId), { diff: false });
    return () => {
      map.off('style.load', restoreAfterStyleLoad);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleId, mapSource]);

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

  // Re-applicera text/vägbredd-skalningen även när stilen byts (mapSource/styleId)
  // eller om effekten kör innan stilen är klar. Annars fastnar gamla värden tills
  // användaren rör en slider eller laddar om sidan.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => applyBaseTextSize(map, labelSize);
    if (map.isStyleLoaded()) apply();
    else map.once('idle', apply);
    return () => {
      map.off('idle', apply);
    };
  }, [labelSize, mapSource, styleId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => applyBaseRoadSize(map, roadSize);
    if (map.isStyleLoaded()) apply();
    else map.once('idle', apply);
    return () => {
      map.off('idle', apply);
    };
  }, [roadSize, mapSource, styleId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    syncWatercourseLayer(map, watercourses);
  }, [watercourses]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('kvg-grid')) return;
    updateGrid(map, mgrsGrid, mgrsMode, mgrsGridSizeBias);
  }, [mgrsGrid, mgrsMode, mgrsGridSizeBias]);

  // Höjdkurvor: toggle styr olika saker beroende på källa.
  // - LM topo10: lagret innehåller redan färdiga höjdkurvor från Lantmäteriet
  //   (lager-id contours-minor/contours-major/contour-labels i stylen). Vi
  //   togglar bara visibility på dessa – inget DEM-overlay läggs ovanpå.
  // - Övriga källor (protomaps/OSM m.fl.): saknar konturer, så vi lägger
  //   till/tar bort overlay från terrarium-DEM via maplibre-contour.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const syncContours = () => {
      if (mapSource === 'lm') {
        removeContourLayers(map); // säkerställ att ev. tidigare DEM-overlay tas bort
        setLmContourVisibility(map, contours);
      } else {
        if (contours) addContourLayers(map);
        else removeContourLayers(map);
      }
    };
    if (!map.isStyleLoaded()) {
      map.once('idle', syncContours);
      return () => {
        map.off('idle', syncContours);
      };
    }
    syncContours();
  }, [contours, mapSource]);

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

function styleUrlFor(mapSource: MapSource, styleId: string): string {
  if (mapSource === 'lm') return '/styles/lantmateriet-topo10.json';
  return `/styles/${styleId}.json`;
}

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

// Värden är MapLibre style-uttryck: primär (number/string), array (interpolate/step) eller saknad.
type TextSizeMap = Map<string, number | string | unknown[] | null | undefined>;

type RoadSizeMap = Map<string, number | string | unknown[] | null | undefined>;

type MapWithLabelState = MLMap & {
  __kvgBaseTextVisibility?: TextVisibilityMap;
  __kvgBaseTextSize?: TextSizeMap;
  __kvgBaseRoadSize?: RoadSizeMap;
};

function restoreMapState(map: MLMap) {
  rememberBaseTextVisibility(map);
  const { atlas, overlays, contours, mgrsGrid, mgrsMode, mgrsGridSizeBias, labels, watercourses, mapSource } = useStore.getState();
  rememberBaseTextSize(map);
  rememberBaseRoadSize(map);
  applyBaseTextSize(map, atlas.labelSize);
  applyBaseRoadSize(map, atlas.roadSize);
  applyBaseTextVisibility(map, labels);
  setupOverlayLayers(map);
  setupGridLayer(map);
  setupAtlasLayer(map);
  syncWatercourseLayer(map, watercourses);
  updateGrid(map, mgrsGrid, mgrsMode, mgrsGridSizeBias);
  updateAtlas(map, atlas);
  updateOverlays(map, overlays);
  if (mapSource === 'lm') {
    setLmContourVisibility(map, contours);
  } else if (contours) {
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
  const textSizes: TextSizeMap = new Map();
  const layers = map.getStyle().layers ?? [];
  for (const layer of layers) {
    if (!isBaseMapTextLayer(layer)) continue;
    const textSize = (layer.layout as Record<string, unknown> | undefined)?.['text-size'];
    textSizes.set(layer.id, normalizeStyleValue(textSize));
  }
  (map as MapWithLabelState).__kvgBaseTextSize = textSizes;
}

function rememberBaseRoadSize(map: MLMap) {
  const roadSizes: RoadSizeMap = new Map();
  const layers = map.getStyle().layers ?? [];
  for (const layer of layers) {
    if (!isBaseRoadLayer(layer)) continue;
    const lineWidth = (layer.paint as Record<string, unknown> | undefined)?.['line-width'];
    roadSizes.set(layer.id, normalizeStyleValue(lineWidth));
  }
  (map as MapWithLabelState).__kvgBaseRoadSize = roadSizes;
}

// MapLibre style-property-värden är primärer eller arrayer (uttryck). Andra typer
// (objekt, function) förekommer inte i våra stilar och faller tillbaka till null.
function normalizeStyleValue(value: unknown): number | string | unknown[] | null | undefined {
  if (value == null) return value as null | undefined;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value;
  return null;
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

// Stilarna är kalibrerade för utskrift i 300 DPI. På skärm (≈96 DPI) blir
// samma `text-size`/`line-width` ungefär 3× större fysiskt, vilket gör att
// preview-kartan ser ut att ha mycket grövre vägar och text än renderingen.
// Vi skalar därför ned på webben så att previewen approximerar hur PDF:en
// faktiskt kommer att se ut. Användarens reglage (labelSize/roadSize)
// multipliceras ovanpå.
const WEB_PREVIEW_TEXT_FACTOR = 0.55;
const WEB_PREVIEW_ROAD_FACTOR = 0.6;

function applyBaseTextSize(map: MLMap, labelSize: LabelSize) {
  const layers = map.getStyle().layers ?? [];
  const baseTextSizes: TextSizeMap = (map as MapWithLabelState).__kvgBaseTextSize ?? new Map();
  const factor = labelSize * WEB_PREVIEW_TEXT_FACTOR;
  for (const layer of layers) {
    if (!isBaseMapTextLayer(layer) || !layer.id) continue;
    const originalTextSize = baseTextSizes.get(layer.id);
    if (originalTextSize == null) continue;
    map.setLayoutProperty(layer.id, 'text-size', scaleTextSizeExpression(originalTextSize, factor));
  }
}

function applyBaseRoadSize(map: MLMap, roadSize: LabelSize) {
  const layers = map.getStyle().layers ?? [];
  const baseRoadSizes: RoadSizeMap = (map as MapWithLabelState).__kvgBaseRoadSize ?? new Map();
  const factor = roadSize * WEB_PREVIEW_ROAD_FACTOR;
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

/**
 * Gör atlas-sidorna dragbara: klick-och-dra på en sidpolygon flyttar sidans
 * centrum. Registreras en gång per map-instans; lager-events fungerar även
 * innan lagret existerar.
 */
function setupAtlasDrag(map: MLMap) {
  let drag: {
    pageId: string;
    startLng: number;
    startLat: number;
    origLng: number;
    origLat: number;
  } | null = null;
  const canvas = map.getCanvas();

  map.on('mouseenter', 'kvg-atlas-fill', () => {
    if (!drag) canvas.style.cursor = 'grab';
  });
  map.on('mouseleave', 'kvg-atlas-fill', () => {
    if (!drag) canvas.style.cursor = '';
  });

  map.on('mousedown', 'kvg-atlas-fill', (e) => {
    if (e.originalEvent.button !== 0) return;
    const pageId = e.features?.[0]?.properties?.pageId as string | undefined;
    if (!pageId) return;
    const page = useStore.getState().atlas.pages.find((p) => p.id === pageId);
    if (!page) return;
    e.preventDefault();
    drag = {
      pageId,
      startLng: e.lngLat.lng,
      startLat: e.lngLat.lat,
      origLng: page.center[0],
      origLat: page.center[1],
    };
    map.dragPan.disable();
    canvas.style.cursor = 'grabbing';
  });

  map.on('mousemove', (e) => {
    if (!drag) return;
    const dLng = e.lngLat.lng - drag.startLng;
    const dLat = e.lngLat.lat - drag.startLat;
    useStore.getState().updatePage(drag.pageId, {
      center: [drag.origLng + dLng, drag.origLat + dLat],
    });
  });

  const finish = () => {
    if (!drag) return;
    drag = null;
    map.dragPan.enable();
    canvas.style.cursor = '';
  };
  map.on('mouseup', finish);
  map.on('mouseout', finish);
}

function syncWatercourseLayer(map: MLMap, enabled: boolean) {
  if (!enabled) {
    removeWatercourseLayer(map);
    return;
  }
  addWatercourseLayer(map);
}

function addWatercourseLayer(map: MLMap) {
  if (map.getLayer('kvg-watercourses')) return;
  const sourceId = findWaterSourceId(map);
  if (!sourceId) return;

  const beforeId = ['kvg-grid-line', 'kvg-atlas-fill', 'kvg-tracks-line'].find((layerId) => map.getLayer(layerId));
  map.addLayer(
    {
      id: 'kvg-watercourses',
      type: 'line',
      source: sourceId,
      'source-layer': 'water',
      filter: [
        'all',
        ['==', ['geometry-type'], 'LineString'],
        ['match', ['get', 'kind'], ['river', 'stream', 'canal'], true, false],
      ],
      paint: {
        'line-color': '#2f86c6',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 10, 1.1, 13, 2, 15, 3],
        'line-opacity': 0.95,
      },
    },
    beforeId,
  );
}

function removeWatercourseLayer(map: MLMap) {
  if (map.getLayer('kvg-watercourses')) map.removeLayer('kvg-watercourses');
}

function findWaterSourceId(map: MLMap): string | null {
  const layers = map.getStyle().layers ?? [];
  for (const layer of layers) {
    const sourceLayer = (layer as { 'source-layer'?: unknown })['source-layer'];
    const source = (layer as { source?: unknown }).source;
    if (sourceLayer !== 'water' || typeof source !== 'string') continue;
    return source;
  }
  return null;
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

// LM topo10-stylen har egna höjdkurvor som inbyggda lager. Vi togglar deras
// visibility istället för att lägga till/ta bort dem (lagren är källans, inte
// vår overlay).
const LM_CONTOUR_LAYER_IDS = ['contours-minor', 'contours-major', 'contour-labels'];

function setLmContourVisibility(map: MLMap, visible: boolean) {
  const value = visible ? 'visible' : 'none';
  for (const id of LM_CONTOUR_LAYER_IDS) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', value);
    }
  }
}

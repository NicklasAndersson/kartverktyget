import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { FeatureCollection, LineString, Point } from 'geojson';
import {
  DEFAULT_LABEL_SIZE,
  normalizeStyleOverrides,
  DEFAULT_ROAD_SIZE,
  DEFAULT_TRACK_COLOR,
  DEFAULT_TRACK_WIDTH,
  normalizeLabelSize,
  normalizeRoadSize,
  normalizeTrackColor,
  normalizeTrackWidth,
} from '@kvg/shared';
import type { AtlasSpec, CustomStyle, LabelSize, StyleOverrides, MapSource, Overlays, PageSpec, StyleId } from '@kvg/shared';
import { DEFAULT_MAP_SOURCE } from '@kvg/shared';

const emptyTracks: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };
const emptyWaypoints: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
const DEFAULT_MAP_VIEW = { center: [18.0686, 59.3293] as [number, number], zoom: 11, bearing: 0, pitch: 0 };

type MapViewState = typeof DEFAULT_MAP_VIEW;

export type IconSize = 's' | 'm' | 'l';

type PersistedAppState = Pick<
  AppState,
  'atlas' | 'overlays' | 'drawMode' | 'iconName' | 'mapView' | 'customStyles' | 'activeCustomId'
>;

/** Ett träffat lager vid klick i inspektionsläget. */
export interface InspectHit {
  layerId: string;
  sourceLayer?: string;
  geometry: string;
  properties: Record<string, unknown>;
}

interface AppState {
  styleId: StyleId;
  setStyleId: (id: StyleId) => void;

  /** Användarens egna stilar (basstil + ändringar). Inbyggda stilar kan inte ändras. */
  customStyles: CustomStyle[];
  /** Vald egen stil; `styleId` är då dess basstil. null = inbyggd stil. */
  activeCustomId: string | null;
  /** Ökas när kartan måste ladda om stilen (t.ex. när en ändring tas bort). */
  styleReloadTick: number;
  selectCustomStyle: (id: string) => void;
  /** Skapar en egen stil från aktuell stil (inkl. ändringar) och väljer den. */
  createCustomStyle: (name: string) => void;
  renameCustomStyle: (id: string, name: string) => void;
  deleteCustomStyle: (id: string) => void;
  setLayerProp: (layerId: string, kind: 'paint' | 'layout', prop: string, value: unknown) => void;
  resetLayer: (layerId: string) => void;

  inspectMode: boolean;
  setInspectMode: (on: boolean) => void;
  inspectHits: InspectHit[];
  setInspectHits: (hits: InspectHit[]) => void;
  selectedLayerId: string | null;
  setSelectedLayerId: (id: string | null) => void;
  mapSource: MapSource;
  setMapSource: (source: MapSource) => void;
  labels: boolean;
  setLabels: (b: boolean) => void;
  labelSize: LabelSize;
  setLabelSize: (size: LabelSize) => void;
  roadSize: LabelSize;
  setRoadSize: (size: LabelSize) => void;
  watercourses: boolean;
  setWatercourses: (b: boolean) => void;
  contours: boolean;
  setContours: (b: boolean) => void;
  mgrsGrid: boolean;
  setMgrsGrid: (b: boolean) => void;
  mgrsMode: AtlasSpec['mgrsMode'];
  setMgrsMode: (mode: AtlasSpec['mgrsMode']) => void;
  mgrsGridSizeBias: -1 | 0 | 1;
  setMgrsGridSizeBias: (bias: AppState['mgrsGridSizeBias']) => void;
  trackColor: string;
  setTrackColor: (color: string) => void;
  trackWidth: number;
  setTrackWidth: (width: number) => void;

  overlays: Overlays;
  addTrack: (line: LineString, props?: Record<string, unknown>) => void;
  addWaypoint: (pt: Point, props?: Record<string, unknown>) => void;
  clearOverlays: () => void;
  updateTrack: (index: number, props: Record<string, unknown>) => void;
  reverseTrack: (index: number) => void;
  removeTrack: (index: number) => void;
  clearIcons: () => void;
  removeWaypoint: (index: number) => void;
  updateWaypoint: (index: number, props: Record<string, unknown>) => void;

  atlas: AtlasSpec;
  setAtlas: (a: AtlasSpec) => void;
  addPage: (p: PageSpec) => void;
  addPages: (pages: PageSpec[]) => void;
  updatePage: (id: string, p: Partial<PageSpec>) => void;
  removePage: (id: string) => void;
  clearPages: () => void;

  drawMode: 'none' | 'waypoint' | 'track' | 'icon' | 'text';
  setDrawMode: (m: AppState['drawMode']) => void;
  iconName: string | null;
  setIconName: (n: string | null) => void;
  /** Storlek för nästa ikon/textruta som placeras. */
  iconSize: IconSize;
  setIconSize: (size: IconSize) => void;
  mapView: MapViewState;
  setMapView: (view: Partial<MapViewState>) => void;
}

const initialAtlas: AtlasSpec = {
  scale: 25000,
  paper: 'A4',
  orientation: 'landscape',
  margin: 15,
  overlap: 10,
  styleId: 'friluft',
  mapSource: DEFAULT_MAP_SOURCE,
  labels: true,
  labelSize: DEFAULT_LABEL_SIZE,
  roadSize: DEFAULT_ROAD_SIZE,
  watercourses: true,
  mgrsGrid: true,
  mgrsMode: 'full',
  mgrsGridSizeBias: 0,
  contours: false,
  trackColor: DEFAULT_TRACK_COLOR,
  trackWidth: DEFAULT_TRACK_WIDTH,
  pages: [],
};

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      styleId: initialAtlas.styleId,
      setStyleId: (id) =>
        set((s) => ({
          styleId: id,
          activeCustomId: null,
          selectedLayerId: null,
          atlas: { ...s.atlas, styleId: id, styleOverrides: undefined },
        })),

      customStyles: [],
      activeCustomId: null,
      styleReloadTick: 0,
      selectCustomStyle: (id) =>
        set((s) => {
          const custom = s.customStyles.find((c) => c.id === id);
          if (!custom) return {};
          return {
            styleId: custom.baseStyleId,
            activeCustomId: id,
            selectedLayerId: null,
            atlas: { ...s.atlas, styleId: custom.baseStyleId, styleOverrides: custom.overrides },
          };
        }),
      createCustomStyle: (name) =>
        set((s) => {
          const trimmed = name.trim();
          if (!trimmed) return {};
          const overrides = s.atlas.styleOverrides ?? {};
          const custom: CustomStyle = {
            id: `custom-${crypto.randomUUID()}`,
            name: trimmed,
            baseStyleId: s.styleId,
            overrides,
          };
          return {
            customStyles: [...s.customStyles, custom],
            activeCustomId: custom.id,
            atlas: { ...s.atlas, styleOverrides: overrides },
          };
        }),
      renameCustomStyle: (id, name) =>
        set((s) => {
          const trimmed = name.trim();
          if (!trimmed) return {};
          return { customStyles: s.customStyles.map((c) => (c.id === id ? { ...c, name: trimmed } : c)) };
        }),
      deleteCustomStyle: (id) =>
        set((s) => {
          const customStyles = s.customStyles.filter((c) => c.id !== id);
          if (s.activeCustomId !== id) return { customStyles };
          return {
            customStyles,
            activeCustomId: null,
            selectedLayerId: null,
            styleReloadTick: s.styleReloadTick + 1,
            atlas: { ...s.atlas, styleOverrides: undefined },
          };
        }),
      setLayerProp: (layerId, kind, prop, value) =>
        set((s) => {
          if (!s.activeCustomId) return {}; // inbyggda stilar är skrivskyddade
          return updateActiveOverrides(s, (o) => ({
            ...o,
            [layerId]: { ...o[layerId], [kind]: { ...o[layerId]?.[kind], [prop]: value } },
          }));
        }),
      resetLayer: (layerId) =>
        set((s) => {
          if (!s.activeCustomId) return {};
          const next = updateActiveOverrides(s, (o) => {
            const { [layerId]: _removed, ...rest } = o;
            return rest;
          });
          return { ...next, styleReloadTick: s.styleReloadTick + 1 };
        }),

      inspectMode: false,
      setInspectMode: (inspectMode) => set(inspectMode ? { inspectMode, drawMode: 'none', iconName: null } : { inspectMode }),
      inspectHits: [],
      setInspectHits: (inspectHits) => set({ inspectHits }),
      selectedLayerId: null,
      setSelectedLayerId: (selectedLayerId) => set({ selectedLayerId }),
      mapSource: initialAtlas.mapSource,
      setMapSource: (mapSource) =>
        set((s) => {
          const styleId = styleForSource(mapSource, s.styleId);
          // Egen stil hör till basstilens källa; byter basstil faller vi tillbaka på inbyggd.
          const keep = styleId === s.styleId;
          return {
            mapSource,
            styleId,
            activeCustomId: keep ? s.activeCustomId : null,
            atlas: { ...s.atlas, mapSource, styleId, styleOverrides: keep ? s.atlas.styleOverrides : undefined },
          };
        }),
      labels: initialAtlas.labels,
      setLabels: (b) => set((s) => ({ labels: b, atlas: { ...s.atlas, labels: b } })),
      labelSize: initialAtlas.labelSize,
      setLabelSize: (labelSize) =>
        set((s) => {
          const next = normalizeLabelSize(labelSize);
          return { labelSize: next, atlas: { ...s.atlas, labelSize: next } };
        }),
      roadSize: initialAtlas.roadSize,
      setRoadSize: (roadSize) =>
        set((s) => {
          const next = normalizeRoadSize(roadSize);
          return { roadSize: next, atlas: { ...s.atlas, roadSize: next } };
        }),
      watercourses: initialAtlas.watercourses,
      setWatercourses: (watercourses) => set((s) => ({ watercourses, atlas: { ...s.atlas, watercourses } })),
      contours: initialAtlas.contours,
      setContours: (b) => set((s) => ({ contours: b, atlas: { ...s.atlas, contours: b } })),
      mgrsGrid: initialAtlas.mgrsGrid,
      setMgrsGrid: (b) => set((s) => ({ mgrsGrid: b, atlas: { ...s.atlas, mgrsGrid: b } })),
      mgrsMode: initialAtlas.mgrsMode,
      setMgrsMode: (mgrsMode) => set((s) => ({ mgrsMode, atlas: { ...s.atlas, mgrsMode } })),
      mgrsGridSizeBias: initialAtlas.mgrsGridSizeBias,
      setMgrsGridSizeBias: (mgrsGridSizeBias) =>
        set((s) => ({ mgrsGridSizeBias, atlas: { ...s.atlas, mgrsGridSizeBias } })),
      trackColor: initialAtlas.trackColor,
      setTrackColor: (color) =>
        set((s) => {
          const trackColor = normalizeTrackColor(color);
          return { trackColor, atlas: { ...s.atlas, trackColor } };
        }),
      trackWidth: initialAtlas.trackWidth,
      setTrackWidth: (width) =>
        set((s) => {
          const trackWidth = normalizeTrackWidth(width);
          return { trackWidth, atlas: { ...s.atlas, trackWidth } };
        }),

      overlays: { tracks: emptyTracks, waypoints: emptyWaypoints },
      addTrack: (line, props = {}) =>
        set((s) => ({
          overlays: {
            ...s.overlays,
            tracks: {
              type: 'FeatureCollection',
              features: [...s.overlays.tracks.features, { type: 'Feature', geometry: line, properties: props }],
            },
          },
        })),
      addWaypoint: (pt, props = {}) =>
        set((s) => ({
          overlays: {
            ...s.overlays,
            waypoints: {
              type: 'FeatureCollection',
              features: [...s.overlays.waypoints.features, { type: 'Feature', geometry: pt, properties: props }],
            },
          },
        })),
      updateTrack: (index, props) =>
        set((s) => ({
          overlays: {
            ...s.overlays,
            tracks: {
              type: 'FeatureCollection',
              features: s.overlays.tracks.features.map((f, i) =>
                i === index ? { ...f, properties: { ...f.properties, ...props } } : f,
              ),
            },
          },
        })),
      // Vänder koordinaterna – pilarna följer ritriktningen, så de vänds med.
      reverseTrack: (index) =>
        set((s) => ({
          overlays: {
            ...s.overlays,
            tracks: {
              type: 'FeatureCollection',
              features: s.overlays.tracks.features.map((f, i) =>
                i === index && f.geometry.type === 'LineString'
                  ? { ...f, geometry: { ...f.geometry, coordinates: [...f.geometry.coordinates].reverse() } }
                  : f,
              ),
            },
          },
        })),
      removeTrack: (index) =>
        set((s) => ({
          overlays: {
            ...s.overlays,
            tracks: { type: 'FeatureCollection', features: s.overlays.tracks.features.filter((_, i) => i !== index) },
          },
        })),
      clearOverlays: () => set({ overlays: { tracks: emptyTracks, waypoints: emptyWaypoints } }),
      clearIcons: () =>
        set((s) => ({
          overlays: {
            ...s.overlays,
            waypoints: {
              type: 'FeatureCollection',
              features: s.overlays.waypoints.features.filter((f) => !f.properties?.icon && !f.properties?.text),
            },
          },
        })),

      removeWaypoint: (index) =>
        set((s) => ({
          overlays: {
            ...s.overlays,
            waypoints: {
              type: 'FeatureCollection',
              features: s.overlays.waypoints.features.filter((_, i) => i !== index),
            },
          },
        })),
      updateWaypoint: (index, props) =>
        set((s) => ({
          overlays: {
            ...s.overlays,
            waypoints: {
              type: 'FeatureCollection',
              features: s.overlays.waypoints.features.map((f, i) =>
                i === index ? { ...f, properties: { ...f.properties, ...props } } : f,
              ),
            },
          },
        })),

      atlas: initialAtlas,
      setAtlas: (atlas) => {
        const normalized = normalizeAtlas(atlas);
        set({ atlas: normalized, ...syncAtlasState(normalized) });
      },
      addPage: (p) => set((s) => ({ atlas: { ...s.atlas, pages: [...s.atlas.pages, p] } })),
      addPages: (pages) => set((s) => ({ atlas: { ...s.atlas, pages: [...s.atlas.pages, ...pages] } })),
      updatePage: (id, p) =>
        set((s) => ({
          atlas: { ...s.atlas, pages: s.atlas.pages.map((x) => (x.id === id ? { ...x, ...p } : x)) },
        })),
      removePage: (id) => set((s) => ({ atlas: { ...s.atlas, pages: s.atlas.pages.filter((x) => x.id !== id) } })),
      clearPages: () => set((s) => ({ atlas: { ...s.atlas, pages: [] } })),

      drawMode: 'none',
      setDrawMode: (m) => set(m === 'none' ? { drawMode: m } : { drawMode: m, inspectMode: false }),
      iconName: null,
      setIconName: (n) => set({ iconName: n, drawMode: n ? 'icon' : 'none' }),
      iconSize: 'm',
      setIconSize: (iconSize) => set({ iconSize }),
      mapView: DEFAULT_MAP_VIEW,
      setMapView: (view) => set((s) => ({ mapView: { ...s.mapView, ...view } })),
    }),
    {
      name: 'kvg-web-state',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedAppState => ({
        atlas: state.atlas,
        overlays: state.overlays,
        drawMode: state.drawMode,
        iconName: state.iconName,
        mapView: state.mapView,
        customStyles: state.customStyles,
        activeCustomId: state.activeCustomId,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<PersistedAppState>;
        const customStyles = normalizeCustomStyles(persisted.customStyles);
        const active = customStyles.find((c) => c.id === persisted.activeCustomId);
        const atlas = normalizeAtlas(persisted.atlas);
        // Den aktiva egna stilen är sanningen för basstil och ändringar.
        if (active) {
          atlas.styleId = active.baseStyleId;
          atlas.styleOverrides = active.overrides;
        } else {
          atlas.styleOverrides = undefined;
        }
        return {
          ...currentState,
          ...syncAtlasState(atlas),
          customStyles,
          activeCustomId: active?.id ?? null,
          atlas,
          overlays: normalizeOverlays(persisted.overlays),
          drawMode: normalizeDrawMode(persisted.drawMode),
          iconName: typeof persisted.iconName === 'string' ? persisted.iconName : null,
          mapView: normalizeMapView(persisted.mapView),
        };
      },
    },
  ),
);

/** Skriver ändrade overrides till både den aktiva egna stilen och atlas (för PDF). */
function updateActiveOverrides(s: AppState, fn: (o: StyleOverrides) => StyleOverrides) {
  const current = s.customStyles.find((c) => c.id === s.activeCustomId);
  if (!current) return {};
  const overrides = fn(current.overrides);
  return {
    customStyles: s.customStyles.map((c) => (c.id === current.id ? { ...c, overrides } : c)),
    atlas: { ...s.atlas, styleOverrides: overrides },
  };
}

function normalizeCustomStyles(value: unknown): CustomStyle[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (c): c is CustomStyle =>
        !!c && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.baseStyleId === 'string',
    )
    .map((c) => ({ id: c.id, name: c.name, baseStyleId: c.baseStyleId, overrides: normalizeStyleOverrides(c.overrides) }));
}

function syncAtlasState(atlas: AtlasSpec) {
  return {
    styleId: atlas.styleId,
    mapSource: atlas.mapSource,
    labels: atlas.labels,
    labelSize: atlas.labelSize,
    roadSize: atlas.roadSize,
    watercourses: atlas.watercourses,
    contours: atlas.contours,
    mgrsGrid: atlas.mgrsGrid,
    mgrsMode: atlas.mgrsMode,
    mgrsGridSizeBias: atlas.mgrsGridSizeBias,
    trackColor: atlas.trackColor,
    trackWidth: atlas.trackWidth,
  };
}

function normalizeAtlas(atlas: Partial<AtlasSpec> | undefined): AtlasSpec {
  const mapSource = normalizeMapSource(atlas?.mapSource);
  return {
    ...initialAtlas,
    ...atlas,
    mapSource,
    styleId: styleForSource(mapSource, atlas?.styleId ?? initialAtlas.styleId),
    styleOverrides: atlas?.styleOverrides ? normalizeStyleOverrides(atlas.styleOverrides) : undefined,
    labelSize: normalizeLabelSize(atlas?.labelSize),
    roadSize: normalizeRoadSize(atlas?.roadSize),
    trackColor: normalizeTrackColor(atlas?.trackColor),
    trackWidth: normalizeTrackWidth(atlas?.trackWidth),
    pages: Array.isArray(atlas?.pages) ? atlas.pages : initialAtlas.pages,
  };
}

/** Behåll stilen om den hör till källan, annars källans standardstil (gamla sparade atlaser). */
function styleForSource(source: MapSource, styleId: StyleId): StyleId {
  if (styleId.startsWith('lantmateriet-') === (source === 'lm')) return styleId;
  return source === 'lm' ? 'lantmateriet-topo10' : initialAtlas.styleId;
}

function normalizeMapSource(value: unknown): MapSource {
  return value === 'lm' || value === 'osm' ? value : DEFAULT_MAP_SOURCE;
}

function normalizeOverlays(overlays: Partial<Overlays> | undefined): Overlays {
  return {
    tracks:
      overlays?.tracks?.type === 'FeatureCollection' && Array.isArray(overlays.tracks.features)
        ? overlays.tracks
        : emptyTracks,
    waypoints:
      overlays?.waypoints?.type === 'FeatureCollection' && Array.isArray(overlays.waypoints.features)
        ? overlays.waypoints
        : emptyWaypoints,
  };
}

function normalizeDrawMode(drawMode: PersistedAppState['drawMode'] | undefined): AppState['drawMode'] {
  return drawMode === 'waypoint' || drawMode === 'track' || drawMode === 'icon' || drawMode === 'text' ? drawMode : 'none';
}

function normalizeMapView(mapView: Partial<MapViewState> | undefined): MapViewState {
  const center = Array.isArray(mapView?.center) && mapView.center.length === 2 ? mapView.center : DEFAULT_MAP_VIEW.center;
  return {
    center: [Number(center[0]), Number(center[1])],
    zoom: typeof mapView?.zoom === 'number' ? mapView.zoom : DEFAULT_MAP_VIEW.zoom,
    bearing: typeof mapView?.bearing === 'number' ? mapView.bearing : DEFAULT_MAP_VIEW.bearing,
    pitch: typeof mapView?.pitch === 'number' ? mapView.pitch : DEFAULT_MAP_VIEW.pitch,
  };
}

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { FeatureCollection, LineString, Point } from 'geojson';
import { DEFAULT_LABEL_SIZE, DEFAULT_ROAD_SIZE, normalizeLabelSize, normalizeRoadSize } from '@kvg/shared';
import type { AtlasSpec, LabelSize, MapSource, Overlays, PageSpec, StyleId } from '@kvg/shared';
import { DEFAULT_MAP_SOURCE } from '@kvg/shared';

const emptyTracks: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };
const emptyWaypoints: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
const DEFAULT_MAP_VIEW = { center: [18.0686, 59.3293] as [number, number], zoom: 11, bearing: 0, pitch: 0 };

type MapViewState = typeof DEFAULT_MAP_VIEW;

type PersistedAppState = Pick<AppState, 'atlas' | 'overlays' | 'drawMode' | 'iconName' | 'mapView'>;

interface AppState {
  styleId: StyleId;
  setStyleId: (id: StyleId) => void;
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

  overlays: Overlays;
  addTrack: (line: LineString, props?: Record<string, unknown>) => void;
  addWaypoint: (pt: Point, props?: Record<string, unknown>) => void;
  clearOverlays: () => void;

  atlas: AtlasSpec;
  setAtlas: (a: AtlasSpec) => void;
  addPage: (p: PageSpec) => void;
  addPages: (pages: PageSpec[]) => void;
  updatePage: (id: string, p: Partial<PageSpec>) => void;
  removePage: (id: string) => void;
  clearPages: () => void;

  drawMode: 'none' | 'waypoint' | 'track' | 'icon';
  setDrawMode: (m: AppState['drawMode']) => void;
  iconName: string | null;
  setIconName: (n: string | null) => void;
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
  pages: [],
};

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      styleId: initialAtlas.styleId,
      setStyleId: (id) => set((s) => ({ styleId: id, atlas: { ...s.atlas, styleId: id } })),
      mapSource: initialAtlas.mapSource,
      setMapSource: (mapSource) => set((s) => ({ mapSource, atlas: { ...s.atlas, mapSource } })),
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
      clearOverlays: () => set({ overlays: { tracks: emptyTracks, waypoints: emptyWaypoints } }),

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
      setDrawMode: (m) => set({ drawMode: m }),
      iconName: null,
      setIconName: (n) => set({ iconName: n, drawMode: n ? 'icon' : 'none' }),
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
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<PersistedAppState>;
        const atlas = normalizeAtlas(persisted.atlas);
        return {
          ...currentState,
          ...syncAtlasState(atlas),
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
  };
}

function normalizeAtlas(atlas: Partial<AtlasSpec> | undefined): AtlasSpec {
  return {
    ...initialAtlas,
    ...atlas,
    mapSource: normalizeMapSource(atlas?.mapSource),
    labelSize: normalizeLabelSize(atlas?.labelSize),
    roadSize: normalizeRoadSize(atlas?.roadSize),
    pages: Array.isArray(atlas?.pages) ? atlas.pages : initialAtlas.pages,
  };
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
  return drawMode === 'waypoint' || drawMode === 'track' || drawMode === 'icon' ? drawMode : 'none';
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

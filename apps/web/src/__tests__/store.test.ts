import { beforeEach, describe, expect, it } from 'vitest';
import type { LineString, Point } from 'geojson';
import { useStore } from '../state/store';

// Snapshot of the pristine initial state, captured before any test mutates it.
const initialState = useStore.getState();

beforeEach(() => {
  // Reset zustand store between tests. `replace: true` discards mutations
  // but keeps action functions intact when we pass them back in.
  useStore.setState(initialState, true);
});

describe('store atlas/view sync', () => {
  it('setStyleId mirrors the value into atlas.styleId', () => {
    useStore.getState().setStyleId('protomaps-dark');
    const s = useStore.getState();
    expect(s.styleId).toBe('protomaps-dark');
    expect(s.atlas.styleId).toBe('protomaps-dark');
  });

  it('setLabels mirrors into atlas.labels', () => {
    useStore.getState().setLabels(false);
    const s = useStore.getState();
    expect(s.labels).toBe(false);
    expect(s.atlas.labels).toBe(false);
  });

  it('setLabelSize and setRoadSize mirror into atlas', () => {
    useStore.getState().setLabelSize(1.95);
    useStore.getState().setRoadSize(0.8);
    const s = useStore.getState();
    expect(s.atlas.labelSize).toBe(1.95);
    expect(s.atlas.roadSize).toBe(0.8);
  });

  it('setMgrsGrid / setMgrsMode / setMgrsGridSizeBias mirror into atlas', () => {
    const api = useStore.getState();
    api.setMgrsGrid(false);
    api.setMgrsMode('frame');
    api.setMgrsGridSizeBias(1);
    const s = useStore.getState();
    expect(s.atlas.mgrsGrid).toBe(false);
    expect(s.atlas.mgrsMode).toBe('frame');
    expect(s.atlas.mgrsGridSizeBias).toBe(1);
  });

  it('setWatercourses and setContours mirror into atlas', () => {
    useStore.getState().setWatercourses(false);
    useStore.getState().setContours(true);
    const s = useStore.getState();
    expect(s.atlas.watercourses).toBe(false);
    expect(s.atlas.contours).toBe(true);
  });
});

describe('store overlays', () => {
  const line: LineString = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
  const point: Point = { type: 'Point', coordinates: [2, 3] };

  it('addTrack appends a feature without dropping existing ones', () => {
    useStore.getState().addTrack(line, { name: 'a' });
    useStore.getState().addTrack(line, { name: 'b' });
    const tracks = useStore.getState().overlays.tracks.features;
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.properties).toEqual({ name: 'a' });
    expect(tracks[1]!.properties).toEqual({ name: 'b' });
  });

  it('addWaypoint appends a feature', () => {
    useStore.getState().addWaypoint(point, { icon: 'flag' });
    const wps = useStore.getState().overlays.waypoints.features;
    expect(wps).toHaveLength(1);
    expect(wps[0]!.geometry).toEqual(point);
  });

  it('clearOverlays resets both tracks and waypoints', () => {
    const api = useStore.getState();
    api.addTrack(line);
    api.addWaypoint(point);
    api.clearOverlays();
    const { tracks, waypoints } = useStore.getState().overlays;
    expect(tracks.features).toHaveLength(0);
    expect(waypoints.features).toHaveLength(0);
  });

  it('clearIcons removes only waypoints with an icon property', () => {
    const api = useStore.getState();
    api.addWaypoint(point, { icon: 'tent' });
    api.addWaypoint(point, { name: 'plain wp' });
    api.addTrack(line);
    api.clearIcons();
    const { tracks, waypoints } = useStore.getState().overlays;
    expect(waypoints.features).toHaveLength(1);
    expect(waypoints.features[0]!.properties).toEqual({ name: 'plain wp' });
    expect(tracks.features).toHaveLength(1);
  });
});

describe('store pages', () => {
  it('addPage appends to atlas.pages', () => {
    useStore.getState().addPage({ id: 'p1', center: [18, 59] });
    useStore.getState().addPage({ id: 'p2', center: [19, 60] });
    expect(useStore.getState().atlas.pages.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('updatePage patches a page by id and leaves others untouched', () => {
    const api = useStore.getState();
    api.addPage({ id: 'p1', center: [18, 59] });
    api.addPage({ id: 'p2', center: [19, 60] });
    api.updatePage('p2', { rotation: 45 });
    const pages = useStore.getState().atlas.pages;
    expect(pages.find((p) => p.id === 'p1')?.rotation).toBeUndefined();
    expect(pages.find((p) => p.id === 'p2')?.rotation).toBe(45);
  });

  it('removePage removes only the matching id', () => {
    const api = useStore.getState();
    api.addPage({ id: 'p1', center: [18, 59] });
    api.addPage({ id: 'p2', center: [19, 60] });
    api.removePage('p1');
    expect(useStore.getState().atlas.pages.map((p) => p.id)).toEqual(['p2']);
  });
});

describe('store draw mode and map view', () => {
  it('setIconName sets drawMode to "icon" when an icon is chosen, "none" when cleared', () => {
    useStore.getState().setIconName('flag');
    expect(useStore.getState().drawMode).toBe('icon');
    expect(useStore.getState().iconName).toBe('flag');
    useStore.getState().setIconName(null);
    expect(useStore.getState().drawMode).toBe('none');
    expect(useStore.getState().iconName).toBeNull();
  });

  it('setDrawMode updates mode independently', () => {
    useStore.getState().setDrawMode('track');
    expect(useStore.getState().drawMode).toBe('track');
  });

  it('setMapView merges partials into existing view', () => {
    useStore.getState().setMapView({ zoom: 15 });
    const view = useStore.getState().mapView;
    expect(view.zoom).toBe(15);
    // Other fields preserved.
    expect(view.center).toEqual(initialState.mapView.center);
    expect(view.bearing).toBe(initialState.mapView.bearing);
  });
});

describe('store setAtlas', () => {
  it('replaces atlas and syncs derived top-level fields', () => {
    const next = {
      ...initialState.atlas,
      styleId: 'protomaps-dark' as const,
      labels: false,
      labelSize: 1.95,
      roadSize: 0.8,
      watercourses: false,
      contours: true,
      mgrsGrid: false,
      mgrsMode: 'frame' as const,
      mgrsGridSizeBias: -1 as const,
    };
    useStore.getState().setAtlas(next);
    const s = useStore.getState();
    expect(s.styleId).toBe('protomaps-dark');
    expect(s.labels).toBe(false);
    expect(s.labelSize).toBe(1.95);
    expect(s.roadSize).toBe(0.8);
    expect(s.watercourses).toBe(false);
    expect(s.contours).toBe(true);
    expect(s.mgrsGrid).toBe(false);
    expect(s.mgrsMode).toBe('frame');
    expect(s.mgrsGridSizeBias).toBe(-1);
  });
});

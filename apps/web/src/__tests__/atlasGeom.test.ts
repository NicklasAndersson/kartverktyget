import { describe, expect, it } from 'vitest';
import type { AtlasSpec } from '@kvg/shared';
import { computeAtlasPageRects } from '../map/atlasGeom';

function makeAtlas(pages: AtlasSpec['pages']): AtlasSpec {
  return {
    scale: 25000,
    paper: 'A4',
    orientation: 'landscape',
    margin: 15,
    overlap: 10,
    styleId: 'friluft',
    mapSource: 'osm',
    labels: true,
    labelSize: 1.3,
    roadSize: 1,
    watercourses: true,
    mgrsGrid: true,
    mgrsMode: 'full',
    mgrsGridSizeBias: 0,
    contours: false,
    pages,
  };
}

describe('computeAtlasPageRects', () => {
  it('returns empty collection for no pages', () => {
    const out = computeAtlasPageRects(makeAtlas([]));
    expect(out.type).toBe('FeatureCollection');
    expect(out.features).toHaveLength(0);
  });

  it('emits one polygon + one label point per page', () => {
    const pages = [
      { id: 'a', center: [18.0, 59.3] as [number, number] },
      { id: 'b', center: [18.1, 59.31] as [number, number] },
      { id: 'c', center: [18.2, 59.32] as [number, number] },
    ];
    const out = computeAtlasPageRects(makeAtlas(pages));
    expect(out.features).toHaveLength(pages.length * 2);
    const polygons = out.features.filter((f) => f.geometry.type === 'Polygon');
    const points = out.features.filter((f) => f.geometry.type === 'Point');
    expect(polygons).toHaveLength(pages.length);
    expect(points).toHaveLength(pages.length);
  });

  it('produces a closed polygon ring (first point == last point) of 5 vertices', () => {
    const out = computeAtlasPageRects(makeAtlas([{ id: 'a', center: [18.0, 59.3] }]));
    const poly = out.features.find((f) => f.geometry.type === 'Polygon');
    expect(poly).toBeDefined();
    const ring = (poly!.geometry as unknown as { coordinates: [number, number][][] }).coordinates[0]!;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });

  it('numbers label points 1..N in page order', () => {
    const pages = [
      { id: 'a', center: [18.0, 59.3] as [number, number] },
      { id: 'b', center: [18.1, 59.31] as [number, number] },
    ];
    const out = computeAtlasPageRects(makeAtlas(pages));
    const labels = out.features
      .filter((f) => f.geometry.type === 'Point')
      .map((f) => f.properties?.label);
    expect(labels).toEqual(['1', '2']);
  });

  it('polygon rectangle is centred on the page center', () => {
    const center: [number, number] = [18.0, 59.3];
    const out = computeAtlasPageRects(makeAtlas([{ id: 'a', center }]));
    const poly = out.features.find((f) => f.geometry.type === 'Polygon')!;
    const ring = (poly.geometry as unknown as { coordinates: [number, number][][] }).coordinates[0]!;
    const lons = ring.slice(0, 4).map((p) => p[0]);
    const lats = ring.slice(0, 4).map((p) => p[1]);
    const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    expect(midLon).toBeCloseTo(center[0], 6);
    expect(midLat).toBeCloseTo(center[1], 6);
  });
});

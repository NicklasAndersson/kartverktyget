import { describe, expect, it } from 'vitest';
import { computeMgrsGrid } from '../index.js';

const STOCKHOLM_BBOX = { west: 18.0, south: 59.3, east: 18.15, north: 59.4 };

describe('computeMgrsGrid', () => {
  it('returns empty collection for too-low zoom', () => {
    const out = computeMgrsGrid({ ...STOCKHOLM_BBOX, zoom: 4, sizeBias: 0 });
    expect(out.type).toBe('FeatureCollection');
    expect(out.features).toHaveLength(0);
  });

  it('produces both easting and northing line features for a city-level zoom', () => {
    const out = computeMgrsGrid({ ...STOCKHOLM_BBOX, zoom: 12, sizeBias: 0 });
    const lines = out.features.filter((f) => f.geometry.type === 'LineString');
    const kinds = new Set(lines.map((f) => f.properties?.kind));
    expect(lines.length).toBeGreaterThan(0);
    expect(kinds.has('easting')).toBe(true);
    expect(kinds.has('northing')).toBe(true);
  });

  it('produces point features with formatted MGRS labels', () => {
    const out = computeMgrsGrid({ ...STOCKHOLM_BBOX, zoom: 12, sizeBias: 0 });
    const points = out.features.filter((f) => f.geometry.type === 'Point');
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      const label = p.properties?.label;
      expect(typeof label).toBe('string');
      // formatMgrs result starts with 1–2 zone digits + band letter, e.g. "33V WC ..."
      expect(label as string).toMatch(/^\d{1,2}[C-X] [A-Z]{2}/i);
    }
  });

  it('keeps label points apart so none is drawn on top of another', () => {
    // A4-liggande vid 1:25 000 (samma bounds som utskriften) – där är rutnätet
    // 100 m och etiketterna ~350 m breda / ~50 m höga på papperet. Centrum
    // svepts så att etikettraden hamnar på olika avstånd från rutnätslinjerna.
    for (let offset = 0; offset < 20; offset++) {
      const south = 59.3091 + offset * 0.0005;
      const out = computeMgrsGrid({ west: 18.0099, south, east: 18.1273, north: south + 0.0404, zoom: 13, sizeBias: 0 });
      const points = out.features
        .filter((f) => f.geometry.type === 'Point')
        .map((f) => (f.geometry as { coordinates: [number, number] }).coordinates);
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          const dLonM = Math.abs(points[i]![0] - points[j]![0]) * 111320 * Math.cos((south * Math.PI) / 180);
          const dLatM = Math.abs(points[i]![1] - points[j]![1]) * 111320;
          expect(dLonM > 350 || dLatM > 50).toBe(true);
        }
      }
    }
  });

  it('caps feature count to a reasonable upper bound', () => {
    const out = computeMgrsGrid({ ...STOCKHOLM_BBOX, zoom: 18, sizeBias: 0 });
    // Implementation hard-caps lines to 250 per axis + labels; we just assert no runaway.
    expect(out.features.length).toBeLessThan(2000);
  });

  it('sizeBias changes grid density at the same zoom', () => {
    // Zoom 11 sits in the middle of the tier table so bias -1 and +1 each
    // cross a tier boundary, guaranteeing observable density changes.
    const base = computeMgrsGrid({ ...STOCKHOLM_BBOX, zoom: 11, sizeBias: 0 });
    const biasedDown = computeMgrsGrid({ ...STOCKHOLM_BBOX, zoom: 11, sizeBias: -1 });
    const biasedUp = computeMgrsGrid({ ...STOCKHOLM_BBOX, zoom: 11, sizeBias: 1 });
    // Different bias values must yield different grid densities; the exact direction
    // is an implementation detail we don't assert on.
    expect(biasedDown.features.length).not.toBe(base.features.length);
    expect(biasedUp.features.length).not.toBe(base.features.length);
  });
});

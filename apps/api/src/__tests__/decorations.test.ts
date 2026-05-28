import { describe, expect, it } from 'vitest';
import { estimateMapZoom, utmLatBand, formatEdgeMgrsLabel } from '../render/decorations.js';

describe('estimateMapZoom', () => {
  it('returns a finite zoom in [0,22] for a small city bbox', () => {
    const z = estimateMapZoom({ west: 18.0, south: 59.3, east: 18.15, north: 59.4 }, 1024, 1024);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThanOrEqual(22);
  });

  it('clamps to 0..22 for a degenerate (full world) bbox', () => {
    const z = estimateMapZoom({ west: -180, south: -85, east: 180, north: 85 }, 256, 256);
    expect(z).toBeGreaterThanOrEqual(0);
    expect(z).toBeLessThanOrEqual(22);
  });

  it('returns higher zoom for tighter bbox at same pixel size', () => {
    const zoomWide = estimateMapZoom({ west: 10, south: 55, east: 20, north: 60 }, 1024, 1024);
    const zoomTight = estimateMapZoom({ west: 18.0, south: 59.3, east: 18.1, north: 59.35 }, 1024, 1024);
    expect(zoomTight).toBeGreaterThan(zoomWide);
  });
});

describe('utmLatBand', () => {
  it('returns Z below -80 and at/above 84', () => {
    expect(utmLatBand(-81)).toBe('Z');
    expect(utmLatBand(-90)).toBe('Z');
    expect(utmLatBand(84)).toBe('Z');
    expect(utmLatBand(90)).toBe('Z');
  });

  it('returns C at the southern edge (-80)', () => {
    expect(utmLatBand(-80)).toBe('C');
  });

  it('returns X for high northern latitudes inside the valid range', () => {
    // The X-band is 72° to 84° (12° wide, special case in MGRS).
    expect(utmLatBand(72)).toBe('X');
    expect(utmLatBand(83.999)).toBe('X');
  });

  it('skips I and O (uses J after H, P after N)', () => {
    // Bands are C D E F G H J K L M N P Q R S T U V W X
    // idx 0 (lat -80..-72) = C, idx 6 (lat -32..-24) = J (no I)
    expect(utmLatBand(-32)).toBe('J');
    expect(utmLatBand(-24.0001)).toBe('J');
    // idx 11 (lat 8..16) = P (no O between N and P)
    expect(utmLatBand(8)).toBe('P');
    expect(utmLatBand(15.999)).toBe('P');
  });

  it('maps Stockholm (~59.3°N) into the V band', () => {
    expect(utmLatBand(59.3)).toBe('V');
  });
});

describe('formatEdgeMgrsLabel', () => {
  it('returns "MGRS" fallback when projection definition is invalid', () => {
    expect(formatEdgeMgrsLabel('+invalid-proj-string', 500000, 6500000)).toBe('MGRS');
  });

  it('returns an MGRS-formatted string for a valid UTM 33N point', () => {
    const utm33N = '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs';
    const label = formatEdgeMgrsLabel(utm33N, 674032, 6580000);
    expect(label).toMatch(/^\d{1,2}[C-X] [A-Z]{2}/i);
  });
});

import { describe, expect, it } from 'vitest';
import { PAPER_SIZES, pageMetersOnGround, type AtlasSpec } from '../index.js';

function makeAtlas(overrides: Partial<Pick<AtlasSpec, 'scale' | 'paper' | 'orientation' | 'margin'>> = {}) {
  return {
    scale: 25000 as AtlasSpec['scale'],
    paper: 'A4' as AtlasSpec['paper'],
    orientation: 'landscape' as AtlasSpec['orientation'],
    margin: 15,
    ...overrides,
  };
}

describe('pageMetersOnGround', () => {
  it('subtracts margin from paper on both sides', () => {
    const a4 = PAPER_SIZES.A4;
    const result = pageMetersOnGround(makeAtlas({ orientation: 'portrait', margin: 10 }));
    expect(result.mapWidthMm).toBe(a4.width - 20);
    expect(result.mapHeightMm).toBe(a4.height - 20);
  });

  it('swaps width/height for landscape orientation', () => {
    const portrait = pageMetersOnGround(makeAtlas({ orientation: 'portrait' }));
    const landscape = pageMetersOnGround(makeAtlas({ orientation: 'landscape' }));
    expect(landscape.mapWidthMm).toBe(portrait.mapHeightMm);
    expect(landscape.mapHeightMm).toBe(portrait.mapWidthMm);
  });

  it('landscape A4 produces wider-than-tall ground footprint', () => {
    const result = pageMetersOnGround(makeAtlas({ orientation: 'landscape' }));
    expect(result.widthM).toBeGreaterThan(result.heightM);
  });

  it('relates ground meters to mm via scale denominator', () => {
    const result = pageMetersOnGround(makeAtlas({ scale: 25000 }));
    expect(result.widthM).toBeCloseTo((result.mapWidthMm * 25000) / 1000, 6);
    expect(result.heightM).toBeCloseTo((result.mapHeightMm * 25000) / 1000, 6);
  });

  it('scales linearly with the scale denominator', () => {
    const a = pageMetersOnGround(makeAtlas({ scale: 10000 }));
    const b = pageMetersOnGround(makeAtlas({ scale: 50000 }));
    expect(b.widthM / a.widthM).toBeCloseTo(5, 6);
  });
});

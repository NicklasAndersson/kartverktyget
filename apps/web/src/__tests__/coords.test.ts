import { describe, expect, it } from 'vitest';
import { latlonToMgrs } from '../utils/coords';

describe('latlonToMgrs', () => {
  it('returns a formatted MGRS string for valid Swedish coordinates', () => {
    const result = latlonToMgrs(18.0686, 59.3293);
    // formatMgrs format: "<zone><band> <square> <easting> <northing>"
    expect(result).toMatch(/^\d{1,2}[C-X] [A-Z]{2} \d+ \d+$/);
  });

  it('returns em-dash fallback when the MGRS library throws', () => {
    // Latitudes outside MGRS' valid range cause mgrs.forward to throw.
    expect(latlonToMgrs(0, 100)).toBe('—');
  });

  it('respects the precision argument by producing more digits', () => {
    const low = latlonToMgrs(18.0686, 59.3293, 1);
    const high = latlonToMgrs(18.0686, 59.3293, 5);
    const lowDigits = (low.match(/\d/g) ?? []).length;
    const highDigits = (high.match(/\d/g) ?? []).length;
    expect(highDigits).toBeGreaterThan(lowDigits);
  });
});

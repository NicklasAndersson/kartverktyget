import { describe, expect, it } from 'vitest';
import { formatMgrs } from '../index.js';

describe('formatMgrs', () => {
  it('returns input unchanged when format does not match MGRS pattern', () => {
    expect(formatMgrs('not-an-mgrs')).toBe('not-an-mgrs');
    expect(formatMgrs('')).toBe('');
  });

  it('formats with only zone, band and square when digits are absent', () => {
    expect(formatMgrs('33VWC')).toBe('33V WC');
  });

  it('splits digits into equal easting/northing halves', () => {
    expect(formatMgrs('33VWC1234567890')).toBe('33V WC 12345 67890');
    expect(formatMgrs('33VWC1234')).toBe('33V WC 12 34');
  });

  it('uppercases the band and square letters', () => {
    expect(formatMgrs('33vwc12')).toBe('33V WC 1 2');
  });
});

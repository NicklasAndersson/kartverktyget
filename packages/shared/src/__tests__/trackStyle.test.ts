import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACK_COLOR, DEFAULT_TRACK_WIDTH, TRACK_WIDTH_RANGE, normalizeTrackColor, normalizeTrackWidth } from '../index.js';

describe('normalizeTrackColor', () => {
  it('accepterar #rrggbb', () => {
    expect(normalizeTrackColor('#00ff88')).toBe('#00ff88');
    expect(normalizeTrackColor('#ABCDEF')).toBe('#ABCDEF');
  });

  it('faller tillbaka på default för allt annat', () => {
    for (const bad of ['red', '#fff', 'javascript:x', '', null, 42]) {
      expect(normalizeTrackColor(bad)).toBe(DEFAULT_TRACK_COLOR);
    }
  });
});

describe('normalizeTrackWidth', () => {
  it('klampar till tillåtet intervall', () => {
    expect(normalizeTrackWidth(0)).toBe(TRACK_WIDTH_RANGE.min);
    expect(normalizeTrackWidth(999)).toBe(TRACK_WIDTH_RANGE.max);
    expect(normalizeTrackWidth(3)).toBe(3);
  });

  it('faller tillbaka på default för icke-tal', () => {
    expect(normalizeTrackWidth('bred')).toBe(DEFAULT_TRACK_WIDTH);
    expect(normalizeTrackWidth(undefined)).toBe(DEFAULT_TRACK_WIDTH);
  });
});

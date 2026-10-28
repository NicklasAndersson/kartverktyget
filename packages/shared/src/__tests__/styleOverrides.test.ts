import { describe, expect, it } from 'vitest';
import { applyStyleOverrides, normalizeStyleOverrides, type StyleLayerLike } from '../index.js';

const layers: StyleLayerLike[] = [
  { id: 'roads', type: 'line', paint: { 'line-color': '#000', 'line-width': 2 } },
  { id: 'water', type: 'fill', paint: { 'fill-color': '#00f' } },
];

describe('applyStyleOverrides', () => {
  it('replaces and adds paint/layout props, leaves other layers alone', () => {
    const out = applyStyleOverrides(layers, {
      roads: { paint: { 'line-color': '#f00' }, layout: { visibility: 'none' } },
      missing: { paint: { 'fill-color': '#fff' } },
    });
    expect(out[0]).toEqual({
      id: 'roads',
      type: 'line',
      paint: { 'line-color': '#f00', 'line-width': 2 },
      layout: { visibility: 'none' },
    });
    expect(out[1]).toBe(layers[1]);
  });

  it('does not mutate the input and returns it untouched without overrides', () => {
    applyStyleOverrides(layers, { roads: { paint: { 'line-width': 9 } } });
    expect(layers[0]!.paint!['line-width']).toBe(2);
    expect(applyStyleOverrides(layers, undefined)).toBe(layers);
  });

  it('never touches kvg- helper layers', () => {
    const helper = [{ id: 'kvg-tracks-line', paint: { 'line-width': 2 } }];
    expect(applyStyleOverrides(helper, { 'kvg-tracks-line': { paint: { 'line-width': 9 } } })[0]).toBe(helper[0]);
  });
});

describe('normalizeStyleOverrides', () => {
  it('drops malformed entries', () => {
    expect(normalizeStyleOverrides(null)).toEqual({});
    expect(normalizeStyleOverrides({ a: 'x', b: {}, c: { paint: { p: 1 }, junk: 1 }, d: { layout: [] } })).toEqual({
      c: { paint: { p: 1 } },
    });
  });
});

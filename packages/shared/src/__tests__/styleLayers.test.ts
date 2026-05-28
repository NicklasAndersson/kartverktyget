import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LABEL_SIZE,
  DEFAULT_ROAD_SIZE,
  LABEL_SIZE_FACTORS,
  ROAD_SIZE_FACTORS,
  applyLabelSizeToStyleLayers,
  applyRoadSizeToStyleLayers,
  isBaseMapTextLayer,
  isBaseRoadLayer,
  type StyleLayerLike,
} from '../index.js';

describe('isBaseMapTextLayer', () => {
  it('returns true for non-kvg symbol layer with text-field', () => {
    const layer: StyleLayerLike = { id: 'place_label', type: 'symbol', layout: { 'text-field': '{name}' } };
    expect(isBaseMapTextLayer(layer)).toBe(true);
  });

  it('returns false for kvg-prefixed layers', () => {
    const layer: StyleLayerLike = { id: 'kvg-mgrs-labels', type: 'symbol', layout: { 'text-field': 'x' } };
    expect(isBaseMapTextLayer(layer)).toBe(false);
  });

  it('returns false for non-symbol layers', () => {
    expect(isBaseMapTextLayer({ id: 'water', type: 'fill', layout: { 'text-field': 'x' } })).toBe(false);
  });

  it('returns false when text-field is absent', () => {
    expect(isBaseMapTextLayer({ id: 'icons', type: 'symbol', layout: { 'icon-image': 'x' } })).toBe(false);
  });
});

describe('isBaseRoadLayer', () => {
  it('matches osm/roads line layers', () => {
    expect(isBaseRoadLayer({ id: 'roads', type: 'line', source: 'osm', 'source-layer': 'roads' })).toBe(true);
  });

  it('ignores kvg-prefixed layers', () => {
    expect(isBaseRoadLayer({ id: 'kvg-track', type: 'line', source: 'osm', 'source-layer': 'roads' })).toBe(false);
  });

  it('ignores layers from other sources or source-layers', () => {
    expect(isBaseRoadLayer({ id: 'x', type: 'line', source: 'osm', 'source-layer': 'water' })).toBe(false);
    expect(isBaseRoadLayer({ id: 'x', type: 'line', source: 'other', 'source-layer': 'roads' })).toBe(false);
    expect(isBaseRoadLayer({ id: 'x', type: 'fill', source: 'osm', 'source-layer': 'roads' })).toBe(false);
  });
});

describe('applyLabelSizeToStyleLayers', () => {
  it('returns layers untouched when not a base-map text layer (referential equality)', () => {
    const layers: StyleLayerLike[] = [
      { id: 'kvg-x', type: 'symbol', layout: { 'text-field': 'a', 'text-size': 10 } },
      { id: 'roads', type: 'line', source: 'osm', 'source-layer': 'roads', paint: { 'line-width': 2 } },
    ];
    const out = applyLabelSizeToStyleLayers(layers, LABEL_SIZE_FACTORS.large);
    expect(out[0]).toBe(layers[0]);
    expect(out[1]).toBe(layers[1]);
  });

  it('scales numeric text-size by the label-size factor', () => {
    const layers: StyleLayerLike[] = [
      { id: 'places', type: 'symbol', layout: { 'text-field': '{name}', 'text-size': 10 } },
    ];
    const out = applyLabelSizeToStyleLayers(layers, LABEL_SIZE_FACTORS.large);
    expect(out[0]!.layout!['text-size']).toBe(10 * LABEL_SIZE_FACTORS.large);
  });

  it('medium is the identity factor', () => {
    expect(DEFAULT_LABEL_SIZE).toBeGreaterThan(0);
    const layers: StyleLayerLike[] = [
      { id: 'places', type: 'symbol', layout: { 'text-field': '{name}', 'text-size': 12 } },
    ];
    const out = applyLabelSizeToStyleLayers(layers, DEFAULT_LABEL_SIZE);
    expect(out[0]!.layout!['text-size']).toBeCloseTo(12 * DEFAULT_LABEL_SIZE, 6);
  });

  it('preserves interpolate expression structure and only scales stop outputs', () => {
    const layers: StyleLayerLike[] = [
      {
        id: 'places',
        type: 'symbol',
        layout: {
          'text-field': '{name}',
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 8, 14, 16],
        },
      },
    ];
    const out = applyLabelSizeToStyleLayers(layers, LABEL_SIZE_FACTORS.large);
    const expr = out[0]!.layout!['text-size'] as unknown[];
    expect(expr[0]).toBe('interpolate');
    expect(expr[1]).toEqual(['linear']);
    expect(expr[2]).toEqual(['zoom']);
    // Stop inputs (10, 14) preserved, stop outputs (8, 16) scaled.
    expect(expr[3]).toBe(10);
    expect(expr[5]).toBe(14);
    expect(expr[4]).toBeCloseTo(8 * LABEL_SIZE_FACTORS.large, 6);
    expect(expr[6]).toBeCloseTo(16 * LABEL_SIZE_FACTORS.large, 6);
  });

  it('preserves step expression structure', () => {
    const layers: StyleLayerLike[] = [
      {
        id: 'p',
        type: 'symbol',
        layout: { 'text-field': '{name}', 'text-size': ['step', ['zoom'], 10, 12, 14] },
      },
    ];
    const out = applyLabelSizeToStyleLayers(layers, LABEL_SIZE_FACTORS.large);
    const expr = out[0]!.layout!['text-size'] as unknown[];
    expect(expr[0]).toBe('step');
    expect(expr[1]).toEqual(['zoom']);
    expect(expr[3]).toBe(12); // stop input preserved
    expect(expr[2]).toBeCloseTo(10 * LABEL_SIZE_FACTORS.large, 6);
    expect(expr[4]).toBeCloseTo(14 * LABEL_SIZE_FACTORS.large, 6);
  });

  it('leaves layer without text-size unchanged', () => {
    const layers: StyleLayerLike[] = [
      { id: 'p', type: 'symbol', layout: { 'text-field': '{name}' } },
    ];
    const out = applyLabelSizeToStyleLayers(layers, LABEL_SIZE_FACTORS.xl);
    expect(out[0]).toBe(layers[0]);
  });
});

describe('applyRoadSizeToStyleLayers', () => {
  it('scales numeric line-width by the road-size factor', () => {
    const layers: StyleLayerLike[] = [
      { id: 'roads', type: 'line', source: 'osm', 'source-layer': 'roads', paint: { 'line-width': 2 } },
    ];
    const out = applyRoadSizeToStyleLayers(layers, ROAD_SIZE_FACTORS.large);
    expect(out[0]!.paint!['line-width']).toBeCloseTo(2 * ROAD_SIZE_FACTORS.large, 6);
  });

  it('leaves non-road layers untouched (referential equality)', () => {
    const layers: StyleLayerLike[] = [
      { id: 'places', type: 'symbol', layout: { 'text-field': 'x', 'text-size': 10 } },
    ];
    const out = applyRoadSizeToStyleLayers(layers, ROAD_SIZE_FACTORS.large);
    expect(out[0]).toBe(layers[0]);
  });

  it('preserves interpolate expression structure for line-width', () => {
    const layers: StyleLayerLike[] = [
      {
        id: 'roads',
        type: 'line',
        source: 'osm',
        'source-layer': 'roads',
        paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 4] },
      },
    ];
    const out = applyRoadSizeToStyleLayers(layers, ROAD_SIZE_FACTORS.large);
    const expr = out[0]!.paint!['line-width'] as unknown[];
    expect(expr[0]).toBe('interpolate');
    expect(expr[3]).toBe(8); // stop input
    expect(expr[5]).toBe(14); // stop input
    expect(expr[4]).toBeCloseTo(0.5 * ROAD_SIZE_FACTORS.large, 6);
    expect(expr[6]).toBeCloseTo(4 * ROAD_SIZE_FACTORS.large, 6);
  });

  it('medium road factor is exactly 1 (identity)', () => {
    expect(DEFAULT_ROAD_SIZE).toBe(1);
  });
});

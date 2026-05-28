import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AtlasSpec, RenderRequest } from '@kvg/shared';

// Mock the heavy render engine so tests stay fast and headless-browser-free.
// The mock factory must not reference outer variables (vi.mock is hoisted).
vi.mock('../render/engine.js', () => ({
  renderAtlas: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])), // "%PDF"
}));

import { registerRenderRoute } from '../render/route.js';
import { renderAtlas } from '../render/engine.js';

const renderAtlasMock = renderAtlas as unknown as ReturnType<typeof vi.fn>;

const minimalAtlas: AtlasSpec = {
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
  pages: [{ id: 'p1', center: [18.0, 59.3] }],
};

const validBody: RenderRequest = {
  atlas: minimalAtlas,
  overlays: {
    tracks: { type: 'FeatureCollection', features: [] },
    waypoints: { type: 'FeatureCollection', features: [] },
  },
};

let app: FastifyInstance;

beforeEach(async () => {
  renderAtlasMock.mockClear();
  app = Fastify();
  await registerRenderRoute(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /render validation', () => {
  it('returns 400 when body is empty', async () => {
    const res = await app.inject({ method: 'POST', url: '/render', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'atlas required' });
    expect(renderAtlasMock).not.toHaveBeenCalled();
  });

  it('returns 400 when atlas has no pages', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render',
      payload: { atlas: { ...minimalAtlas, pages: [] }, overlays: validBody.overlays },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'atlas.pages must be a non-empty array' });
    expect(renderAtlasMock).not.toHaveBeenCalled();
  });

  it('returns 400 when pages is missing entirely', async () => {
    const { pages: _drop, ...atlasWithoutPages } = minimalAtlas;
    const res = await app.inject({
      method: 'POST',
      url: '/render',
      payload: { atlas: atlasWithoutPages, overlays: validBody.overlays },
    });
    expect(res.statusCode).toBe(400);
    expect(renderAtlasMock).not.toHaveBeenCalled();
  });

  it('returns 400 when paper is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render',
      payload: { atlas: { ...minimalAtlas, paper: 'B7' }, overlays: validBody.overlays },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toMatch(/atlas\.paper/);
    expect(renderAtlasMock).not.toHaveBeenCalled();
  });

  it('returns 400 when scale is zero or negative', async () => {
    for (const scale of [0, -1, Number.NaN]) {
      const res = await app.inject({
        method: 'POST',
        url: '/render',
        payload: { atlas: { ...minimalAtlas, scale }, overlays: validBody.overlays },
      });
      expect(res.statusCode).toBe(400);
      expect(String(res.json().error)).toMatch(/scale/);
    }
    expect(renderAtlasMock).not.toHaveBeenCalled();
  });

  it('returns 400 when margin is negative', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render',
      payload: { atlas: { ...minimalAtlas, margin: -5 }, overlays: validBody.overlays },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toMatch(/margin/);
    expect(renderAtlasMock).not.toHaveBeenCalled();
  });

  it('returns 400 when orientation is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render',
      payload: { atlas: { ...minimalAtlas, orientation: 'diagonal' }, overlays: validBody.overlays },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toMatch(/orientation/);
    expect(renderAtlasMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a page has non-finite coordinates', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render',
      payload: {
        atlas: { ...minimalAtlas, pages: [{ id: 'p1', center: [Number.NaN, 59.3] }] },
        overlays: validBody.overlays,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toMatch(/center/);
    expect(renderAtlasMock).not.toHaveBeenCalled();
  });
});

describe('POST /render success', () => {
  it('responds 200 with PDF content-type and attachment disposition', async () => {
    const res = await app.inject({ method: 'POST', url: '/render', payload: validBody });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="atlas-\d+\.pdf"$/);
    expect(renderAtlasMock).toHaveBeenCalledTimes(1);
  });

  it('forwards the request body to renderAtlas', async () => {
    await app.inject({ method: 'POST', url: '/render', payload: validBody });
    const firstCall = renderAtlasMock.mock.calls[0]!;
    expect(firstCall[0]).toMatchObject({ atlas: { pages: [{ id: 'p1' }] } });
  });

  it('returns the bytes produced by renderAtlas', async () => {
    const res = await app.inject({ method: 'POST', url: '/render', payload: validBody });
    // "%PDF" header bytes from the mock.
    expect(res.rawPayload.slice(0, 4).toString('ascii')).toBe('%PDF');
  });
});

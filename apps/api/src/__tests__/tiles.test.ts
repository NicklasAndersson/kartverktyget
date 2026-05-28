import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerTilesRoutes } from '../tiles.js';

let app: FastifyInstance;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvg-tiles-'));
  app = Fastify();
  await registerTilesRoutes(app, tmpDir);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tiles routes', () => {
  it('returns 404 for an unknown archive (metadata)', async () => {
    const res = await app.inject({ method: 'GET', url: '/tiles/does-not-exist/metadata' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'archive not found' });
  });

  it('returns 404 for an unknown archive (tilejson)', async () => {
    const res = await app.inject({ method: 'GET', url: '/tiles/does-not-exist.json' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an unknown archive (tile)', async () => {
    const res = await app.inject({ method: 'GET', url: '/tiles/does-not-exist/0/0/0.mvt' });
    expect(res.statusCode).toBe(404);
  });
});

// Optional contract test against the real Sweden archive. Skipped automatically
// when the file is not present so the suite stays portable.
const swedenPath = path.resolve(__dirname, '../../../../data/sweden.pmtiles');
const hasSweden = fs.existsSync(swedenPath);

describe.skipIf(!hasSweden)('tiles routes (with sweden.pmtiles)', () => {
  let realApp: FastifyInstance;
  beforeEach(async () => {
    realApp = Fastify();
    await registerTilesRoutes(realApp, path.dirname(swedenPath));
    await realApp.ready();
  });
  afterEach(async () => {
    await realApp.close();
  });

  it('serves TileJSON with required fields', async () => {
    const res = await realApp.inject({ method: 'GET', url: '/tiles/sweden.json' });
    expect(res.statusCode).toBe(200);
    const tj = res.json() as Record<string, unknown>;
    expect(tj.tilejson).toBe('3.0.0');
    expect(Array.isArray(tj.tiles)).toBe(true);
    expect(typeof tj.minzoom).toBe('number');
    expect(typeof tj.maxzoom).toBe('number');
    expect(Array.isArray(tj.bounds)).toBe(true);
  });

  it('returns header + metadata at /metadata', async () => {
    const res = await realApp.inject({ method: 'GET', url: '/tiles/sweden/metadata' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { header: unknown; metadata: unknown };
    expect(body.header).toBeDefined();
    expect(body.metadata).toBeDefined();
  });
});

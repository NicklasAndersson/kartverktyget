import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

describe('GET /health', () => {
  it('returns ok=true with an ISO timestamp', async () => {
    const app = Fastify();
    app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; time: string };
    expect(body.ok).toBe(true);
    expect(() => new Date(body.time).toISOString()).not.toThrow();
    await app.close();
  });
});

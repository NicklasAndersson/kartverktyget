import type { FastifyInstance } from 'fastify';
import { PAPER_SIZES, type RenderRequest } from '@kvg/shared';
import { renderAtlas } from './engine.js';

/**
 * Snabba sanity-checks på inkommande atlas-payload. Syftet är att fånga
 * trasiga frontend-anrop med ett tydligt 400-svar istället för att låta dem
 * krascha djupt nere i Playwright eller pdf-lib. Detta är robusthet, inte
 * säkerhet – appen körs lokalt och vi litar på avsändaren.
 */
function validateRequest(body: RenderRequest | undefined): string | null {
  if (!body || typeof body !== 'object') return 'request body must be an object';
  const atlas = body.atlas;
  if (!atlas || typeof atlas !== 'object') return 'atlas required';
  if (!Array.isArray(atlas.pages) || atlas.pages.length === 0) return 'atlas.pages must be a non-empty array';
  if (!(atlas.paper in PAPER_SIZES)) return `atlas.paper must be one of ${Object.keys(PAPER_SIZES).join(', ')}`;
  if (atlas.orientation !== 'portrait' && atlas.orientation !== 'landscape') return 'atlas.orientation must be portrait|landscape';
  if (typeof atlas.scale !== 'number' || !Number.isFinite(atlas.scale) || atlas.scale <= 0) return 'atlas.scale must be a positive number';
  if (typeof atlas.margin !== 'number' || !Number.isFinite(atlas.margin) || atlas.margin < 0) return 'atlas.margin must be >= 0';
  if (typeof atlas.styleId !== 'string' || atlas.styleId.length === 0) return 'atlas.styleId required';
  if (atlas.mapSource !== 'osm' && atlas.mapSource !== 'lm') return 'atlas.mapSource must be osm|lm';
  for (let i = 0; i < atlas.pages.length; i++) {
    const page = atlas.pages[i];
    if (!page || !Array.isArray(page.center) || page.center.length !== 2) {
      return `atlas.pages[${i}].center must be [lon, lat]`;
    }
    const [lon, lat] = page.center;
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      return `atlas.pages[${i}].center must contain finite numbers`;
    }
  }
  return null;
}

export async function registerRenderRoute(app: FastifyInstance) {
  app.post<{ Body: RenderRequest }>('/render', async (req, reply) => {
    const error = validateRequest(req.body);
    if (error) return reply.code(400).send({ error });
    const pdfBytes = await renderAtlas(req.body, app.log);
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="atlas-${Date.now()}.pdf"`);
    return reply.send(Buffer.from(pdfBytes));
  });
}

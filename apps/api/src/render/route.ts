import type { FastifyInstance } from 'fastify';
import type { RenderRequest } from '@kvg/shared';
import { renderAtlas } from './engine.js';

export async function registerRenderRoute(app: FastifyInstance) {
  app.post<{ Body: RenderRequest }>('/render', async (req, reply) => {
    const body = req.body;
    if (!body?.atlas || !Array.isArray(body.atlas.pages) || body.atlas.pages.length === 0) {
      return reply.code(400).send({ error: 'atlas with at least one page required' });
    }
    const pdfBytes = await renderAtlas(body, app.log);
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="atlas-${Date.now()}.pdf"`);
    return reply.send(Buffer.from(pdfBytes));
  });
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { registerTilesRoutes } from './tiles.js';
import { registerRenderRoute } from './render/route.js';
import { shutdownBrowser } from './render/playwright.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const dataDir = path.join(repoRoot, 'data');

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  // Statiska resurser för render-page (HTML som Playwright laddar).
  const renderPageDir = path.join(__dirname, 'render', 'page');
  if (fs.existsSync(renderPageDir)) {
    await app.register(staticPlugin, {
      root: renderPageDir,
      prefix: '/render-page/',
      decorateReply: false,
    });
  }

  await registerTilesRoutes(app, dataDir);
  await registerRenderRoute(app);

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // Stäng Playwright-browsern vid process-exit så att tsx kan starta om
  // servern utan att Chromium håller processen vid liv.
  const shutdown = async () => {
    await shutdownBrowser();
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`kvg/api lyssnar på http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { registerTilesRoutes, shutdownTiles } from './tiles.js';
import { registerRenderRoute } from './render/route.js';
import { shutdownBrowser } from './render/playwright.js';
import { loadPmtilesSourcesFromEnv } from './pmtilesSources.js';
import { openSources, registerPmtilesProxy } from './pmtilesProxy.js';
import { registerStylesRoute, resolveStylesDir } from './styles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const dataDir = process.env.KVG_DATA_DIR ?? path.join(repoRoot, 'data');

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

// Byggd web-frontend (Vite output). I containern monteras /app/web/dist;
// vid lokal körning serveras frontenden istället av Vite-dev-servern.
const WEB_DIST_CANDIDATES = ['/app/web/dist', path.join(repoRoot, 'apps/web/dist')];
const webDistDir = WEB_DIST_CANDIDATES.find((p) => fs.existsSync(p));

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

  // Öppna konfigurerade PMTiles-källor (env-driven). Stäng filer vid exit.
  const sourceConfigs = loadPmtilesSourcesFromEnv();
  const sources = openSources(sourceConfigs);
  app.log.info(
    { sources: sourceConfigs.map((c) => ({ name: c.name, kind: c.kind })) },
    'pmtiles sources configured',
  );

  await registerPmtilesProxy(app, sources.entries);

  // Stilar (alltid dynamiska så att vi kan skriva om pmtiles://-URL:er).
  const stylesDir = resolveStylesDir(process.env.KVG_STYLES_DIR);
  await registerStylesRoute(app, stylesDir, sources.entries);

  // Klassiska fil-tile-routes — används av render-pagen och bakåtkompatibilitet
  // för PMTiles i ./data/.
  await registerTilesRoutes(app, dataDir);
  await registerRenderRoute(app);

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // Statisk web-frontend (om bygget finns på disk). Registreras sist så att
  // alla tidigare routes (/tiles, /pmtiles, /styles, /render…) vinner.
  if (webDistDir) {
    await app.register(staticPlugin, {
      root: webDistDir,
      prefix: '/',
      decorateReply: false,
      wildcard: false,
    });
    const indexHtml = path.join(webDistDir, 'index.html');
    app.setNotFoundHandler((req, reply) => {
      if (
        req.url.startsWith('/api/') ||
        req.url.startsWith('/tiles/') ||
        req.url.startsWith('/pmtiles/') ||
        req.url.startsWith('/styles/') ||
        req.url.startsWith('/render')
      ) {
        return reply.code(404).send({ error: 'not found' });
      }
      // SPA fallback för okända paths (deep-links etc).
      return reply.type('text/html').send(fs.readFileSync(indexHtml));
    });
    app.log.info({ webDistDir }, 'serving static web frontend');
  }

  // Stäng Playwright-browsern vid process-exit så att tsx kan starta om
  // servern utan att Chromium håller processen vid liv.
  const shutdown = async () => {
    await shutdownBrowser();
    shutdownTiles();
    sources.shutdown();
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

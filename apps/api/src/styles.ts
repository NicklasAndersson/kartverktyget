import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ArchiveEntry } from './pmtilesProxy.js';

/**
 * Stil-modul: läser MapLibre style-JSON från disk och skriver om
 * `pmtiles://`-URL:er enligt aktuella PMTiles-källor.
 *
 * Mappningen "stil → källa" är konventionsbaserad:
 *
 *   apps/web/public/styles/lantmateriet-topo10.json → källa "lm"
 *   alla övriga                                     → källa "osm"
 *
 * Stilfiler får också deklarera mappningen explicit via
 * `metadata["kvg:pmtilesSource"] = "<sourceName>"` så att nya stilar inte
 * behöver röra koden.
 */

const STYLES_DIR_CANDIDATES = [
  // Container: web/dist är monterat under public/, styles ligger där
  '/app/web/styles',
  // Lokal build/run
  join(process.cwd(), 'apps/web/public/styles'),
  join(process.cwd(), '../web/public/styles'),
];

export function resolveStylesDir(envOverride?: string): string {
  if (envOverride && existsSync(envOverride)) return envOverride;
  for (const candidate of STYLES_DIR_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `kvg: no styles directory found. Tried: ${STYLES_DIR_CANDIDATES.join(', ')}. Set KVG_STYLES_DIR.`,
  );
}

export interface StyleRewriteOptions {
  /** Karta över source-namn → URL som ska användas i den utgående stilen. */
  sourceUrls: Map<string, string>;
}

type StyleJson = {
  metadata?: Record<string, unknown>;
  sources: Record<string, { url?: string; tiles?: string[] }>;
  layers?: unknown[];
} & Record<string, unknown>;

function defaultSourceNameForStyleFile(file: string): string {
  if (file.startsWith('lantmateriet-')) return 'lm';
  return 'osm';
}

/**
 * Läser stil från disk och returnerar ett (skrivbart) style-objekt med
 * omskrivna URL:er. Kastar inte om source saknas – stilen returneras då
 * oförändrad (klienten får original-URL:en, vilket fungerar för publika
 * pmtiles-buckets utan särskild konfiguration).
 */
export function loadStyle(
  stylesDir: string,
  styleFile: string,
  opts: StyleRewriteOptions,
): StyleJson {
  const path = join(stylesDir, styleFile);
  const raw = readFileSync(path, 'utf8');
  const style = JSON.parse(raw) as StyleJson;

  const sourceName =
    (style.metadata?.['kvg:pmtilesSource'] as string | undefined) ?? defaultSourceNameForStyleFile(styleFile);
  const targetUrl = opts.sourceUrls.get(sourceName);
  if (!targetUrl) return style;

  for (const src of Object.values(style.sources ?? {})) {
    if (typeof src.url === 'string' && src.url.startsWith('pmtiles://')) {
      src.url = `pmtiles://${targetUrl}`;
    }
    if (Array.isArray(src.tiles)) {
      src.tiles = src.tiles.map((t) =>
        typeof t === 'string' && t.startsWith('pmtiles://') ? `pmtiles://${targetUrl}` : t,
      );
    }
  }
  return style;
}

/**
 * Bygger map "sourceName → publik URL" utifrån konfigurerade PMTiles-källor
 * och vilket basurl klienten ska prata med (browsern eller Playwright-rendern).
 *
 *  - file-källa             → `${baseUrl}/pmtiles/<name>`
 *  - remote-källa, public   → fjärr-URL:en direkt
 *  - remote-källa, !public  → `${baseUrl}/pmtiles/<name>` (containern proxar)
 */
export function buildSourceUrlMap(entries: Map<string, ArchiveEntry>, baseUrl: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, entry] of entries) {
    const cfg = entry.config;
    if (cfg.kind === 'remote' && cfg.isPublic) {
      map.set(name, cfg.url);
    } else {
      map.set(name, `${baseUrl.replace(/\/$/, '')}/pmtiles/${name}`);
    }
  }
  return map;
}

function externalBaseUrl(req: import('fastify').FastifyRequest): string {
  const envBase = process.env.KVG_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/$/, '');
  const xfProto = req.headers['x-forwarded-proto'];
  const xfHost = req.headers['x-forwarded-host'];
  const proto = (typeof xfProto === 'string' ? xfProto.split(',')[0]!.trim() : '') || req.protocol;
  const host = (typeof xfHost === 'string' ? xfHost.split(',')[0]!.trim() : '') || req.headers.host;
  return `${proto}://${host}`;
}

export async function registerStylesRoute(
  app: FastifyInstance,
  stylesDir: string,
  entries: Map<string, ArchiveEntry>,
) {
  app.get<{ Params: { name: string } }>('/styles/:name.json', async (req, reply) => {
    const safe = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = join(stylesDir, `${safe}.json`);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'style not found' });
    const sourceUrls = buildSourceUrlMap(entries, externalBaseUrl(req));
    const style = loadStyle(stylesDir, `${safe}.json`, { sourceUrls });
    reply.header('Cache-Control', 'no-cache');
    return reply.send(style);
  });

  // Lista över tillgängliga stilar (debug/intro-endpoint).
  app.get('/styles', async () => {
    const files = readdirSync(stylesDir).filter((f) => f.endsWith('.json'));
    return { styles: files.map((f) => f.replace(/\.json$/, '')) };
  });
}

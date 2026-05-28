import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PMTiles, Source, RangeResponse, EtagMismatch } from 'pmtiles';
import type { PmtilesSourceConfig } from './pmtilesSources.js';

/** Lokal fil som PMTiles-källa (random-access via fs.readSync). */
export class FilePmtilesSource implements Source {
  private fd: number;
  private size: number;
  constructor(public filepath: string) {
    this.fd = fs.openSync(filepath, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }
  getKey() {
    return this.filepath;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buf = Buffer.alloc(length);
    fs.readSync(this.fd, buf, 0, length, offset);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { data: ab as ArrayBuffer };
  }
  close() {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Fjärr-PMTiles via HTTP Range. Skickar valfri Authorization-header. Används
 * både av PMTiles-klassen för metadata/tile-lookups och – via openProxy – som
 * passthrough-proxy för browserns pmtiles-klient (så att credentials stannar
 * på serversidan).
 */
export class HttpPmtilesSource implements Source {
  constructor(
    public url: string,
    private authHeader?: string,
  ) {}
  getKey() {
    return this.url;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const headers: Record<string, string> = {
      Range: `bytes=${offset}-${offset + length - 1}`,
    };
    if (this.authHeader) headers.Authorization = this.authHeader;
    const res = await fetch(this.url, { headers });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`pmtiles upstream ${res.status} for ${this.url} bytes=${offset}-${offset + length - 1}`);
    }
    const buf = await res.arrayBuffer();
    return {
      data: buf,
      etag: res.headers.get('etag') ?? undefined,
      cacheControl: res.headers.get('cache-control') ?? undefined,
      expires: res.headers.get('expires') ?? undefined,
    };
  }
  /** Returnerar en (range-bevarande) passthrough mot uppströmsservern. */
  async fetchRange(rangeHeader: string | undefined): Promise<Response> {
    const headers: Record<string, string> = {};
    if (rangeHeader) headers.Range = rangeHeader;
    if (this.authHeader) headers.Authorization = this.authHeader;
    return fetch(this.url, { headers });
  }
}

export interface ArchiveEntry {
  name: string;
  config: PmtilesSourceConfig;
  archive: PMTiles;
  source: FilePmtilesSource | HttpPmtilesSource;
  contentType: string;
}

/**
 * Bygg en runtime-cache av alla konfigurerade PMTiles-källor. Returnerar en
 * Map (namn → entry) och en shutdown-funktion som stänger filer.
 */
export function openSources(configs: PmtilesSourceConfig[]) {
  const entries = new Map<string, ArchiveEntry>();
  for (const config of configs) {
    let source: FilePmtilesSource | HttpPmtilesSource;
    if (config.kind === 'file') {
      if (!fs.existsSync(config.file)) {
        throw new Error(`pmtiles source "${config.name}": file not found: ${config.file}`);
      }
      source = new FilePmtilesSource(config.file);
    } else {
      source = new HttpPmtilesSource(config.url, config.auth);
    }
    const archive = new PMTiles(source);
    entries.set(config.name, {
      name: config.name,
      config,
      archive,
      source,
      contentType: 'application/x-protobuf',
    });
  }
  return {
    entries,
    shutdown() {
      for (const entry of entries.values()) {
        if (entry.source instanceof FilePmtilesSource) entry.source.close();
      }
      entries.clear();
    },
  };
}

/**
 * Registrera `/pmtiles/:name.pmtiles` (och `/pmtiles/:name` alias). Browserns
 * pmtiles-klient skickar Range-requests hit; vi svarar antingen från lokal fil
 * (via Source-API:t) eller passthrough-proxy mot fjärr-URL.
 *
 * Endpointen tillhandahåller alltid 206 Partial Content med byte-range som
 * specificerats av klienten — det är den enda HTTP-yta pmtiles.js behöver.
 */
export async function registerPmtilesProxy(app: FastifyInstance, entries: Map<string, ArchiveEntry>) {
  const handler = async (req: import('fastify').FastifyRequest, reply: FastifyReply) => {
    const name = (req.params as { name: string }).name.replace(/\.pmtiles$/i, '');
    const entry = entries.get(name);
    if (!entry) return reply.code(404).send({ error: 'pmtiles source not found' });

    const rangeHeader = req.headers.range as string | undefined;

    if (entry.source instanceof HttpPmtilesSource) {
      // Passthrough — bevara Range-header och status/headers från uppströms.
      const upstream = await entry.source.fetchRange(rangeHeader);
      const passHeaders = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
      ];
      for (const h of passHeaders) {
        const v = upstream.headers.get(h);
        if (v) reply.header(h, v);
      }
      reply.header('Cache-Control', 'public, max-age=60');
      reply.code(upstream.status);
      return reply.send(Buffer.from(await upstream.arrayBuffer()));
    }

    // Lokal fil: tolka Range och svara med 206 / 200.
    const file = entry.source as FilePmtilesSource;
    const size = fs.statSync(file.filepath).size;
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', 'application/octet-stream');
    if (!rangeHeader) {
      reply.header('Content-Length', String(size));
      return reply.send(fs.createReadStream(file.filepath));
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!m) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    }
    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', String(end - start + 1));
    return reply.send(fs.createReadStream(file.filepath, { start, end }));
  };

  app.get<{ Params: { name: string } }>('/pmtiles/:name', handler);
  app.head<{ Params: { name: string } }>('/pmtiles/:name', handler);
}

export { EtagMismatch };

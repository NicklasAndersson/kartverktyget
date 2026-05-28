import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PMTiles, Source, RangeResponse, EtagMismatch } from 'pmtiles';

/**
 * Minimal fil-baserad PMTiles-källa för Node.
 * Implementerar bara det `PMTiles`-klassen behöver: getBytes + getKey.
 */
class FileSource implements Source {
  private fd: number;
  private size: number;
  constructor(public filepath: string) {
    this.fd = fs.openSync(filepath, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }
  getKey(): string {
    return this.filepath;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buf = Buffer.alloc(length);
    fs.readSync(this.fd, buf, 0, length, offset);
    // Returnera kopia som ArrayBuffer.
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
  get fileSize(): number {
    return this.size;
  }
}

interface ArchiveEntry {
  archive: PMTiles;
  source: FileSource;
  contentType: string;
}

const archives = new Map<string, ArchiveEntry>();

function getArchive(name: string, dataDir: string): ArchiveEntry | null {
  const existing = archives.get(name);
  if (existing) return existing;
  const filepath = path.join(dataDir, `${name}.pmtiles`);
  if (!fs.existsSync(filepath)) return null;
  const source = new FileSource(filepath);
  const archive = new PMTiles(source);
  // Vector eller raster bestäms senare via header.
  const entry: ArchiveEntry = { archive, source, contentType: 'application/x-protobuf' };
  archives.set(name, entry);
  return entry;
}

/**
 * Stänger alla öppna PMTiles-källor och tömmer cachen. Anropa vid process-exit
 * så att fil-deskriptorer inte läcker mellan upprepade dev-starter eller tester.
 */
export function shutdownTiles() {
  for (const entry of archives.values()) {
    entry.source.close();
  }
  archives.clear();
}

export async function registerTilesRoutes(app: FastifyInstance, dataDir: string) {
  app.get<{ Params: { name: string } }>('/tiles/:name/metadata', async (req, reply) => {
    const entry = getArchive(req.params.name, dataDir);
    if (!entry) return reply.code(404).send({ error: 'archive not found' });
    const header = await entry.archive.getHeader();
    const metadata = await entry.archive.getMetadata();
    return reply.send({ header, metadata });
  });

  // Serve TileJSON så MapLibre kan använda källan via `type: vector, url: ...`
  app.get<{ Params: { name: string } }>('/tiles/:name.json', async (req, reply) => {
    const entry = getArchive(req.params.name, dataDir);
    if (!entry) return reply.code(404).send({ error: 'archive not found' });
    const header = await entry.archive.getHeader();
    const metadata = (await entry.archive.getMetadata()) as Record<string, unknown>;
    const base = `${req.protocol}://${req.headers.host}`;
    const tj = {
      tilejson: '3.0.0',
      tiles: [`${base}/tiles/${req.params.name}/{z}/{x}/{y}.${tileExtForType(header.tileType)}`],
      minzoom: header.minZoom,
      maxzoom: header.maxZoom,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
      center: [header.centerLon, header.centerLat, header.centerZoom],
      vector_layers: metadata.vector_layers ?? undefined,
      ...metadata,
    };
    return reply.send(tj);
  });

  app.get<{ Params: { name: string; z: string; x: string; y: string } }>(
    '/tiles/:name/:z/:x/:y.:ext',
    async (req, reply) => {
      const entry = getArchive(req.params.name, dataDir);
      if (!entry) return reply.code(404).send({ error: 'archive not found' });
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      try {
        const tile = await entry.archive.getZxy(z, x, y);
        if (!tile) return reply.code(204).send();
        const header = await entry.archive.getHeader();
        // getZxy() returnerar redan dekomprimerad tile-data (pmtiles v4 decompresserar via fflate).
        reply
          .header('Content-Type', contentTypeForTileType(header.tileType))
          .header('Cache-Control', 'public, max-age=86400');
        return reply.send(Buffer.from(tile.data));
      } catch (err) {
        if (err instanceof EtagMismatch) return reply.code(500).send({ error: 'etag mismatch' });
        throw err;
      }
    },
  );
}

function tileExtForType(t: number): string {
  switch (t) {
    case 1:
      return 'mvt'; // mapbox vector tiles
    case 2:
      return 'png';
    case 3:
      return 'jpg';
    case 4:
      return 'webp';
    case 5:
      return 'avif';
    default:
      return 'bin';
  }
}

function contentTypeForTileType(t: number): string {
  switch (t) {
    case 1:
      return 'application/x-protobuf';
    case 2:
      return 'image/png';
    case 3:
      return 'image/jpeg';
    case 4:
      return 'image/webp';
    case 5:
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

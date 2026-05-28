/**
 * Konfiguration av PMTiles-källor från miljövariabler.
 *
 * Varje källa har ett namn (t.ex. "osm", "lm") och en backing-typ:
 *
 *   PMTILES_<NAME>_FILE   – sökväg till lokal .pmtiles-fil
 *   PMTILES_<NAME>_URL    – HTTP(S)-URL till en fjärr-pmtiles
 *   PMTILES_<NAME>_AUTH   – valfri Authorization-header (Basic/Bearer …)
 *                           som proxyn lägger till på utgående requests
 *   PMTILES_<NAME>_PUBLIC – om "true" så får browser-klienten URL:en direkt
 *                           (annars proxas alla läsningar via containern så
 *                           att eventuella credentials aldrig läcker ut)
 *
 * Källornas namn väljs fritt; default-applikationen använder "osm" och "lm".
 */

export type PmtilesSourceConfig =
  | { kind: 'file'; name: string; file: string }
  | { kind: 'remote'; name: string; url: string; auth?: string; isPublic: boolean };

const SOURCE_NAME_RE = /^PMTILES_([A-Z0-9_]+)_(FILE|URL)$/;

/**
 * Läs in alla källor från process.env. Källor utan FILE/URL ignoreras tyst.
 */
export function loadPmtilesSourcesFromEnv(env: NodeJS.ProcessEnv = process.env): PmtilesSourceConfig[] {
  const names = new Set<string>();
  for (const key of Object.keys(env)) {
    const match = SOURCE_NAME_RE.exec(key);
    if (match && env[key]) names.add(match[1]!.toLowerCase());
  }
  const out: PmtilesSourceConfig[] = [];
  for (const name of names) {
    const upper = name.toUpperCase();
    const file = env[`PMTILES_${upper}_FILE`]?.trim();
    const url = env[`PMTILES_${upper}_URL`]?.trim();
    const auth = env[`PMTILES_${upper}_AUTH`]?.trim() || undefined;
    const isPublic = (env[`PMTILES_${upper}_PUBLIC`] ?? '').toLowerCase() === 'true';
    if (file) {
      out.push({ kind: 'file', name, file });
    } else if (url) {
      out.push({ kind: 'remote', name, url, auth, isPublic });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

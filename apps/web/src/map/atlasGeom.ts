import type { Feature, FeatureCollection, Polygon, Point } from 'geojson';
import { pageMetersOnGround, type AtlasSpec } from '@kvg/shared';

/**
 * Beräknar atlas-sidornas geografiska rektanglar (för visualisering på kartan).
 * Sidan har fast geografisk storlek = (papper_mm - 2*marginal) × skala / 1000 i meter.
 * Använder flat-jord-approximation kring varje sidas centrum (samma som backend).
 */
export function computeAtlasPageRects(atlas: AtlasSpec): FeatureCollection {
  const { widthM, heightM } = pageMetersOnGround(atlas);
  const features: Feature[] = [];
  atlas.pages.forEach((page, idx) => {
    const [lon, lat] = page.center;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const dLat = heightM / 2 / mPerDegLat;
    const dLon = widthM / 2 / mPerDegLon;
    const ring: [number, number][] = [
      [lon - dLon, lat - dLat],
      [lon + dLon, lat - dLat],
      [lon + dLon, lat + dLat],
      [lon - dLon, lat + dLat],
      [lon - dLon, lat - dLat],
    ];
    features.push({
      type: 'Feature',
      id: page.id,
      properties: { pageId: page.id, index: idx },
      geometry: { type: 'Polygon', coordinates: [ring] } satisfies Polygon,
    });
    features.push({
      type: 'Feature',
      properties: { label: String(idx + 1) },
      geometry: { type: 'Point', coordinates: [lon, lat] } satisfies Point,
    });
  });
  return { type: 'FeatureCollection', features };
}

import * as mgrsModule from 'mgrs';
import { formatMgrs } from '@kvg/shared';

const mgrs = ('default' in mgrsModule ? mgrsModule.default : mgrsModule) as typeof import('mgrs');

export function latlonToMgrs(lon: number, lat: number, precision = 5): string {
  try {
    return formatMgrs(mgrs.forward([lon, lat], precision));
  } catch {
    return '—';
  }
}

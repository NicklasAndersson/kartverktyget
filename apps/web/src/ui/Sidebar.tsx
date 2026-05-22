import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { gpx as gpxToGeoJson } from '@tmcw/togeojson';
import { useStore } from '../state/store.js';
import { COMMON_SCALES, pageMetersOnGround } from '@kvg/shared';
import type { StyleId, Scale, PaperSize, Orientation, LabelSize } from '@kvg/shared';

const ICONS = [
  { name: 'tent', label: 'Tält' },
  { name: 'fire', label: 'Eldplats' },
  { name: 'water', label: 'Vatten' },
  { name: 'parking', label: 'Parkering' },
  { name: 'warning', label: 'Varning' },
];

const STYLE_OPTIONS: Array<{ value: StyleId; label: string }> = [
  { value: 'friluft', label: 'Friluft (färg)' },
  { value: 'sw-laser', label: 'Svartvitt (laser)' },
  { value: 'minimal', label: 'Minimalistisk' },
  { value: 'protomaps-light', label: 'Protomaps Light' },
  { value: 'protomaps-dark', label: 'Protomaps Dark' },
  { value: 'protomaps-white', label: 'Protomaps White' },
  { value: 'protomaps-grayscale', label: 'Protomaps Grayscale' },
  { value: 'protomaps-black', label: 'Protomaps Black' },
  { value: 'protomaps-bio', label: 'Protomaps Bio' },
  { value: 'protomaps-seafoam', label: 'Protomaps Seafoam' },
  { value: 'protomaps-dusk-rose', label: 'Protomaps Dusk Rose' },
  { value: 'protomaps-flat', label: 'Protomaps Flat' },
];

const SIZE_OPTIONS: Array<{ value: LabelSize; label: string }> = [
  { value: 'small', label: 'Liten' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Stor' },
  { value: 'xl', label: 'Extra stor' },
];

export function Sidebar() {
  const styleId = useStore((s) => s.styleId);
  const setStyleId = useStore((s) => s.setStyleId);
  const labels = useStore((s) => s.labels);
  const setLabels = useStore((s) => s.setLabels);
  const labelSize = useStore((s) => s.labelSize);
  const setLabelSize = useStore((s) => s.setLabelSize);
  const roadSize = useStore((s) => s.roadSize);
  const setRoadSize = useStore((s) => s.setRoadSize);
  const contours = useStore((s) => s.contours);
  const setContours = useStore((s) => s.setContours);
  const mgrsGrid = useStore((s) => s.mgrsGrid);
  const setMgrsGrid = useStore((s) => s.setMgrsGrid);
  const mgrsMode = useStore((s) => s.mgrsMode);
  const setMgrsMode = useStore((s) => s.setMgrsMode);
  const mgrsGridSizeBias = useStore((s) => s.mgrsGridSizeBias);
  const setMgrsGridSizeBias = useStore((s) => s.setMgrsGridSizeBias);
  const atlas = useStore((s) => s.atlas);
  const setAtlas = useStore((s) => s.setAtlas);
  const addPage = useStore((s) => s.addPage);
  const removePage = useStore((s) => s.removePage);
  const drawMode = useStore((s) => s.drawMode);
  const setDrawMode = useStore((s) => s.setDrawMode);
  const iconName = useStore((s) => s.iconName);
  const setIconName = useStore((s) => s.setIconName);
  const addTrack = useStore((s) => s.addTrack);
  const addWaypoint = useStore((s) => s.addWaypoint);
  const clearOverlays = useStore((s) => s.clearOverlays);
  const overlays = useStore((s) => s.overlays);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  const onGpx = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const dom = new DOMParser().parseFromString(text, 'application/xml');
    const fc = gpxToGeoJson(dom) as GeoJSON.FeatureCollection;
    for (const feat of fc.features) {
      if (feat.geometry.type === 'LineString') {
        addTrack(feat.geometry, feat.properties ?? {});
      } else if (feat.geometry.type === 'MultiLineString') {
        for (const coords of feat.geometry.coordinates) {
          addTrack({ type: 'LineString', coordinates: coords as [number, number][] }, feat.properties ?? {});
        }
      } else if (feat.geometry.type === 'Point') {
        addWaypoint(feat.geometry, feat.properties ?? {});
      }
    }
    e.target.value = '';
  };

  const onAddPage = () => {
    // Lägg sida i mitten av nuvarande viewport.
    const map = (window as unknown as { __kvgMap?: { getCenter(): { lng: number; lat: number }; fitBounds(b: unknown, o?: unknown): void } }).__kvgMap;
    const center: [number, number] = map ? [map.getCenter().lng, map.getCenter().lat] : [18.0686, 59.3293];
    addPage({ id: crypto.randomUUID(), center });
    // Zooma kartan för att visa hela sid-rektangeln.
    if (map) {
      const { widthM, heightM } = pageMetersOnGround(atlas);
      const [lon, lat] = center;
      const mPerDegLat = 111320;
      const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
      const dLat = heightM / 2 / mPerDegLat;
      const dLon = widthM / 2 / mPerDegLon;
      map.fitBounds(
        [[lon - dLon, lat - dLat], [lon + dLon, lat + dLat]],
        { padding: 40, duration: 400 },
      );
    }
  };

  const generatePdf = async () => {
    if (atlas.pages.length === 0) {
      alert('Lägg till minst en sida först.');
      return;
    }
    setPdfLoading(true);
    try {
      const res = await fetch('/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atlas, overlays }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => String(res.status));
        alert(`Render misslyckades: ${err}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `atlas-${Date.now()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Nätverksfel: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <aside className="sidebar">
      <h1>Fältkarta Pro</h1>

      <h2>Stil</h2>
      <select value={styleId} onChange={(e) => setStyleId(e.target.value as StyleId)}>
        {STYLE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <label style={{ marginTop: 8 }}>
        <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Gatunamn och text
      </label>
      <label>
        Textstorlek
        <select value={labelSize} onChange={(e) => setLabelSize(e.target.value as LabelSize)}>
          {SIZE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Vägbredd
        <select value={roadSize} onChange={(e) => setRoadSize(e.target.value as LabelSize)}>
          {SIZE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label style={{ marginTop: 8 }}>
        <input type="checkbox" checked={contours} onChange={(e) => setContours(e.target.checked)} /> Höjdkurvor
      </label>
      <label>
        <input type="checkbox" checked={mgrsGrid} onChange={(e) => setMgrsGrid(e.target.checked)} /> MGRS-nät
      </label>
      <label>
        MGRS-visning
        <select value={mgrsMode} onChange={(e) => setMgrsMode(e.target.value as 'full' | 'frame')}>
          <option value="full">Rutnät</option>
          <option value="frame">Endast ram</option>
        </select>
      </label>
      <label>
        MGRS-rutstorlek
        <select
          value={mgrsGridSizeBias}
          disabled={mgrsMode !== 'full'}
          onChange={(e) => setMgrsGridSizeBias(Number(e.target.value) as -1 | 0 | 1)}
        >
          <option value={-1}>Större rutor</option>
          <option value={0}>Standard</option>
          <option value={1}>Mindre rutor</option>
        </select>
      </label>

      <h2>GPX / Ritning</h2>
      <input ref={fileRef} type="file" accept=".gpx,application/gpx+xml" onChange={onGpx} />
      <div style={{ marginTop: 6 }}>
        <button className={drawMode === 'waypoint' ? '' : 'secondary'} onClick={() => setDrawMode(drawMode === 'waypoint' ? 'none' : 'waypoint')}>
          Punkt
        </button>
        <button className={drawMode === 'track' ? '' : 'secondary'} onClick={() => setDrawMode(drawMode === 'track' ? 'none' : 'track')}>
          Linje (dubbelklicka = klar)
        </button>
        <button className="secondary" onClick={clearOverlays}>
          Rensa
        </button>
      </div>

      <h2>Ikoner</h2>
      <div>
        {ICONS.map((ic) => (
          <button
            key={ic.name}
            className={iconName === ic.name ? '' : 'secondary'}
            onClick={() => setIconName(iconName === ic.name ? null : ic.name)}
          >
            {ic.label}
          </button>
        ))}
      </div>

      <h2>Utskrift</h2>
      <label>
        Skala
        <select value={atlas.scale} onChange={(e) => setAtlas({ ...atlas, scale: Number(e.target.value) as Scale })}>
          {COMMON_SCALES.map((scale) => (
            <option key={scale} value={scale}>{`1:${scale.toLocaleString('sv-SE')}`}</option>
          ))}
        </select>
      </label>
      <label>
        Papper
        <select value={atlas.paper} onChange={(e) => setAtlas({ ...atlas, paper: e.target.value as PaperSize })}>
          <option value="A5">A5</option>
          <option value="A4">A4</option>
          <option value="A3">A3</option>
        </select>
      </label>
      <label>
        Orientering
        <select
          value={atlas.orientation}
          onChange={(e) => setAtlas({ ...atlas, orientation: e.target.value as Orientation })}
        >
          <option value="landscape">Liggande</option>
          <option value="portrait">Stående</option>
        </select>
      </label>
      <label>
        Marginal (mm)
        <input
          type="number"
          min={5}
          max={40}
          value={atlas.margin}
          onChange={(e) => setAtlas({ ...atlas, margin: Number(e.target.value) })}
        />
      </label>

      <div style={{ marginTop: 8 }}>
        <button onClick={onAddPage}>+ Lägg till sida</button>
      </div>
      <ol style={{ fontSize: 12, paddingLeft: 18, marginTop: 8 }}>
        {atlas.pages.map((p, i) => (
          <li key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>
              {i + 1}. {p.center[0].toFixed(4)}, {p.center[1].toFixed(4)}
            </span>
            <button className="secondary" style={{ padding: '2px 6px' }} onClick={() => removePage(p.id)}>
              ✕
            </button>
          </li>
        ))}
      </ol>

      <div style={{ marginTop: 12 }}>
        <button onClick={generatePdf} disabled={pdfLoading}>
          {pdfLoading ? 'Genererar PDF…' : 'Generera PDF'}
        </button>
      </div>
    </aside>
  );
}

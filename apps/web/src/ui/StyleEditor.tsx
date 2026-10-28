import { useEffect, useMemo, useState } from 'react';
import { scaleStyleExpression, type StyleLayerLike } from '@kvg/shared';
import { useStore } from '../state/store.js';

type Kind = 'paint' | 'layout';
type Control = { kind: Kind; prop: string; label: string; type: 'color' | 'number' | 'scale'; min?: number; max?: number; step?: number };

const CONTROLS: Record<string, Control[]> = {
  fill: [
    { kind: 'paint', prop: 'fill-color', label: 'Fyllnadsfärg', type: 'color' },
    { kind: 'paint', prop: 'fill-opacity', label: 'Opacitet', type: 'number', min: 0, max: 1, step: 0.05 },
    { kind: 'paint', prop: 'fill-outline-color', label: 'Kantfärg', type: 'color' },
  ],
  line: [
    { kind: 'paint', prop: 'line-color', label: 'Linjefärg', type: 'color' },
    { kind: 'paint', prop: 'line-width', label: 'Linjebredd', type: 'scale', min: 0, max: 40, step: 0.5 },
    { kind: 'paint', prop: 'line-opacity', label: 'Opacitet', type: 'number', min: 0, max: 1, step: 0.05 },
  ],
  symbol: [
    { kind: 'paint', prop: 'text-color', label: 'Textfärg', type: 'color' },
    { kind: 'paint', prop: 'text-halo-color', label: 'Textkantfärg', type: 'color' },
    { kind: 'paint', prop: 'text-halo-width', label: 'Textkantbredd', type: 'number', min: 0, max: 10, step: 0.25 },
    { kind: 'layout', prop: 'text-size', label: 'Textstorlek', type: 'scale', min: 4, max: 60, step: 1 },
  ],
  background: [{ kind: 'paint', prop: 'background-color', label: 'Bakgrundsfärg', type: 'color' }],
};

/** <input type="color"> vill ha #rrggbb; låt webbläsaren tolka rgb()/hsl()/namn. */
function toHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillStyle = value;
  const out = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(out) ? out : null;
}

export function StyleEditor() {
  const styleId = useStore((s) => s.styleId);
  const activeCustomId = useStore((s) => s.activeCustomId);
  const overrides = useStore((s) => s.atlas.styleOverrides);
  const selectedLayerId = useStore((s) => s.selectedLayerId);
  const setSelectedLayerId = useStore((s) => s.setSelectedLayerId);
  const inspectMode = useStore((s) => s.inspectMode);
  const setInspectMode = useStore((s) => s.setInspectMode);
  const hits = useStore((s) => s.inspectHits);
  const setLayerProp = useStore((s) => s.setLayerProp);
  const resetLayer = useStore((s) => s.resetLayer);
  const [layers, setLayers] = useState<StyleLayerLike[]>([]);
  const [search, setSearch] = useState('');
  const readOnly = !activeCustomId;

  useEffect(() => {
    let cancelled = false;
    fetch(`/styles/${styleId}.json`)
      .then((r) => r.json())
      .then((style: { layers?: StyleLayerLike[] }) => {
        if (!cancelled) setLayers((style.layers ?? []).filter((l) => l.id && !l.id.startsWith('kvg-')));
      })
      .catch(() => {
        if (!cancelled) setLayers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [styleId]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? layers.filter((l) => l.id!.toLowerCase().includes(q)) : layers;
  }, [layers, search]);
  const layer = layers.find((l) => l.id === selectedLayerId);
  const controls = layer?.type ? CONTROLS[layer.type] : undefined;
  const ov = layer?.id ? overrides?.[layer.id] : undefined;

  return (
    <div>
      <button className={inspectMode ? '' : 'secondary'} onClick={() => setInspectMode(!inspectMode)}>
        {inspectMode ? 'Inspekterar – klicka på kartan' : 'Inspektera karta'}
      </button>
      {hits.length > 0 && (
        <div className="inspect-hits">
          {hits.map((h, i) => (
            <div
              key={`${h.layerId}-${i}`}
              className={`inspect-hit${h.layerId === selectedLayerId ? ' selected' : ''}`}
              onClick={() => setSelectedLayerId(h.layerId)}
              title={JSON.stringify(h.properties, null, 1)}
            >
              <strong>{h.layerId}</strong> <span>{h.sourceLayer} · {h.geometry}</span>
              <div>
                {Object.entries(h.properties)
                  .slice(0, 4)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(', ')}
              </div>
            </div>
          ))}
        </div>
      )}

      <input type="search" placeholder="Sök lager…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <select size={6} value={selectedLayerId ?? ''} onChange={(e) => setSelectedLayerId(e.target.value)}>
        {shown.map((l) => (
          <option key={l.id} value={l.id}>
            {overrides?.[l.id!] ? '● ' : ''}
            {l.id} ({l.type})
          </option>
        ))}
      </select>

      {layer && (
        <div className="style-editor">
          <h2>{layer.id}</h2>
          {readOnly && <p className="hint">Inbyggd stil – spara som ny stil för att kunna ändra.</p>}
          <label>
            <input
              type="checkbox"
              disabled={readOnly}
              checked={(ov?.layout?.visibility ?? layer.layout?.visibility) !== 'none'}
              onChange={(e) => setLayerProp(layer.id!, 'layout', 'visibility', e.target.checked ? 'visible' : 'none')}
            />{' '}
            Synligt
          </label>
          {controls?.map((c) => (
            <ControlRow
              key={c.prop}
              control={c}
              base={(layer[c.kind] as Record<string, unknown> | undefined)?.[c.prop]}
              value={ov?.[c.kind]?.[c.prop]}
              disabled={readOnly}
              onChange={(v) => setLayerProp(layer.id!, c.kind, c.prop, v)}
            />
          ))}
          {!readOnly && ov && (
            <button className="secondary" onClick={() => resetLayer(layer.id!)}>
              Återställ lager
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ControlRow({
  control,
  base,
  value,
  disabled,
  onChange,
}: {
  control: Control;
  base: unknown;
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const current = value ?? base;
  const { type, label, min, max, step } = control;

  if (type === 'color') {
    const hex = toHex(current);
    return (
      <label>
        {label}
        <div className="size-control-row">
          <input type="color" disabled={disabled} value={hex ?? '#000000'} onChange={(e) => onChange(e.target.value)} />
          {hex == null && <span className="hint">uttryck – välj färg för att ersätta</span>}
        </div>
      </label>
    );
  }

  // Tal, eller zoom-uttryck som skalas med en faktor (annars försvinner zoomanpassningen).
  const isNumber = typeof current === 'number';
  if (type === 'number' || isNumber) {
    return (
      <label>
        {label}
        <input
          type="number"
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          value={isNumber ? current : ''}
          onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))}
        />
      </label>
    );
  }
  return (
    <label>
      {label} (faktor på zoomberoende värde{value != null ? ', anpassad' : ''})
      <input
        type="number"
        disabled={disabled}
        min={0.1}
        max={5}
        step={0.1}
        defaultValue={1}
        key={String(value == null)}
        onChange={(e) => Number(e.target.value) > 0 && onChange(scaleStyleExpression(base, Number(e.target.value)))}
      />
    </label>
  );
}

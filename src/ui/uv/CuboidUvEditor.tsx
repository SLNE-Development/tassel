import { Box as BoxIcon, FlipHorizontal2, FlipVertical2, Maximize2, Wand2, CopyCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { create } from 'zustand';
import { selectDocState, useApp } from '../../app/store';
import { uvSize } from '../../core/minecraft/cuboid';
import { cuboidFaces, uvRotations, type Cuboid, type CuboidFace, type CuboidFaceName, type SceneObject, type UvRotation } from '../../core/types';
import { useT } from '../../i18n';
import { dispatch } from '../actions';
import { PickMenu, Segmented, Switch } from '../controls';
import { useLiveEdit } from '../live';
import { smallButton } from '../minecraft/fields';
import { ScrubField } from '../ScrubField';
import { Tip } from '../Tip';
import { boxToUv, dragBox, snapStep, topEdge, uvToBox, type Box, type Handle } from './cuboidUv';

/** Transient state of the cuboid UV editor. */
export const useCuboidUv = create<{ face: CuboidFaceName }>(() => ({ face: 'north' }));

const MARGIN = 14;
const HANDLE_PX = 8;

const handles: { handle: Handle; cx: 0 | 0.5 | 1; cy: 0 | 0.5 | 1; cursor: string }[] = [
  { handle: 'nw', cx: 0, cy: 0, cursor: 'nwse-resize' },
  { handle: 'n', cx: 0.5, cy: 0, cursor: 'ns-resize' },
  { handle: 'ne', cx: 1, cy: 0, cursor: 'nesw-resize' },
  { handle: 'e', cx: 1, cy: 0.5, cursor: 'ew-resize' },
  { handle: 'se', cx: 1, cy: 1, cursor: 'nwse-resize' },
  { handle: 's', cx: 0.5, cy: 1, cursor: 'ns-resize' },
  { handle: 'sw', cx: 0, cy: 1, cursor: 'nesw-resize' },
  { handle: 'w', cx: 0, cy: 0.5, cursor: 'ew-resize' },
];

type CuboidObject = SceneObject & { cuboid: Cuboid };

/** The element the editor works on: the active object, if it is a cuboid. */
function useElement(): CuboidObject | undefined {
  return useApp((s) => {
    const state = selectDocState(s);
    const obj = state.activeId ? state.objects[state.activeId] : undefined;
    return obj?.cuboid ? (obj as CuboidObject) : undefined;
  });
}

function useSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** The face's texture as a data URL, with the texture's own size. */
function useTextureUrl(id: string | null): { url: string; width: number; height: number } | null {
  const texture = useApp((s) => (id ? selectDocState(s).textures[id] : undefined));
  return useMemo(() => (texture ? { url: `data:${texture.mimeType};base64,${texture.data}`, width: texture.width, height: texture.height } : null), [texture]);
}

/** The texture at the document's UV size with the face's UV rectangle on it, draggable and resizable. */
function Canvas({ element, face, size }: { element: CuboidObject; face: CuboidFaceName; size: readonly [number, number] }) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const { width, height } = useSize(host);
  const live = useLiveEdit();
  const t = useT().mc.uv;
  const data = element.cuboid.faces[face];
  const texture = useTextureUrl(data.texture);
  const drag = useRef<{ handle: Handle; start: Box; x: number; y: number; scale: number } | null>(null);

  const scale = Math.max(0.01, Math.min((width - 2 * MARGIN) / size[0], (height - 2 * MARGIN) / size[1]));
  const left = (width - size[0] * scale) / 2;
  const top = (height - size[1] * scale) / 2;
  const box = uvToBox(data.uv);

  const begin = (handle: Handle) => (event: PointerEvent<SVGElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    svg.current?.setPointerCapture(event.pointerId);
    drag.current = { handle, start: box, x: event.clientX, y: event.clientY, scale };
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = dragBox(d.start, d.handle, (event.clientX - d.x) / d.scale, (event.clientY - d.y) / d.scale, snapStep(event.shiftKey, event.ctrlKey || event.metaKey), size);
    live.scrub('cuboid.set_face', { ids: [element.id], faces: [face], uv: boxToUv(next, data.uv) });
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    live.end();
  };

  const gridLines: string[] = [];
  if (scale >= 4) {
    for (let x = 0; x <= size[0]; x += 1) gridLines.push(`M${x} 0V${size[1]}`);
    for (let y = 0; y <= size[1]; y += 1) gridLines.push(`M0 ${y}H${size[0]}`);
  }
  const hs = HANDLE_PX / scale;
  const edge = topEdge(data.rotation);
  const marker = { n: [box.x, box.y, box.x + box.w, box.y], e: [box.x + box.w, box.y, box.x + box.w, box.y + box.h], s: [box.x, box.y + box.h, box.x + box.w, box.y + box.h], w: [box.x, box.y, box.x, box.y + box.h] }[edge];

  return (
    <div ref={host} className="absolute inset-0 select-none">
      <svg
        ref={svg}
        role="img"
        aria-label={t.canvas(element.name)}
        className="absolute inset-0 h-full w-full touch-none"
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <defs>
          <pattern id="mc-uv-checker" width="2" height="2" patternUnits="userSpaceOnUse">
            <rect width="2" height="2" fill="var(--panel)" />
            <rect width="1" height="1" fill="var(--raised)" />
            <rect x="1" y="1" width="1" height="1" fill="var(--raised)" />
          </pattern>
        </defs>
        <g transform={`translate(${left} ${top}) scale(${scale})`}>
          <rect width={size[0]} height={size[1]} fill="url(#mc-uv-checker)" />
          {texture && <image href={texture.url} width={size[0]} height={size[1]} preserveAspectRatio="none" style={{ imageRendering: 'pixelated' }} />}
          {gridLines.length > 0 && <path d={gridLines.join('')} stroke="var(--faint)" strokeOpacity={0.3} strokeWidth={1 / scale} fill="none" />}
          <rect width={size[0]} height={size[1]} fill="none" stroke="var(--line-strong)" strokeWidth={1 / scale} />
          {/* The other faces of the element, as a reference for where they sit. */}
          {cuboidFaces
            .filter((other) => other !== face && element.cuboid.faces[other].enabled)
            .map((other) => {
              const o = uvToBox(element.cuboid.faces[other].uv);
              return <rect key={other} x={o.x} y={o.y} width={o.w} height={o.h} fill="none" stroke="var(--faint)" strokeOpacity={0.7} strokeWidth={1 / scale} strokeDasharray={`${3 / scale} ${3 / scale}`} />;
            })}
          <rect
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            fill="var(--accent)"
            fillOpacity={data.enabled ? 0.16 : 0.04}
            stroke="var(--accent)"
            strokeWidth={1.5 / scale}
            style={{ cursor: 'move' }}
            onPointerDown={begin('move')}
          />
          <line x1={marker[0]} y1={marker[1]} x2={marker[2]} y2={marker[3]} stroke="var(--accent)" strokeWidth={4 / scale} pointerEvents="none" />
          {handles.map(({ handle, cx, cy, cursor }) => (
            <rect
              key={handle}
              x={box.x + box.w * cx - hs / 2}
              y={box.y + box.h * cy - hs / 2}
              width={hs}
              height={hs}
              fill="var(--accent-ink)"
              stroke="var(--accent)"
              strokeWidth={1.5 / scale}
              style={{ cursor }}
              onPointerDown={begin(handle)}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

function FaceTabs({ element, face }: { element: CuboidObject; face: CuboidFaceName }) {
  const t = useT().mc;
  return (
    <Segmented
      label={t.uv.face}
      value={face}
      options={cuboidFaces.map((name) => ({
        value: name,
        ariaLabel: t.faces[name],
        title: <span title={t.faces[name]} className={element.cuboid.faces[name].enabled ? '' : 'line-through opacity-60'}>{t.faceShort[name]}</span>,
      }))}
      onChange={(next) => useCuboidUv.setState({ face: next })}
    />
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="truncate text-[calc(12px*var(--font-scale))] text-dim">{title}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The numbers and switches of the face: UV rectangle, rotation, texture, tint and cullface. */
function FaceForm({ element, face }: { element: CuboidObject; face: CuboidFaceName }) {
  const t = useT().mc;
  const textures = useApp((s) => selectDocState(s).textures);
  const live = useLiveEdit();
  const data: CuboidFace = element.cuboid.faces[face];
  const box = uvToBox(data.uv);
  const ids = [element.id];
  const setFace = (params: Record<string, unknown>) => void dispatch('cuboid.set_face', { ids, faces: [face], ...params });
  const op = (name: string, extra: Record<string, unknown> = {}) => void dispatch('cuboid.uv', { ids, faces: [face], op: name, ...extra });
  const boxField = (key: keyof Box, label: string) => (
    <ScrubField
      key={key}
      label={label}
      ariaLabel={t.uv.fields[key]}
      color="var(--dim)"
      value={box[key]}
      step={0.25}
      min={key === 'w' || key === 'h' ? 0 : -Infinity}
      onCommit={(value) => setFace({ uv: boxToUv({ ...box, [key]: value }, data.uv) })}
      onScrub={(value) => live.scrub('cuboid.set_face', { ids, faces: [face], uv: boxToUv({ ...box, [key]: value }, data.uv) })}
      onScrubEnd={live.end}
    />
  );
  const textureOptions = [{ value: '', title: t.uv.noTexture }, ...Object.values(textures).map((tex) => ({ value: tex.id, title: tex.name }))];
  const cullOptions = [{ value: 'none', title: t.uv.noCullface }, ...cuboidFaces.map((f) => ({ value: f, title: t.faces[f] }))];
  const icon = (Icon: typeof Maximize2, title: string, onClick: () => void) => (
    <Tip label={title}>
      <button aria-label={title} className={`${smallButton} w-full`} onClick={onClick}>
        <Icon size={14} strokeWidth={1.75} />
      </button>
    </Tip>
  );

  return (
    <div className="flex flex-col gap-2.5 overflow-y-auto border-t border-line bg-panel p-2.5">
      <div className="grid grid-cols-4 gap-1">
        {boxField('x', 'X')}
        {boxField('y', 'Y')}
        {boxField('w', 'W')}
        {boxField('h', 'H')}
      </div>
      <div className="grid grid-cols-5 gap-1">
        {icon(Maximize2, t.uv.maximize, () => op('maximize'))}
        {icon(Wand2, t.uv.auto, () => op('auto'))}
        {icon(FlipHorizontal2, t.uv.mirrorX, () => op('mirror_x'))}
        {icon(FlipVertical2, t.uv.mirrorY, () => op('mirror_y'))}
        {icon(CopyCheck, t.uv.applyToAll, () => void dispatch('cuboid.uv', { ids, faces: cuboidFaces.filter((f) => f !== face), op: 'apply_to_all', source: face }))}
      </div>
      <Row title={t.uv.rotation}>
        <Segmented<number>
          label={t.uv.rotation}
          value={data.rotation}
          options={uvRotations.map((r) => ({ value: r, title: `${r}°` }))}
          onChange={(rotation) => setFace({ rotation: rotation as UvRotation })}
        />
      </Row>
      <Row title={t.uv.texture}>
        <PickMenu
          label={t.uv.texture}
          value={data.texture ?? ''}
          placeholder={t.uv.noTexture}
          options={textureOptions}
          onChange={(value) => setFace({ texture: value === '' ? null : value })}
        />
      </Row>
      <Row title={t.uv.enabled}>
        <Switch label={t.uv.enabled} checked={data.enabled} onChange={(enabled) => setFace({ enabled })} />
      </Row>
      <Row title={t.uv.tint}>
        <div className="flex items-center gap-2">
          <Switch label={t.uv.tint} checked={data.tintIndex !== null} onChange={(on) => setFace({ tintIndex: on ? 0 : null })} />
          {data.tintIndex !== null && (
            <div className="w-24">
              <ScrubField integer wide label={t.uv.tintIndex} ariaLabel={t.uv.tintIndex} color="var(--faint)" value={data.tintIndex} step={1} min={0} onCommit={(tintIndex) => setFace({ tintIndex })} />
            </div>
          )}
        </div>
      </Row>
      <Row title={t.uv.cullface}>
        <PickMenu<string>
          label={t.uv.cullface}
          value={data.cullface ?? 'none'}
          placeholder={t.uv.noCullface}
          options={cullOptions}
          onChange={(value) => setFace({ cullface: value === 'none' ? null : value })}
        />
      </Row>
    </div>
  );
}

/** The UV workspace of a Minecraft document: the active element's face on its texture. */
export function CuboidUvEditor() {
  const element = useElement();
  const face = useCuboidUv((s) => s.face);
  const size = useApp((s) => uvSize(selectDocState(s)));
  const t = useT().mc.uv;
  return (
    <section aria-label={t.editor} className="flex h-full min-w-0 flex-col bg-ink">
      {element ? (
        <>
          <div className="shrink-0 border-b border-line bg-panel p-1.5">
            <FaceTabs element={element} face={face} />
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <Canvas element={element} face={face} size={size} />
          </div>
          <FaceForm element={element} face={face} />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-5">
          <div className="flex max-w-[17rem] flex-col items-center text-center">
            <BoxIcon size={22} strokeWidth={1.25} className="text-faint" />
            <h2 className="mt-2.5 text-[calc(13.5px*var(--font-scale))] font-semibold text-text">{t.noElement}</h2>
            <p className="mt-1 text-[calc(12.5px*var(--font-scale))] leading-relaxed text-dim">{t.noElementHint}</p>
          </div>
        </div>
      )}
    </section>
  );
}

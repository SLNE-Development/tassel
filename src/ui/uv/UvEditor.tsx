import { Menu } from '@base-ui/react/menu';
import { Check, ChevronDown, Grid3x3, Image, Maximize, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { selectDocState, useApp } from '../../app/store';
import { useT } from '../../i18n';
import { getAction, runAction, shortcutLabel } from '../actions';
import { itemClass, MenuPopup } from '../menu';
import { Tip } from '../Tip';
import { uvGeometry } from './geometry';
import { UnwrapItems, uvIcons, uvTools } from './UvMenu';
import { useUvUi, uvBackgrounds, uvObject } from './uvStore';
import { UvView } from './UvView';

const iconButton =
  'flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-dim @[22.5rem]:w-7 hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50 data-[popup-open]:bg-raised data-[popup-open]:text-text';
const outlineButton =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2 text-[calc(12.5px*var(--font-scale))] text-text hover:border-accent hover:text-accent disabled:pointer-events-none disabled:text-faint/60 data-[popup-open]:border-accent data-[popup-open]:text-accent';

// On a narrow editor the tools move together so that they still fit on one row.
const Divider = () => <div aria-hidden className="mx-1 hidden h-4 w-px shrink-0 bg-line-strong @[22.5rem]:block" />;

function ToolButton({ id, disabled }: { id: string; disabled: boolean }) {
  const { title } = getAction(id);
  const Icon = uvIcons[id];
  return (
    <Tip label={title} shortcut={shortcutLabel(id)}>
      <button aria-label={title} disabled={disabled} className={iconButton} onClick={() => void runAction(id)}>
        <Icon size={16} strokeWidth={1.75} />
      </button>
    </Tip>
  );
}

function BackgroundMenu() {
  const background = useUvUi((s) => s.background);
  const t = useT();
  return (
    <Menu.Root>
      <Tip label={t.uv.background}>
        <Menu.Trigger aria-label={`${t.uv.background}: ${t.uv.backgrounds[background]}`} className={`${iconButton} w-auto! gap-0.5 px-1.5`}>
          <Image size={16} strokeWidth={1.75} />
          <ChevronDown size={12} className="opacity-60" />
        </Menu.Trigger>
      </Tip>
      <MenuPopup>
        <Menu.RadioGroup value={background}>
          {uvBackgrounds.map((value) => (
            <Menu.RadioItem key={value} className={itemClass} value={value} closeOnClick onClick={() => useUvUi.setState({ background: value })}>
              <span className="flex w-4 shrink-0 justify-center">
                <Menu.RadioItemIndicator>
                  <Check size={14} strokeWidth={2.25} />
                </Menu.RadioItemIndicator>
              </span>
              <span>{t.uv.backgrounds[value]}</span>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </MenuPopup>
    </Menu.Root>
  );
}

function Toolbar({ hasObject, hasUvs }: { hasObject: boolean; hasUvs: boolean }) {
  const t = useT();
  return (
    <div role="toolbar" aria-label={t.uv.tools} className="@container flex shrink-0 flex-wrap items-center gap-y-1 border-b border-line bg-panel px-1.5 py-1">
      <Menu.Root>
        <Tip label={t.uv.unwrap} shortcut={shortcutLabel('uv.unwrap_menu')}>
          <Menu.Trigger aria-label={t.uv.unwrap} disabled={!hasObject} className={`${outlineButton} mr-1`}>
            <Grid3x3 size={15} strokeWidth={1.75} />
            <span className="hidden @[26rem]:inline">{t.uv.unwrap}</span>
            <ChevronDown size={12} className="opacity-60" />
          </Menu.Trigger>
        </Tip>
        <MenuPopup>
          <UnwrapItems />
        </MenuPopup>
      </Menu.Root>
      <ToolButton id="uv.pack" disabled={!hasUvs} />
      <Divider />
      {uvTools.slice(1).map((id) => (
        <ToolButton key={id} id={id} disabled={!hasUvs} />
      ))}
      <Divider />
      <BackgroundMenu />
      <Tip label={t.uv.fit} shortcut={shortcutLabel('uv.fit')}>
        <button aria-label={t.uv.fit} className={iconButton} onClick={() => void runAction('uv.fit')}>
          <Maximize size={16} strokeWidth={1.75} />
        </button>
      </Tip>
      <div className="flex-1" />
      <ToolButton id="uv.clear" disabled={!hasUvs} />
    </div>
  );
}

function Canvas({ label }: { label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const view = new UvView(canvas.current!);
    return () => view.dispose();
  }, []);
  return <canvas ref={canvas} role="img" aria-label={label} className="absolute inset-0 block h-full w-full touch-none" />;
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-5">
      <div className="pointer-events-auto flex max-w-[17rem] flex-col items-center rounded-xl border border-line bg-panel/90 px-5 py-4 text-center backdrop-blur-sm">
        {icon}
        <h2 className="mt-2.5 text-[calc(13.5px*var(--font-scale))] font-semibold text-text">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const hint = 'mt-1 text-[calc(12.5px*var(--font-scale))] leading-relaxed text-dim';

function Status({ charts, coverage, dropped, hasObject }: { charts: number | null; coverage: number; dropped: boolean; hasObject: boolean }) {
  const selected = useApp((s) => selectDocState(s).edit?.faces.length);
  const faceMode = useApp((s) => selectDocState(s).edit?.elementMode === 'face');
  const total = useApp((s) => uvObject(selectDocState(s))?.mesh.faces.length ?? 0);
  const t = useT();
  return (
    <footer className="flex h-6.5 shrink-0 items-center gap-3 border-t border-line bg-panel pr-2 pl-3 text-[calc(12px*var(--font-scale))] whitespace-nowrap text-dim">
      {charts !== null ? (
        <>
          <span className="tnum shrink-0">{t.uv.charts(charts)}</span>
          <span className="tnum shrink-0">{t.uv.coverage(Math.round(coverage * 100))}</span>
          <span className="tnum min-w-0 truncate text-faint">{faceMode ? t.status.elementsSelected(selected ?? 0, total, 'face') : selected === undefined ? t.uv.clickToEdit : ''}</span>
        </>
      ) : (
        hasObject && (
          <Tip label={dropped ? t.uv.droppedTip : t.uv.noUvsHint} side="top">
            <span className="flex h-4.5 min-w-0 items-center gap-1.5 rounded-full bg-danger/12 px-2 text-danger">
              <TriangleAlert size={12} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{dropped ? t.uv.dropped : t.uv.noUvsChip}</span>
            </span>
          </Tip>
        )
      )}
    </footer>
  );
}

/** The UV editor: the active object's texture coordinates in 2D, with the UV tools. */
export function UvEditor() {
  const object = useApp((s) => uvObject(selectDocState(s)));
  const dropped = useUvUi((s) => (object ? object.id in s.dropped : false));
  const t = useT();
  const mesh = object?.mesh;
  const geometry = useMemo(() => (mesh ? uvGeometry(mesh) : null), [mesh]);
  const hasUvs = geometry !== null;
  return (
    <section aria-label={t.uv.editor} className="flex h-full min-w-0 flex-col bg-ink">
      <Toolbar hasObject={object !== undefined} hasUvs={hasUvs} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Canvas label={object ? t.uv.canvasLabel(object.name) : t.uv.editor} />
        {!object && (
          <Empty icon={<Grid3x3 size={22} strokeWidth={1.25} className="text-faint" />} title={t.uv.noObject}>
            <p className={hint}>{t.uv.noObjectHint}</p>
          </Empty>
        )}
        {object && !hasUvs && (
          <Empty icon={<Grid3x3 size={22} strokeWidth={1.25} className="text-faint" />} title={dropped ? t.uv.lostUvs(object.name) : t.uv.noUvs(object.name)}>
            <p className={hint}>{dropped ? t.uv.droppedTip : t.uv.noUvsHint}</p>
            <button
              className="mt-3 h-8 rounded-md bg-accent px-3.5 text-[calc(13px*var(--font-scale))] font-medium text-accent-ink hover:brightness-110"
              onClick={() => void runAction('uv.unwrap_smart')}
            >
              {t.uv.unwrap}
            </button>
            <p className="mt-2 text-[calc(12px*var(--font-scale))] leading-relaxed text-faint">{t.uv.unwrapHint}</p>
          </Empty>
        )}
      </div>
      <Status charts={geometry ? geometry.charts.length : null} coverage={geometry?.coverage ?? 0} dropped={dropped} hasObject={object !== undefined} />
    </section>
  );
}

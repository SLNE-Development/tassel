import { Blend, Brush, Copy, Eraser, Move, PaintBucket, Pipette, Shapes, SquareDashed, type LucideIcon } from 'lucide-react';
import { useT } from '../../i18n';
import { formatCombo } from '../actions';
import { Tip } from '../Tip';
import { pixelTools, usePixel, type PixelTool } from './pixelStore';

const toolIcons: Record<PixelTool, LucideIcon> = {
  brush: Brush,
  eraser: Eraser,
  fill: PaintBucket,
  shape: Shapes,
  gradient: Blend,
  select: SquareDashed,
  move: Move,
  copy: Copy,
  picker: Pipette,
};

/** Shortcut hints shown in the tooltips; the actions in pixelActions.ts own the real bindings. */
const toolKeys: Record<PixelTool, string> = { brush: 'B', eraser: 'E', fill: 'G', shape: 'U', gradient: 'Shift+G', select: 'M', move: 'V', copy: 'C', picker: 'I' };

const buttonClass = (active: boolean) =>
  `rail-button relative flex shrink-0 items-center justify-center rounded-md ${active ? 'bg-raised text-accent' : 'text-dim hover:bg-raised hover:text-text'}`;

/** The tool rail of the pixel paint workspace. */
export function PixelRail() {
  const tool = usePixel((s) => s.tool);
  const t = useT().pixel.panel;
  return (
    <div role="radiogroup" aria-label={t.tools} className="rail-group flex flex-col">
      {pixelTools.map((id) => {
        const title = t.toolNames[id];
        const Icon = toolIcons[id];
        const active = id === tool;
        const keys = id === 'picker' ? `${formatCombo(toolKeys[id])} / ${formatCombo('Alt')}` : formatCombo(toolKeys[id]);
        return (
          <Tip key={id} label={title} shortcut={keys} side="right">
            <button role="radio" aria-checked={active} aria-label={title} className={buttonClass(active)} onClick={() => usePixel.setState({ tool: id })}>
              {active && <span aria-hidden className="absolute top-1.5 bottom-1.5 -left-1.5 w-0.5 rounded-full bg-accent" />}
              <Icon size={17} strokeWidth={1.75} />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

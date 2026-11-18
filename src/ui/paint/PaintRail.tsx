import { Brush, Eraser, PaintBucket, Pipette, type LucideIcon } from 'lucide-react';
import { useT } from '../../i18n';
import { runAction, shortcutLabel } from '../actions';
import { Tip } from '../Tip';
import { paintTools, usePaint, type PaintTool } from './paintStore';

const toolIcons: Record<PaintTool, LucideIcon> = { brush: Brush, eraser: Eraser, picker: Pipette };

const buttonClass = (active: boolean) =>
  `rail-button relative flex shrink-0 items-center justify-center rounded-md ${active ? 'bg-raised text-accent' : 'text-dim hover:bg-raised hover:text-text'}`;

/** The tool rail of the paint workspace: the brush tools, and filling the active layer. */
export function PaintRail() {
  const tool = usePaint((s) => s.tool);
  const t = useT();
  return (
    <>
      <div role="radiogroup" aria-label={t.paint.tools} className="rail-group flex flex-col">
        {paintTools.map((id) => {
          const title = t.paint.toolNames[id];
          const Icon = toolIcons[id];
          const active = id === tool;
          return (
            <Tip key={id} label={title} shortcut={shortcutLabel(`paint.tool_${id}`)} side="right">
              <button role="radio" aria-checked={active} aria-label={title} className={buttonClass(active)} onClick={() => void runAction(`paint.tool_${id}`)}>
                {active && <span aria-hidden className="absolute top-1.5 bottom-1.5 -left-1.5 w-0.5 rounded-full bg-accent" />}
                <Icon size={17} strokeWidth={1.75} />
              </button>
            </Tip>
          );
        })}
      </div>
      <div aria-hidden className="h-px w-5 shrink-0 bg-line-strong" />
      <Tip label={t.paint.fill} shortcut={shortcutLabel('paint.fill')} side="right">
        <button aria-label={t.paint.fill} className={buttonClass(false)} onClick={() => void runAction('paint.fill')}>
          <PaintBucket size={16} strokeWidth={1.75} />
        </button>
      </Tip>
    </>
  );
}

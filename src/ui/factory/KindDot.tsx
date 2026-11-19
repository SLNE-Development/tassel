import type { FactoryPort } from '../../core/types';
import { FACTORY_COLORS } from '../../viewport/theme';

/** The kind of a port as a colour dot, the colour its marker has in the viewport (a port without a face is yellow there). */
export function KindDot({ port }: { port: Pick<FactoryPort, 'kind' | 'face'> }) {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: FACTORY_COLORS[port.face ? port.kind : 'unset'] }} />;
}

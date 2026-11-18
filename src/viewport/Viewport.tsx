import { useEffect, useRef } from 'react';
import { services } from '../app/store';
import { ViewportEngine } from './engine';
import { VIEWPORT_COLORS } from './theme';

/** The 3D viewport of the active document. Fills its parent. */
export function Viewport() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const engine = new ViewportEngine(container.current);
    services.viewport = engine.service;
    return () => {
      if (services.viewport === engine.service) services.viewport = null;
      engine.dispose();
    };
  }, []);

  return (
    <div
      ref={container}
      className="h-full w-full"
      style={{ width: '100%', height: '100%', overflow: 'hidden', background: VIEWPORT_COLORS.background }}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}

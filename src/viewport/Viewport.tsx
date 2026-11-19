import { useEffect, useRef } from 'react';
import { services } from '../app/store';
import { cuboidFaces } from '../core/types';
import { addLibraryTexture, droppedTexture, isTextureDrag } from '../ui/library/libraryUi';
import { ViewportEngine } from './engine';

/** The 3D viewport of the active document. Fills its parent. */
export function Viewport() {
  const container = useRef<HTMLDivElement>(null);
  const engine = useRef<ViewportEngine | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const created = new ViewportEngine(container.current);
    engine.current = created;
    services.viewport = created.service;
    return () => {
      if (services.viewport === created.service) services.viewport = null;
      engine.current = null;
      created.dispose();
    };
  }, []);

  return (
    <div
      ref={container}
      className="h-full w-full"
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
      onContextMenu={(event) => event.preventDefault()}
      // A texture dragged from the library onto an object: a cuboid face gets it (Minecraft), any other
      // object gets it as its material's base colour (free documents); dropped on nothing it is just added.
      onDragOver={(event) => {
        if (!isTextureDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'link';
      }}
      onDrop={(event) => {
        const dragged = droppedTexture(event);
        if (!dragged) return;
        event.preventDefault();
        const hit = engine.current?.pickFace(event.clientX, event.clientY) ?? null;
        void addLibraryTexture(
          dragged,
          hit ? { objects: [hit.id], ...(hit.face !== null ? { faces: [cuboidFaces[hit.face]] } : {}) } : {},
        );
      }}
    />
  );
}

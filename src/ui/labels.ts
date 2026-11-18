import {
  Box,
  Brush,
  Circle,
  CircleDot,
  Cone,
  Cylinder,
  Globe,
  Grid3x3,
  Hexagon,
  MousePointer2,
  Move3d,
  Rotate3d,
  Scale3d,
  Shapes,
  Square,
  Torus,
  type LucideIcon,
} from 'lucide-react';
import type { PrimitiveType } from '../core/mesh/primitives';
import type { Shading, Tool, ViewPreset, Workspace } from '../core/types';

interface Label {
  title: string;
  icon: LucideIcon;
}

export const primitiveLabels: Record<PrimitiveType, Label> = {
  cube: { title: 'Würfel', icon: Box },
  plane: { title: 'Ebene', icon: Square },
  uv_sphere: { title: 'Kugel', icon: Globe },
  ico_sphere: { title: 'Ikosphäre', icon: Hexagon },
  cylinder: { title: 'Zylinder', icon: Cylinder },
  cone: { title: 'Kegel', icon: Cone },
  torus: { title: 'Torus', icon: Torus },
};

export const toolLabels: Record<Tool, Label> = {
  select: { title: 'Auswählen', icon: MousePointer2 },
  move: { title: 'Verschieben', icon: Move3d },
  rotate: { title: 'Drehen', icon: Rotate3d },
  scale: { title: 'Skalieren', icon: Scale3d },
};

export const shadingLabels: Record<Shading, Label> = {
  solid: { title: 'Solide', icon: Circle },
  wireframe: { title: 'Drahtgitter', icon: Globe },
  material: { title: 'Material', icon: CircleDot },
};

export const workspaceLabels: Record<Workspace, Label> = {
  modeling: { title: 'Modellieren', icon: Shapes },
  uv: { title: 'UV', icon: Grid3x3 },
  paint: { title: 'Malen', icon: Brush },
};

export const viewLabels: Record<ViewPreset, string> = {
  front: 'Vorne',
  back: 'Hinten',
  left: 'Links',
  right: 'Rechts',
  top: 'Oben',
  bottom: 'Unten',
  iso: 'Isometrisch',
};

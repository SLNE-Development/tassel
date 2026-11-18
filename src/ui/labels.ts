import {
  ArrowUpFromLine,
  Box,
  CopyPlus,
  FlipHorizontal2,
  FlipVertical2,
  Grid2x2,
  Merge,
  PaintBucket,
  SquareRoundCorner,
  SquareSplitHorizontal,
  SquareSquare,
  SquaresSubtract,
  Trash2,
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
import type { BooleanOperation, ElementMode, ModifierType, Shading, Tool, ViewPreset, Workspace } from '../core/types';

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

/** `of(n)` is the noun after "von n": "3 von 8 Eckpunkten". */
export const elementLabels: Record<ElementMode, { title: string; of(count: number): string }> = {
  vertex: { title: 'Eckpunkte', of: (n) => (n === 1 ? 'Eckpunkt' : 'Eckpunkten') },
  edge: { title: 'Kanten', of: (n) => (n === 1 ? 'Kante' : 'Kanten') },
  face: { title: 'Flächen', of: (n) => (n === 1 ? 'Fläche' : 'Flächen') },
};

/** Icons of the edit-mode tools, by action id. */
export const meshToolIcons: Record<string, LucideIcon> = {
  'mesh.extrude': ArrowUpFromLine,
  'mesh.inset': SquareSquare,
  'mesh.bevel': SquareRoundCorner,
  'mesh.loop_cut': SquareSplitHorizontal,
  'mesh.subdivide': Grid2x2,
  'mesh.merge_menu': Merge,
  'mesh.fill': PaintBucket,
  'mesh.flip_normals': FlipVertical2,
  'mesh.delete': Trash2,
};

export const modifierLabels: Record<ModifierType, Label> = {
  mirror: { title: 'Spiegeln', icon: FlipHorizontal2 },
  subdivision: { title: 'Unterteilung', icon: Grid2x2 },
  array: { title: 'Reihe', icon: CopyPlus },
  boolean: { title: 'Boolesch', icon: SquaresSubtract },
};

export const booleanLabels: Record<BooleanOperation, string> = {
  union: 'Vereinigung',
  difference: 'Differenz',
  intersect: 'Schnitt',
};

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
  Frame,
  Globe,
  Grid3x3,
  Hexagon,
  MousePointer2,
  Rainbow,
  Move3d,
  Rotate3d,
  Scale3d,
  Shapes,
  Square,
  Torus,
  type LucideIcon,
} from 'lucide-react';
import type { PrimitiveType } from '../core/mesh/primitives';
import type { ModifierType, Shading, Tool, Workspace } from '../core/types';

/** Icons of everything the UI names. The names themselves are in the dictionaries (`src/i18n`). */

export const primitiveIcons: Record<PrimitiveType, LucideIcon> = {
  cube: Box,
  plane: Square,
  uv_sphere: Globe,
  ico_sphere: Hexagon,
  cylinder: Cylinder,
  cone: Cone,
  torus: Torus,
  arc: Rainbow,
};

export const toolIcons: Record<Tool, LucideIcon> = {
  select: MousePointer2,
  move: Move3d,
  rotate: Rotate3d,
  scale: Scale3d,
};

export const shadingIcons: Record<Shading, LucideIcon> = {
  solid: Circle,
  wireframe: Globe,
  material: CircleDot,
};

export const workspaceIcons: Record<Workspace, LucideIcon> = {
  modeling: Shapes,
  uv: Grid3x3,
  paint: Brush,
  display: Frame,
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

export const modifierIcons: Record<ModifierType, LucideIcon> = {
  mirror: FlipHorizontal2,
  subdivision: Grid2x2,
  array: CopyPlus,
  boolean: SquaresSubtract,
};

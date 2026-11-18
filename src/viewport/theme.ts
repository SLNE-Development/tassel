/** The single accent colour of the viewport (selection highlight). The UI palette should align with it. */
export const ACCENT_COLOR = '#e9b949';
/** Brighter tint of the accent, used for the active object. */
export const ACCENT_ACTIVE_COLOR = '#ffe9ad';

export const VIEWPORT_COLORS = {
  background: '#14181a',
  gridMinor: '#20262a',
  gridMajor: '#2e363a',
  axisX: '#a8474f',
  axisZ: '#3f6db3',
  clay: '#b9b5ae',
  wire: '#8e9896',
  /** Other objects while one is being edited. */
  clayDim: '#4b4e4d',
  wireDim: '#3d4443',
  /** Edges and unselected vertices of the edited object on its clay surface. */
  editEdge: '#2c3336',
  editVertex: '#0d1011',
  editVertexRim: '#e6eaeb',
} as const;

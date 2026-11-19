/** Colours of the 3D viewport for one UI theme. Selection and edit highlights use the accent colour of the preferences. */
export interface ViewportPalette {
  background: string;
  gridMinor: string;
  gridMajor: string;
  axisX: string;
  axisZ: string;
  clay: string;
  wire: string;
  /** Other objects while one is being edited. */
  clayDim: string;
  wireDim: string;
  /** Edges and unselected vertices of the edited object on its clay surface. */
  editEdge: string;
  editVertex: string;
  editVertexRim: string;
  /** Captions of screenshot sheets, on `background`. */
  caption: string;
}

export const VIEWPORT_PALETTES: Record<'dark' | 'light', ViewportPalette> = {
  dark: {
    background: '#14181a',
    gridMinor: '#20262a',
    gridMajor: '#2e363a',
    axisX: '#a8474f',
    axisZ: '#3f6db3',
    clay: '#b9b5ae',
    wire: '#8e9896',
    clayDim: '#4b4e4d',
    wireDim: '#3d4443',
    editEdge: '#2c3336',
    editVertex: '#0d1011',
    editVertexRim: '#e6eaeb',
    caption: '#dfe4e5',
  },
  // A stage a little deeper than the paper-grey panels, so the pale clay stands out against it.
  light: {
    background: '#cdccc3',
    gridMinor: '#c1c0b6',
    gridMajor: '#adaca1',
    axisX: '#c9544a',
    axisZ: '#3d76c4',
    clay: '#dcd8cf',
    wire: '#4f5859',
    clayDim: '#bab9b0',
    wireDim: '#a9a89e',
    editEdge: '#3a4245',
    editVertex: '#14181a',
    editVertexRim: '#fbfaf6',
    caption: '#1f2628',
  },
};

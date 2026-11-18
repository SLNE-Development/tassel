import { create } from 'zustand';
import type { Drop, Payload, RowRef } from './outlinerTree';

/** Transient state of the outliner. None of it belongs to the document. */
export interface OutlinerState {
  /** Collapsed groups by id. */
  collapsed: Readonly<Record<string, boolean>>;
  /**
   * A drag in progress. `drop` is what releasing would do (null: nothing), `valid` is false where
   * dropping is not allowed, `line` places the insertion line (layout pixels inside the list).
   */
  drag: {
    payload: Payload;
    /** Ids of the dragged rows. */
    dragged: ReadonlySet<string>;
    label: string;
    /** Pointer position in CSS pixels. */
    x: number;
    y: number;
    drop: Drop | null;
    valid: boolean;
    line: { top: number; left: number } | null;
  } | null;
  /** The row the open context menu belongs to; null on the empty area. */
  menuTarget: RowRef | null;
  /** Group waiting for the "delete with its objects" confirmation. */
  deleteGroupId: string | null;
}

export const useOutliner = create<OutlinerState>(() => ({
  collapsed: {},
  drag: null,
  menuTarget: null,
  deleteGroupId: null,
}));

export function setCollapsed(id: string, collapsed: boolean): void {
  useOutliner.setState((s) => {
    if (Boolean(s.collapsed[id]) === collapsed) return s;
    const next = { ...s.collapsed };
    if (collapsed) next[id] = true;
    else delete next[id];
    return { collapsed: next };
  });
}

import type { Op } from './model';

export interface HistoryEntry {
  label: string;
  undo: Op[];
  redo: Op[];
  cost: number;
}

/** Per-person undo stack. Undoing applies ops like any edit, so it reaches the room. */
export class History {
  private done: HistoryEntry[] = [];
  private undone: HistoryEntry[] = [];
  onChange: () => void = () => {};

  constructor(private maxEntries = 120, private maxCost = 700) {}

  record(e: HistoryEntry) {
    this.done.push(e);
    this.undone = [];
    this.trim();
    this.onChange();
  }

  takeUndo() { return this.done.pop(); }
  takeRedo() { return this.undone.pop(); }
  putUndone(e: HistoryEntry) { this.undone.push(e); this.onChange(); }
  putDone(e: HistoryEntry) { this.done.push(e); this.trim(); this.onChange(); }

  private trim() {
    let cost = this.done.reduce((s, x) => s + x.cost, 0) + this.undone.reduce((s, x) => s + x.cost, 0);
    while (this.done.length > 1 && (this.done.length > this.maxEntries || cost > this.maxCost)) {
      cost -= this.done.shift()!.cost;
    }
  }

  clear() { this.done = []; this.undone = []; this.onChange(); }
  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
}

export interface HistoryEntry {
  label: string;
  undo(): void;
  redo(): void;
  /** Approximate memory cost in tiles, used to cap history size. */
  cost: number;
}

/** Local undo/redo stack. Kept separate from the Op log so collaboration can add per-user undo later. */
export class History {
  private done: HistoryEntry[] = [];
  private undone: HistoryEntry[] = [];
  onChange: () => void = () => {};

  constructor(private maxEntries = 120, private maxCost = 700) {}

  push(e: HistoryEntry) {
    this.done.push(e);
    this.undone = [];
    let cost = this.done.reduce((s, x) => s + x.cost, 0);
    while (this.done.length > 1 && (this.done.length > this.maxEntries || cost > this.maxCost)) {
      cost -= this.done.shift()!.cost;
    }
    this.onChange();
  }

  undo() {
    const e = this.done.pop();
    if (!e) return false;
    e.undo();
    this.undone.push(e);
    this.onChange();
    return true;
  }

  redo() {
    const e = this.undone.pop();
    if (!e) return false;
    e.redo();
    this.done.push(e);
    this.onChange();
    return true;
  }

  clear() { this.done = []; this.undone = []; this.onChange(); }
  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
}

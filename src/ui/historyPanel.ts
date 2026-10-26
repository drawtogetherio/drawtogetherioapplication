import type { HistoryEntry } from '../core/history';
import type { Editor } from '../editor';
import { h } from './dom';
import { OP_LABEL } from './opLabels';

const label = (e: HistoryEntry) => (OP_LABEL as Record<string, string>)[e.label] ?? e.label;

/** Every undoable edit in order; clicking one jumps the canvas to just after it. */
export class HistoryPanel {
  private list = h('div.history-list');
  readonly el = h('div.panel.history-panel', {}, h('div.panel-head', {}, h('span.panel-title', {}, 'History')), this.list);
  open = false;

  constructor(private ed: Editor) {
    ed.on((w) => { if ((w === 'history' || w === 'doc') && this.open) this.render(); });
  }

  render() {
    const { done, undone } = this.ed.doc.history;
    const row = (text: string, state: 'done' | 'undone' | 'now', go: () => void) =>
      h('button.history-row', { type: 'button', 'data-state': state, onclick: go }, text);
    const rows = [row('Start', done.length ? 'done' : 'now', () => this.jump(null))];
    done.forEach((e, i) => rows.push(row(label(e), i === done.length - 1 ? 'now' : 'done', () => this.jump(e))));
    for (let i = undone.length - 1; i >= 0; i--) rows.push(row(label(undone[i]), 'undone', () => this.jump(undone[i])));
    this.list.replaceChildren(...rows);
    this.list.querySelector('[data-state="now"]')?.scrollIntoView({ block: 'nearest' });
  }

  /** Undo or redo until `e` is the latest edit done (`null`: before everything in history). */
  private jump(e: HistoryEntry | null) {
    const ed = this.ed, hist = ed.doc.history;
    ed.commitPending();
    if (e === null || hist.done.includes(e)) { for (let n = 0; hist.done.at(-1) !== e && hist.canUndo && n < 500; n++) ed.undo(); }
    else { for (let n = 0; hist.done.at(-1) !== e && hist.canRedo && n < 500; n++) ed.redo(); }
  }
}

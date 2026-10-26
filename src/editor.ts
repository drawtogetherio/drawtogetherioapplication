import { DrawDoc, Layer, newFolderProps, newLayerProps, opsCost, wireOps } from './core/document';
import { Point, Rect, selPath, uid } from './core/geom';
import { BrushParams, Op, Selection, ShapeKind } from './core/model';
import { BrushPreset, DEFAULT_BRUSH, DEFAULT_ERASER, DEFAULT_SMUDGE, SMUDGE_PARAMS, brushById } from './engine/brush';
import { CanvasView } from './view/canvasView';
import type { Tool } from './tools/tool';
import type { RoomClient } from './net/roomClient';
import type { MyProfile } from './shared/profile';
import { userFolderId } from './shared/protocol';
import type { ApplyOptions } from './core/document';
import type { HistoryEntry } from './core/history';
import type { TiledSurface } from './core/tiles';
import { Prefs, cleanPrefs } from './shared/prefs';

export type ToolId = 'brush' | 'eraser' | 'smudge' | 'fill' | 'select' | 'shape' | 'eyedropper';
export type FillMode = 'bucket' | 'lasso';
export type SelectMode = 'rect' | 'ellipse' | 'lasso' | 'wand';

export interface EditorSettings {
  brush: BrushParams;
  brushPreset: string;
  eraser: BrushParams;
  eraserPreset: string;
  smudge: BrushParams;
  smudgePreset: string;
  fillTolerance: number; // 0..1
  fillSampleAll: boolean;
  fillExpand: number;
  fillMode: FillMode;
  /** Fill lasso: only the parts closed off by lines. */
  lassoInside: boolean;
  selectMode: SelectMode;
  shape: ShapeKind;
  shapeFill: boolean;
  hideOthersFolders: boolean; // layers panel shows only your own folder
}

type Listener = (what: string) => void;

/** Rotation and flips of the view. */
export interface ViewTurn { rot: number; flipX: number; flipY: number }

/** The last pointer sample as the device reported it (raw pressure, tilt in degrees, lean), for the pen test and tilt brushes. */
export interface PenState { type: 'pen' | 'mouse' | 'touch'; pressure: number; tiltX: number; tiltY: number; altitude: number; azimuth: number; at: number }

/** Per-user state around a document: tool, layer, colour, selection, room. */
export class Editor {
  doc: DrawDoc;
  readonly view: CanvasView;
  tools = {} as Record<ToolId, Tool>;
  toolId: ToolId = 'brush';
  activeLayer = '';
  color = '#1b1b1f';
  recentColors: string[] = [];
  selection: Selection | null = null;
  /** Edits go to the active layer's mask instead of its pixels. */
  maskEdit = false;
  hover: (Point & { pointer: string }) | null = null;
  me: MyProfile | null = null;
  targetFolder: string | null = null;
  room: RoomClient | null = null;
  /** Every op this person commits, for the copy kept on the device. */
  onOp: ((op: Op) => void) | null = null;
  pen: PenState | null = null;
  prefs: Prefs = cleanPrefs({});
  settings: EditorSettings = {
    brush: { ...brushById(DEFAULT_BRUSH).params }, brushPreset: DEFAULT_BRUSH,
    eraser: { ...brushById(DEFAULT_ERASER).params }, eraserPreset: DEFAULT_ERASER,
    smudge: { ...SMUDGE_PARAMS }, smudgePreset: DEFAULT_SMUDGE,
    fillTolerance: 0.12, fillSampleAll: true, fillExpand: 1, fillMode: 'bucket', lassoInside: true,
    selectMode: 'rect', shape: 'rect', shapeFill: false,
    hideOthersFolders: false,
  };
  private listeners = new Set<Listener>();
  private unsubDoc: () => void = () => {};

  constructor(doc: DrawDoc, stage: HTMLElement) {
    this.doc = doc;
    this.view = new CanvasView(doc, stage);
    this.pickActiveLayer();
    this.bindDoc();
  }

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what: string) { for (const fn of this.listeners) fn(what); }

  private bindDoc() {
    this.unsubDoc();
    this.unsubDoc = this.doc.on((c) => {
      this.view.invalidate(c.rect);
      if (!this.doc.layer(this.activeLayer)) this.pickActiveLayer();
      if (c.structure) this.emit('layers');
      else if (c.pixels) this.emit('pixels:' + c.pixels);
    });
    this.doc.history.onChange = () => this.emit('history');
  }

  pickActiveLayer() {
    const mine = [...this.doc.layers].reverse().find((l) => this.canEdit(l.props.id));
    this.activeLayer = mine?.props.id ?? '';
  }

  setDoc(doc: DrawDoc, keepView = false) {
    this.currentTool?.cancel();
    this.selection = null;
    this.view.live = null;
    this.view.remoteLive.clear();
    this.doc = doc;
    this.view.setDoc(doc);
    this.pickActiveLayer();
    this.bindDoc();
    if (!keepView) this.fitView();
    this.emit('doc');
    this.emit('layers');
    this.emit('history');
  }

  get currentTool() { return this.tools[this.toolId]; }

  /** One of your brushes or a library one; unknown ids fall back to the first library brush. */
  preset(id: string): BrushPreset { return this.prefs.customBrushes.find((b) => b.id === id) ?? brushById(id); }

  setTool(id: ToolId) {
    if (id === this.toolId) return;
    this.currentTool.deactivate?.();
    this.toolId = id;
    this.currentTool.activate?.();
    this.emit('tool');
    this.view.requestRender();
  }

  get sizeParams(): BrushParams {
    const s = this.settings;
    return this.toolId === 'eraser' ? s.eraser : this.toolId === 'smudge' ? s.smudge : s.brush;
  }

  setColor(c: string, commitRecent = false) {
    this.color = c;
    if (commitRecent) this.pushRecent(c);
    this.emit('color');
  }

  pushRecent(c: string) {
    this.recentColors = [c, ...this.recentColors.filter((x) => x !== c)].slice(0, 12);
  }

  get layer(): Layer | undefined { return this.doc.layer(this.activeLayer); }

  setActiveLayer(id: string, mask = false) {
    this.commitPending();
    this.activeLayer = id;
    this.maskEdit = mask;
    this.targetFolder = null;
    this.emit('layers');
  }

  /** True while the active layer's mask is being edited; the flag pixel ops carry. */
  get onMask(): true | undefined { return this.maskEdit && !!this.layer?.mask ? true : undefined; }

  /** The pixels the current edit lands on. */
  editSurface(layer: Layer): TiledSurface { return this.maskEdit && layer.mask ? layer.mask : layer.surface; }

  setMask(on: boolean) {
    this.commitPending();
    const l = this.layer;
    if (!l || !this.canEdit(l.props.id) || !!l.mask === on) return;
    this.run([{ t: 'layer.props', id: uid(), layer: l.props.id, props: { mask: on } }], on ? 'Add mask' : 'Delete mask');
    this.maskEdit = on;
    this.emit('layers');
  }

  applyMask() {
    this.commitPending();
    const l = this.layer;
    if (!l?.mask || !this.canEdit(l.props.id)) return;
    this.run([{ t: 'layer.mask.apply', id: uid(), layer: l.props.id }], 'Apply mask');
    this.maskEdit = false;
    this.emit('layers');
  }

  toggleClip() {
    this.commitPending();
    const l = this.layer;
    if (!l || !this.canEdit(l.props.id)) return;
    this.run([{ t: 'layer.props', id: uid(), layer: l.props.id, props: { clip: !l.props.clip } }], 'Clipping mask');
  }

  get readOnly() { return !!this.room?.spectator; }

  canEdit(nodeId: string): boolean {
    if (this.readOnly) return false;
    if (!this.room) return true;
    const n = this.doc.node(nodeId);
    if (!n) return false;
    return n.props.owner === this.room.you || this.room.isHost;
  }

  paintableLayer(): Layer | null {
    const l = this.layer;
    if (!l) { this.toast(this.room ? 'Add a layer in your folder to start drawing' : 'Add a layer to start drawing'); return null; }
    if (!this.canEdit(l.props.id)) { this.toast(`This layer belongs to ${this.ownerName(l.props.owner)}`); return null; }
    if (!l.shown) { this.toast('This layer is hidden'); return null; }
    return l;
  }

  ownerName(id?: string) { return (id && this.room?.member(id)?.displayName) || 'someone else'; }

  insertionPoint(): { parent: string | null; index: number } {
    const tf = this.targetFolder && this.doc.folder(this.targetFolder);
    if (tf && this.canEdit(tf.props.id)) return { parent: tf.props.id, index: this.doc.children(tf.props.id).length };
    const l = this.layer;
    if (l && this.canEdit(l.props.id) && (!this.room || l.parent)) {
      const p = this.doc.place(l.props.id);
      return { parent: p.parent, index: p.index + 1 };
    }
    if (this.room) {
      const f = userFolderId(this.room.you);
      return { parent: f, index: this.doc.children(f).length };
    }
    return { parent: null, index: this.doc.children(null).length };
  }

  run(ops: Op[], label = 'Edit', opts: ApplyOptions = {}) {
    if (this.readOnly) return;
    const inverse: Op[] = [];
    const entry: HistoryEntry = { label, undo: inverse, redo: [], cost: 0 };
    ops.forEach((op, i) => {
      op.author = this.room?.you;
      const inv = this.doc.apply(op, i === 0 ? opts : {});
      if (!inv.length) return;
      this.share(op, inv, entry);
      inverse.unshift(...inv);
    });
    entry.cost = opsCost(inverse);
    if (inverse.length) this.doc.history.record(entry);
  }

  apply(op: Op, opts: ApplyOptions = {}) { this.run([op], op.t, opts); }

  private prepQueue: Promise<void> = Promise.resolve();

  /** Fills and effects: worked out in the worker from the canvas as it is now, then applied as one op, in the order asked. */
  applyPrepared(op: Op) {
    return this.prepQueue = this.prepQueue.then(async () => {
      const doc = this.doc, room = this.room;
      if (room) room.freeze = true;
      try {
        const opts = await doc.prepared(op);
        if (this.doc === doc) this.apply(op, opts);
      } finally { if (room) room.freeze = false; }
    });
  }

  /** Recent edits sent to the room with what undoes them, in case the room refuses one. */
  private sent = new Map<string, { inv: Op[]; entry: HistoryEntry }>();

  /** Send an op to the room and the device copy; undo's tile images are PNG-encoded once for both. */
  private share(op: Op, inv: Op[], entry: HistoryEntry) {
    if (!this.room && !this.onOp) return;
    for (const wire of wireOps(op)) {
      this.room?.sendOp(wire);
      this.onOp?.(wire);
      if (this.room) {
        this.sent.set(wire.id, { inv, entry });
        if (this.sent.size > 60) this.sent.delete(this.sent.keys().next().value!);
      }
    }
  }

  /** The room refused an edit: take it back here, without a reconnect. False when it's too late. */
  rollback(opId: string): boolean {
    const s = this.sent.get(opId);
    if (!s) return false;
    this.sent.delete(opId);
    for (const op of s.inv) this.doc.apply(op, { record: false });
    this.doc.history.drop(s.entry);
    return true;
  }

  private replay(ops: Op[], entry: HistoryEntry): Op[] {
    const inverse: Op[] = [];
    for (const op of ops) {
      const inv = this.doc.apply(op);
      if (!inv.length) continue;
      this.share(op, inv, entry);
      inverse.unshift(...inv);
    }
    return inverse;
  }

  undo() {
    if (this.readOnly) return;
    if (this.currentTool.busy?.()) { this.currentTool.cancel(); this.view.invalidate(null); return; }
    const e = this.doc.history.takeUndo();
    if (!e) return;
    this.room?.send({ type: 'count', what: 'undo' });
    e.redo = this.replay(e.undo, e);
    e.cost = opsCost(e.redo);
    this.doc.history.putUndone(e);
  }

  redo() {
    if (this.readOnly) return;
    this.commitPending();
    const e = this.doc.history.takeRedo();
    if (!e) return;
    this.room?.send({ type: 'count', what: 'redo' });
    e.undo = this.replay(e.redo, e);
    e.cost = opsCost(e.undo);
    this.doc.history.putDone(e);
  }

  addLayer() {
    this.commitPending();
    const { parent, index } = this.insertionPoint();
    if (parent && !this.canEdit(parent)) return;
    const n = this.doc.layers.filter((l) => !this.room || l.props.owner === this.room.you).length + 1;
    const props = newLayerProps(`Layer ${n}`, this.room?.you);
    this.run([{ t: 'layer.add', id: uid(), parent, index, layer: props }], 'Add layer');
    this.setActiveLayer(props.id);
  }

  addFolder() {
    this.commitPending();
    const { parent, index } = this.insertionPoint();
    const n = [...this.doc.nodes.values()].filter((x) => x.kind === 'folder' && !x.props.user).length + 1;
    this.run([{ t: 'folder.add', id: uid(), parent, index, folder: newFolderProps(`Folder ${n}`, this.room?.you) }], 'Add folder');
  }

  duplicateLayer() {
    this.commitPending();
    const src = this.layer;
    if (!src) return;
    const { parent, index } = this.insertionPoint();
    const props = { ...src.props, id: uid('ly_'), name: src.props.name + ' copy', owner: this.room?.you };
    this.run([{ t: 'layer.add', id: uid(), parent, index, layer: props, copyOf: src.props.id }], 'Duplicate layer');
    this.setActiveLayer(props.id);
  }

  ensureOwnLayer() {
    if (!this.room || this.readOnly) return;
    const mine = this.doc.layers.find((l) => l.props.owner === this.room!.you);
    if (mine) { if (!this.canEdit(this.activeLayer)) this.setActiveLayer(mine.props.id); return; }
    const f = userFolderId(this.room.you);
    if (!this.doc.folder(f)) return;
    const props = newLayerProps('Layer 1', this.room.you);
    this.run([{ t: 'layer.add', id: uid(), parent: f, index: 0, layer: props }], 'Add layer');
    this.doc.history.clear();
    this.setActiveLayer(props.id);
  }

  commitPending() { this.currentTool?.commit?.(); }

  clipPath(): Path2D | undefined { return this.selection ? selPath(this.selection) : undefined; }

  workArea(): Rect {
    const s = this.doc.settings;
    if (!s.infinite) return { x: 0, y: 0, w: s.width, h: s.height };
    const vp = this.view.viewport;
    const a = vp.toDoc(0, 0), b = vp.toDoc(vp.w, vp.h), c = vp.toDoc(vp.w, 0), d = vp.toDoc(0, vp.h);
    const xs = [a.x, b.x, c.x, d.x], ys = [a.y, b.y, c.y, d.y];
    return { x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)), w: Math.ceil(Math.max(...xs) - Math.min(...xs)), h: Math.ceil(Math.max(...ys) - Math.min(...ys)) };
  }

  /** Fits the canvas on screen; `turn` restores how it was last held (rotation and flips). */
  fitView(turn: ViewTurn = { rot: 0, flipX: 1, flipY: 1 }) {
    const s = this.doc.settings;
    const vp = this.view.viewport;
    vp.flipX = turn.flipX; vp.flipY = turn.flipY;
    if (!s.infinite) vp.fit({ x: 0, y: 0, w: s.width, h: s.height }, 40, turn.rot);
    else {
      const b = this.doc.bounds();
      if (b) vp.fit(b, 80, turn.rot);
      else { vp.rot = turn.rot; vp.zoom = 1; vp.cx = 0; vp.cy = 0; vp.onChange(); }
    }
    this.emit('view');
  }

  /** How the canvas is held now, for `fitView` next time. */
  get turn(): ViewTurn { const vp = this.view.viewport; return { rot: vp.rot, flipX: vp.flipX, flipY: vp.flipY }; }

  toast(msg: string) { this.emit('toast:' + msg); }

  private lastCursor = 0;
  sendCursor(x: number, y: number, drawing: boolean) {
    if (!this.room || this.readOnly) return;
    const now = performance.now();
    if (drawing && now - this.lastCursor < 50) return;
    // A brush stroke's live points already say where the pen is.
    if (drawing && this.view.live && (this.toolId === 'brush' || this.toolId === 'eraser')) return;
    this.lastCursor = now;
    this.room.send({ type: 'cursor', x: Math.round(x), y: Math.round(y), drawing });
  }
}

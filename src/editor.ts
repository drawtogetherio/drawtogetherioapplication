import { DrawDoc, Layer, newFolderProps, newLayerProps, opsCost } from './core/document';
import { Point, Rect, polyPath, uid } from './core/geom';
import { BrushParams, Op, Selection, ShapeKind } from './core/model';
import { BRUSH_PRESETS, ERASER_PRESETS, SMUDGE_PARAMS } from './engine/brush';
import { CanvasView } from './view/canvasView';
import type { Tool } from './tools/tool';
import type { RoomClient } from './net/roomClient';
import type { MyProfile } from './shared/profile';
import { userFolderId } from './shared/protocol';
import type { ApplyOptions } from './core/document';

export type ToolId = 'brush' | 'eraser' | 'smudge' | 'fill' | 'select' | 'shape' | 'eyedropper';
export type SelectMode = 'rect' | 'ellipse' | 'lasso';

export interface EditorSettings {
  brush: BrushParams;
  brushPreset: number;
  eraser: BrushParams;
  eraserPreset: number;
  smudge: BrushParams;
  fillTolerance: number; // 0..1
  fillSampleAll: boolean;
  fillExpand: number;
  selectMode: SelectMode;
  shape: ShapeKind;
  shapeFill: boolean;
  pressureGamma: number; // pressure curve exponent
  fingerDraws: boolean; // when false, one finger pans (set automatically once a pen is used)
  showBubbles: boolean; // name bubbles where others are drawing
  hideOthersFolders: boolean; // layers panel shows only your own folder
}

type Listener = (what: string) => void;

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
  hover: (Point & { pointer: string }) | null = null;
  me: MyProfile | null = null;
  targetFolder: string | null = null;
  room: RoomClient | null = null;
  settings: EditorSettings = {
    brush: { ...BRUSH_PRESETS[0].params }, brushPreset: 0,
    eraser: { ...ERASER_PRESETS[0].params }, eraserPreset: 0,
    smudge: { ...SMUDGE_PARAMS },
    fillTolerance: 0.12, fillSampleAll: true, fillExpand: 1,
    selectMode: 'rect', shape: 'rect', shapeFill: false,
    pressureGamma: 1, fingerDraws: true, showBubbles: true, hideOthersFolders: false,
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

  setActiveLayer(id: string) {
    this.commitPending();
    this.activeLayer = id;
    this.targetFolder = null;
    this.emit('layers');
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
    ops.forEach((op, i) => {
      op.author = this.room?.you;
      const inv = this.doc.apply(op, i === 0 ? opts : {});
      if (!inv.length) return;
      this.room?.sendOp(op);
      inverse.unshift(...inv);
    });
    if (inverse.length) this.doc.history.record({ label, undo: inverse, redo: [], cost: opsCost(inverse) });
  }

  apply(op: Op, opts: ApplyOptions = {}) { this.run([op], op.t, opts); }

  private replay(ops: Op[]): Op[] {
    const inverse: Op[] = [];
    for (const op of ops) {
      const inv = this.doc.apply(op);
      if (!inv.length) continue;
      this.room?.sendOp(op);
      inverse.unshift(...inv);
    }
    return inverse;
  }

  undo() {
    if (this.readOnly) return;
    if (this.currentTool.busy?.()) { this.currentTool.cancel(); this.view.invalidate(null); return; }
    const e = this.doc.history.takeUndo();
    if (!e) return;
    e.redo = this.replay(e.undo);
    e.cost = opsCost(e.redo);
    this.doc.history.putUndone(e);
  }

  redo() {
    if (this.readOnly) return;
    this.commitPending();
    const e = this.doc.history.takeRedo();
    if (!e) return;
    e.undo = this.replay(e.redo);
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

  clipPath(): Path2D | undefined { return this.selection ? polyPath(this.selection.pts) : undefined; }

  workArea(): Rect {
    const s = this.doc.settings;
    if (!s.infinite) return { x: 0, y: 0, w: s.width, h: s.height };
    const vp = this.view.viewport;
    const a = vp.toDoc(0, 0), b = vp.toDoc(vp.w, vp.h), c = vp.toDoc(vp.w, 0), d = vp.toDoc(0, vp.h);
    const xs = [a.x, b.x, c.x, d.x], ys = [a.y, b.y, c.y, d.y];
    return { x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)), w: Math.ceil(Math.max(...xs) - Math.min(...xs)), h: Math.ceil(Math.max(...ys) - Math.min(...ys)) };
  }

  fitView() {
    const s = this.doc.settings;
    const vp = this.view.viewport;
    vp.flipX = 1; vp.flipY = 1;
    if (!s.infinite) vp.fit({ x: 0, y: 0, w: s.width, h: s.height });
    else {
      const b = this.doc.bounds();
      if (b) vp.fit(b, 80);
      else { vp.rot = 0; vp.zoom = 1; vp.cx = 0; vp.cy = 0; vp.onChange(); }
    }
    this.emit('view');
  }

  toast(msg: string) { this.emit('toast:' + msg); }

  private lastCursor = 0;
  sendCursor(x: number, y: number, drawing: boolean) {
    if (!this.room || this.readOnly) return;
    const now = performance.now();
    if (drawing && now - this.lastCursor < 50) return;
    this.lastCursor = now;
    this.room.send({ type: 'cursor', x: Math.round(x), y: Math.round(y), drawing });
  }
}

import { DrawDoc, newLayerProps } from './core/document';
import { Point, Rect, polyPath, uid } from './core/geom';
import { BrushParams, Op, Selection, ShapeKind } from './core/model';
import { BRUSH_PRESETS, ERASER_PRESETS } from './engine/brush';
import { CanvasView } from './view/canvasView';
import type { Tool } from './tools/tool';

export type ToolId = 'brush' | 'eraser' | 'fill' | 'select' | 'shape' | 'eyedropper';
export type SelectMode = 'rect' | 'ellipse' | 'lasso';

export interface EditorSettings {
  brush: BrushParams;
  brushPreset: number;
  eraser: BrushParams;
  eraserPreset: number;
  fillTolerance: number; // 0..1
  fillSampleAll: boolean;
  fillExpand: number;
  selectMode: SelectMode;
  shape: ShapeKind;
  shapeFill: boolean;
  pressureGamma: number; // pressure curve exponent
  fingerDraws: boolean; // when false, one finger pans (set automatically once a pen is used)
}

type Listener = (what: string) => void;

/**
 * Per-user editor state around a document: active tool and layer, colour, selection. None of this
 * is part of the shared document, so later each collaborator keeps their own.
 */
export class Editor {
  doc: DrawDoc;
  readonly view: CanvasView;
  tools = {} as Record<ToolId, Tool>;
  toolId: ToolId = 'brush';
  activeLayer: string;
  color = '#1b1b1f';
  recentColors: string[] = [];
  selection: Selection | null = null;
  author = uid('u_');
  hover: (Point & { pointer: string }) | null = null;
  settings: EditorSettings = {
    brush: { ...BRUSH_PRESETS[0].params }, brushPreset: 0,
    eraser: { ...ERASER_PRESETS[0].params }, eraserPreset: 0,
    fillTolerance: 0.12, fillSampleAll: true, fillExpand: 1,
    selectMode: 'rect', shape: 'rect', shapeFill: false,
    pressureGamma: 1, fingerDraws: true,
  };
  private listeners = new Set<Listener>();
  private unsubDoc: () => void = () => {};

  constructor(doc: DrawDoc, stage: HTMLElement) {
    this.doc = doc;
    this.activeLayer = doc.layers[doc.layers.length - 1].props.id;
    this.view = new CanvasView(doc, stage);
    this.bindDoc();
  }

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what: string) { for (const fn of this.listeners) fn(what); }

  private bindDoc() {
    this.unsubDoc();
    this.unsubDoc = this.doc.on((c) => {
      this.view.invalidate(c.rect);
      if (!this.doc.layer(this.activeLayer)) this.activeLayer = this.doc.layers[Math.max(0, this.doc.layers.length - 1)].props.id;
      if (c.structure) this.emit('layers');
    });
    this.doc.history.onChange = () => this.emit('history');
  }

  setDoc(doc: DrawDoc) {
    this.currentTool.cancel();
    this.selection = null;
    this.doc = doc;
    this.activeLayer = doc.layers[doc.layers.length - 1].props.id;
    this.view.setDoc(doc);
    this.bindDoc();
    this.fitView();
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

  /** Brush parameters that the size/opacity sliders currently control. */
  get sizeParams(): BrushParams { return this.toolId === 'eraser' ? this.settings.eraser : this.settings.brush; }

  setColor(c: string, commitRecent = false) {
    this.color = c;
    if (commitRecent) this.pushRecent(c);
    this.emit('color');
  }

  pushRecent(c: string) {
    this.recentColors = [c, ...this.recentColors.filter((x) => x !== c)].slice(0, 12);
  }

  get layer() { return this.doc.layer(this.activeLayer)!; }

  setActiveLayer(id: string) {
    this.commitPending();
    this.activeLayer = id;
    this.emit('layers');
  }

  /** Apply an op authored by this user. */
  apply(op: Op, buffer?: Parameters<DrawDoc['apply']>[1]) {
    op.author = this.author;
    this.doc.apply(op, buffer);
  }

  addLayer() {
    this.commitPending();
    const idx = this.doc.indexOf(this.activeLayer) + 1;
    const props = newLayerProps(`Layer ${this.doc.layers.length + 1}`);
    this.apply({ t: 'layer.add', id: uid(), index: idx, layer: props });
    this.setActiveLayer(props.id);
  }

  duplicateLayer() {
    this.commitPending();
    const src = this.layer;
    const props = { ...src.props, id: uid('ly_'), name: src.props.name + ' copy' };
    this.apply({ t: 'layer.add', id: uid(), index: this.doc.indexOf(src.props.id) + 1, layer: props, copyOf: src.props.id });
    this.setActiveLayer(props.id);
  }

  /** Finish any in-progress transform before other actions. */
  commitPending() { this.currentTool.commit?.(); }

  undo() {
    if (this.currentTool.busy?.()) { this.currentTool.cancel(); this.view.invalidate(null); return; }
    this.doc.history.undo();
  }
  redo() {
    this.commitPending();
    this.doc.history.redo();
  }

  /** Selection clip used by painting tools. */
  clipPath(): Path2D | undefined { return this.selection ? polyPath(this.selection.pts) : undefined; }

  /** Area used for "select all" and unbounded fills. */
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
}

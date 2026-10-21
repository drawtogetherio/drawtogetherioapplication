import { BLEND_MODES, EFFECTS, type BrushParams, type Op } from '../src/core/model.ts';
import type { LiveStroke } from '../src/shared/protocol.ts';

// Shape and size checks for everything clients send into a room. Anything that fails is dropped
// before it reaches the op log or other people's browsers.

const MAX_ID = 48, MAX_NAME = 64, MAX_INDEX = 10_000;
const MAX_STROKE_PTS = 30_000, MAX_LIVE_PTS = 3_000, MAX_CLIP_PTS = 20_000;
const MAX_BRUSH = 500, MAX_COORD = 4e6, MAX_REGION_PX = 100e6;
const MAX_TILES = 512, MAX_TILE_CHARS = 400_000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number) => isNum(v) && v >= lo && v <= hi;
const isBool = (v: unknown) => typeof v === 'boolean';
const isId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
const isName = (v: unknown) => typeof v === 'string' && v.length <= MAX_NAME;
const isColor = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isIndex = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_INDEX;
const isParent = (v: unknown) => v === null || isId(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function nums(v: unknown, max: number, stride: number, min = stride): v is number[] {
  if (!Array.isArray(v) || v.length < min || v.length > max || v.length % stride) return false;
  for (const n of v) if (!isNum(n) || Math.abs(n) > MAX_COORD) return false;
  return true;
}

const isClip = (v: unknown) => v === undefined || (obj(v) && nums(v.pts, MAX_CLIP_PTS, 2, 6));
const isMask = (v: unknown) => v === undefined || v === true;

function isBrush(b: unknown): b is BrushParams {
  return obj(b) && inRange(b.size, 0.1, MAX_BRUSH) && inRange(b.opacity, 0, 1) && inRange(b.flow, 0, 1) && inRange(b.hardness, 0, 1)
    && inRange(b.spacing, 0.01, 4) && inRange(b.pressureSize, 0, 1) && inRange(b.pressureFlow, 0, 1) && inRange(b.minSize, 0, 1) && inRange(b.smoothing, 0, 1)
    && (b.shape === undefined || b.shape === 'round' || b.shape === 'square') && (b.grain === undefined || inRange(b.grain, 0, 1)) && (b.grainScale === undefined || inRange(b.grainScale, 0.25, 8));
}

const LAYER_PROPS: Record<string, (v: unknown) => boolean> = {
  name: isName, visible: isBool, opacity: (v) => inRange(v, 0, 1), blend: (v) => BLEND_MODES.includes(v as never), alphaLock: isBool, clip: isBool, mask: isBool,
};
const FOLDER_PROPS: Record<string, (v: unknown) => boolean> = { name: isName, visible: isBool, color: (v) => v === null || isColor(v) };

function propsOk(props: unknown, rules: Record<string, (v: unknown) => boolean>, all: boolean) {
  if (!obj(props)) return false;
  const keys = Object.keys(props);
  if (all && ['name', 'visible', 'opacity', 'blend', 'alphaLock'].some((k) => !(k in props))) return false;
  return keys.every((k) => rules[k]?.(props[k]));
}

export function validLive(l: unknown): l is LiveStroke {
  return obj(l) && isId(l.stroke) && isId(l.layer) && isBool(l.erase) && isBrush(l.brush) && isColor(l.color) && isClip(l.clip) && isMask(l.mask) && nums(l.pts, MAX_LIVE_PTS, 3, 0);
}

export function validOp(op: unknown): op is Op {
  if (!obj(op) || !isId(op.id) || !isMask(op.mask)) return false;
  switch (op.t) {
    case 'stroke':
      return isId(op.layer) && isBool(op.erase) && isBrush(op.brush) && isColor(op.color) && isClip(op.clip) && nums(op.pts, MAX_STROKE_PTS, 3);
    case 'smudge':
      return isId(op.layer) && isBrush(op.brush) && isClip(op.clip) && nums(op.pts, MAX_STROKE_PTS, 3);
    case 'effect':
      return isId(op.layer) && EFFECTS.includes(op.effect as never) && inRange(op.amount, 0, 1) && (op.angle === undefined || inRange(op.angle, -7, 7)) && isClip(op.clip);
    case 'shape':
      return isId(op.layer) && ['line', 'rect', 'ellipse'].includes(op.shape as string) && nums([op.x0, op.y0, op.x1, op.y1], 4, 4)
        && inRange(op.width, 0, MAX_BRUSH) && isBool(op.fill) && isColor(op.color) && inRange(op.opacity, 0, 1) && isBool(op.erase) && isClip(op.clip);
    case 'fill': {
      const r = op.region;
      return isId(op.layer) && nums([op.x, op.y], 2, 2) && isColor(op.color) && inRange(op.tolerance, 0, 1) && isBool(op.sampleAll) && inRange(op.expand, 0, 16)
        && obj(r) && nums([r.x, r.y], 2, 2) && inRange(r.w, 1, 16384) && inRange(r.h, 1, 16384) && (r.w as number) * (r.h as number) <= MAX_REGION_PX && isClip(op.clip);
    }
    case 'transform':
      return isId(op.layer) && obj(op.sel) && nums(op.sel.pts, MAX_CLIP_PTS, 2, 6) && nums(op.m, 6, 6);
    case 'tiles': {
      if (!isId(op.layer) || !obj(op.tiles) || 'img' in op) return false;
      const entries = Object.entries(op.tiles);
      if (entries.length > MAX_TILES) return false;
      return entries.every(([k, v]) => /^-?\d{1,6},-?\d{1,6}$/.test(k) && (v === null || (typeof v === 'string' && v.length <= MAX_TILE_CHARS && v.startsWith('data:image/png;base64,'))));
    }
    case 'layer.add': {
      if (!obj(op.layer)) return false;
      const { id, owner: _owner, ...props } = op.layer;
      return isId(id) && propsOk(props, LAYER_PROPS, true) && isParent(op.parent) && isIndex(op.index) && (op.copyOf === undefined || isId(op.copyOf));
    }
    case 'layer.remove': case 'layer.clear': case 'layer.merge': case 'layer.mask.apply':
      return isId(op.layer);
    case 'layer.props':
      return isId(op.layer) && propsOk(op.props, LAYER_PROPS, false);
    case 'folder.add':
      return obj(op.folder) && isId(op.folder.id) && isName(op.folder.name) && isBool(op.folder.visible)
        && (op.folder.color === undefined || op.folder.color === null || isColor(op.folder.color)) && isParent(op.parent) && isIndex(op.index);
    case 'folder.remove':
      return isId(op.folder);
    case 'folder.props':
      return isId(op.folder) && propsOk(op.props, FOLDER_PROPS, false);
    case 'node.move':
      return isId(op.node) && isParent(op.parent) && isIndex(op.index);
  }
  return false;
}

# drawwith.us (working name)

A drawing app for web, Windows, Mac and iPad, built so people can later draw on the same canvas together.
This first step is the single-user drawing experience.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173 (also reachable from an iPad on the same network)
npm run build        # production build in dist/
npm run build:preview  # one self-contained HTML file in preview/
```

## Features in v0.1

- Canvas: fixed size (presets or custom) or **Unlimited** (endless whiteboard; exports crop to the artwork)
- Brush and eraser with presets, pen pressure (size / opacity), smoothing, hardness, flow; Apple Pencil, Wacom and Surface pens via Pointer Events
- Selection: rectangle, ellipse, lasso; move, rotate (Shift snaps 15°), scale (uniform from corners, Shift for free), flip; painting is clipped to the selection
- Fill bucket with tolerance, gap expand and "all layers / this layer" reference
- Shapes: line, rectangle, ellipse (outline or filled)
- Eyedropper (or hold Alt with the brush)
- Flip view horizontally / vertically, pan / zoom / rotate (two fingers, trackpad, space-drag, Ctrl+scroll)
- Undo / redo (buttons, Ctrl+Z / Ctrl+Shift+Z, two- and three-finger taps)
- HSV colour picker, palette and recent colours
- Layers: add, duplicate, delete, reorder (drag), rename, visibility, opacity, 17 blend modes, lock transparency, merge down, clear
- Export PNG, JPG and layered PSD (blend modes and opacity preserved)

## Architecture

```
src/core/      document model: ops, layers, tiled surfaces, undo history
src/engine/    brush dabs, flood fill, shapes, selection transforms, layer compositing
src/view/      viewport (pan/zoom/rotate/flip), screen renderer, pointer + gesture input
src/tools/     brush/eraser, fill, select/transform, shapes, eyedropper
src/ui/        top bar, tool options, sidebar, colour picker, layers panel, dialogs
src/io/        PNG/JPG/PSD export, platform save adapter
```

**Built for sync from the start.** Every change to the canvas is a small JSON `Op` (`stroke`, `shape`,
`fill`, `transform`, `layer.*`) applied by `DrawDoc.apply()`. Ops are deterministic: a stroke stores its
raw pen samples and the renderer applies smoothing itself, so replaying the op log reproduces the
canvas pixel for pixel (`tests/replay.mjs` checks this). Ids are random, and each op carries an
`author`. Real-time collaboration can then exchange ops over a server, with per-user undo built on
the same log. Undo/redo today is local and stores before/after tiles.

**Rendering.** Layers are sparse 256×256 tiles, which is what makes the unlimited canvas possible.
Layers are composited in document space into a tile-aligned cache (so blend modes are exact and
there are no seams between tiles), then drawn once with the view transform.

**Platforms.** The same TypeScript web app is meant to be wrapped with Tauri (Windows/Mac) and
Capacitor (iPad). `src/io/platform.ts` is where native save dialogs plug in.

## Tests

With `npm run build && npx vite preview --port 4173` running:

```bash
node tests/smoke.mjs     # draws, fills, transforms, layers, exports; screenshots in test-results/
node tests/touch.mjs     # finger drawing, pinch/rotate, two/three-finger undo/redo, palm rejection
node tests/replay.mjs    # replaying the op log reproduces identical pixels
```
Set `CHROMIUM=/path/to/chrome` if Playwright's bundled browser isn't installed.

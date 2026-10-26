import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, hasTouch: true });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto(process.argv[2] ?? 'http://localhost:4173/');
await page.getByText('Create canvas').click();
const r = await page.evaluate(async () => {
  const c = document.querySelector('canvas.stage');
  const ed = window.doodlehive.ed;
  const fire = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, isPrimary: id === 1, bubbles: true, buttons: type === 'pointerup' ? 0 : 1 }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // finger stroke
  fire('pointerdown', 1, 300, 400); for (let i = 0; i < 20; i++) fire('pointermove', 1, 300 + i * 10, 400 + i * 3); fire('pointerup', 1, 500, 460);
  await wait(50);
  const afterStroke = ed.doc.log.length;
  // pinch zoom + rotate
  const z0 = ed.view.viewport.zoom;
  fire('pointerdown', 1, 500, 400); fire('pointerdown', 2, 600, 400);
  for (let i = 1; i <= 10; i++) { fire('pointermove', 1, 500 - i * 10, 400 - i * 3); fire('pointermove', 2, 600 + i * 10, 400 + i * 3); }
  fire('pointerup', 1, 400, 370); fire('pointerup', 2, 700, 430);
  const z1 = ed.view.viewport.zoom, rot = ed.view.viewport.rot;
  await wait(50);
  // two-finger tap = undo
  const canUndo = ed.doc.history.canUndo;
  fire('pointerdown', 1, 500, 400); fire('pointerdown', 2, 600, 400); await wait(80); fire('pointerup', 1, 500, 400); fire('pointerup', 2, 600, 400);
  const undone = !ed.doc.history.canUndo && ed.doc.history.canRedo;
  // three-finger tap = redo
  fire('pointerdown', 1, 500, 400); fire('pointerdown', 2, 600, 400); fire('pointerdown', 3, 700, 400); await wait(80);
  fire('pointerup', 1, 500, 400); fire('pointerup', 2, 600, 400); fire('pointerup', 3, 700, 400);
  // pen then finger: finger should no longer draw
  c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'pen', clientX: 300, clientY: 300, pressure: 0.5, buttons: 1, bubbles: true }));
  c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'pen', clientX: 300, clientY: 300, bubbles: true }));
  const n = ed.doc.log.length;
  fire('pointerdown', 1, 300, 500); for (let i = 0; i < 10; i++) fire('pointermove', 1, 300 + i * 10, 500); fire('pointerup', 1, 400, 500);
  // four-finger tap hides the UI, and again shows it
  const four = async () => { for (let i = 1; i <= 4; i++) fire('pointerdown', i, 400 + i * 50, 400); await wait(60); for (let i = 1; i <= 4; i++) fire('pointerup', i, 400 + i * 50, 400); await wait(20); };
  await four(); const hidden = document.body.classList.contains('ui-hidden'); await four(); const shown = !document.body.classList.contains('ui-hidden');
  // a finger held still picks the colour under it: the stroke drawn at the start was dark on white
  ed.setColor('#ff0000');
  const sample = () => { const b = ed.layer.surface.contentBounds(); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
  const s = ed.view.viewport.toScreen(sample().x, sample().y), rc = c.getBoundingClientRect();
  fire('pointerdown', 1, rc.left + s.x, rc.top + s.y); await wait(600);
  const picking = ed.color !== '#ff0000'; fire('pointerup', 1, rc.left + s.x, rc.top + s.y); await wait(20);
  const picked = ed.color;
  // a pinch that ends within a few degrees of upright snaps to exactly 0
  ed.view.viewport.rot = 0; ed.view.viewport.onChange();
  fire('pointerdown', 1, 500, 400); fire('pointerdown', 2, 600, 400);
  for (let i = 1; i <= 5; i++) { fire('pointermove', 1, 500 + i * 4, 400); fire('pointermove', 2, 600 + i * 4, 400 + i); }
  fire('pointerup', 1, 520, 400); fire('pointerup', 2, 620, 405);
  const snapped = ed.view.viewport.rot === 0;
  return { afterStroke, z0, z1, rot, canUndo, undone, redone: ed.doc.history.canUndo, fingerIgnoredAfterPen: ed.doc.log.length === n, hidden, shown, picking, picked, snapped };
});
console.log(r);
const ok = r.hidden && r.shown && r.picking && r.picked !== '#ff0000' && r.snapped;
console.log(ok ? 'ok   four-finger tap, hold to pick and rotation snap' : 'FAIL gestures');
await browser.close();
if (!ok) process.exit(1);

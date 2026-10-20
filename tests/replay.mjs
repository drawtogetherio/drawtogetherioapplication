// Checks that replaying the op log reproduces the canvas (the basis for future sync).
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.goto(process.argv[2] ?? 'http://localhost:4173/');
await page.getByText('Square').click();
await page.getByText('Create canvas').click();
const m = page.mouse;
await m.move(400, 300); await m.down(); for (let i = 0; i < 40; i++) await m.move(400 + i * 12, 300 + Math.sin(i / 5) * 80); await m.up();
await page.keyboard.press('u'); await m.move(500, 400); await m.down(); await m.move(800, 600, { steps: 4 }); await m.up();
await page.keyboard.press('g'); await m.click(650, 500);
await page.keyboard.press('m'); await m.move(450, 350); await m.down(); await m.move(850, 650, { steps: 4 }); await m.up();
await m.move(650, 500); await m.down(); await m.move(700, 560, { steps: 4 }); await m.up(); await page.keyboard.press('Enter');
await page.keyboard.press('e'); await m.move(300, 500); await m.down(); await m.move(900, 450, { steps: 10 }); await m.up();
const res = await page.evaluate(() => {
  const ed = window.doodlehive.ed, Doc = ed.doc.constructor;
  const copy = new Doc({ ...ed.doc.settings });
  for (const op of ed.doc.log) copy.apply(JSON.parse(JSON.stringify(op)), { undoable: false });
  const px = (d) => { const l = d.layers[0].surface; const c = document.createElement('canvas'); c.width = 2048; c.height = 2048; const x = c.getContext('2d'); l.drawTo(x); return x.getImageData(0, 0, 2048, 2048).data; };
  const a = px(ed.doc), b = px(copy);
  let diff = 0, maxd = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > 2) diff++; if (d > maxd) maxd = d; }
  return { ops: ed.doc.log.map((o) => o.t), differingChannels: diff, maxDelta: maxd, json: JSON.stringify(ed.doc.log).length };
});
console.log(res);
await browser.close();

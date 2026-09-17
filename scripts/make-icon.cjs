// Render the Shelf mark to build/icon.png (1024 px, transparent corners) and
// build/icon.ico. electron-builder makes the macOS .icns and Linux icons from
// the PNG; the .ico goes into Shelf.exe and the installer.
//
//   npm run icon
//
// The mark is the same amber "S" tile the app shows in its sidebar, set in the
// bundled Archivo, with a strip of film-sprocket holes top and bottom. It is
// drawn on a canvas, which keeps the alpha channel and renders the same way
// every run.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SIZE = 1024;
const OUT = path.join(ROOT, 'build', 'icon.png');
const FONT = path
  .join(ROOT, 'client/node_modules/@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2')
  .replace(/\\/g, '/');

const draw = `(async () => { try {
  const face = new FontFace('Archivo Icon', "url('file:///${FONT}')", { weight: '100 900' });
  document.fonts.add(await face.load());

  const S = ${SIZE};
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');

  const inset = 56, r = 200, w = S - inset * 2;
  const tile = new Path2D();
  tile.roundRect(inset, inset, w, w, r);
  g.save();
  g.clip(tile);

  const base = g.createRadialGradient(0.22 * S, 0.12 * S, 0, 0.22 * S, 0.12 * S, 1.15 * S);
  base.addColorStop(0, '#F7D27A');
  base.addColorStop(0.48, '#E8B44A');
  base.addColorStop(1, '#C4892A');
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);

  // Soft light at the top edge, shade at the bottom.
  const top = g.createLinearGradient(0, inset, 0, inset + 60);
  top.addColorStop(0, 'rgba(255,244,214,.35)');
  top.addColorStop(1, 'rgba(255,244,214,0)');
  g.fillStyle = top;
  g.fillRect(0, inset, S, 60);
  const bottom = g.createLinearGradient(0, S - inset - 90, 0, S - inset);
  bottom.addColorStop(0, 'rgba(60,35,0,0)');
  bottom.addColorStop(1, 'rgba(60,35,0,.28)');
  g.fillStyle = bottom;
  g.fillRect(0, S - inset - 90, S, 90);

  // Sprocket holes.
  g.fillStyle = 'rgba(20,16,10,.26)';
  const holes = 7, hw = 58, hh = 34, left = 166, right = S - 166;
  const step = (right - left - hw) / (holes - 1);
  for (const y of [inset + 51, S - inset - 51 - hh]) {
    for (let i = 0; i < holes; i++) {
      g.beginPath();
      g.roundRect(left + i * step, y, hw, hh, 9);
      g.fill();
    }
  }

  // The S, centred on its ink bounds rather than the font's line box.
  g.fillStyle = '#14100A';
  g.font = "900 640px 'Archivo Icon'";
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const m = g.measureText('S');
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const x = S / 2 + (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2;
  const y = S / 2 + inkH / 2 - m.actualBoundingBoxDescent;
  g.fillText('S', x, y);
  g.restore();

  return { png: c.toDataURL('image/png'), fontOk: document.fonts.check("900 100px 'Archivo Icon'"), inkW, inkH };
} catch (e) { return { error: String(e) }; } })()`;

function ico(image) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => image.resize({ width: s, height: s, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(s >= 256 ? 0 : s, at); // 0 means 256
    header.writeUInt8(s >= 256 ? 0 : s, at + 1);
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(pngs[i].length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += pngs[i].length;
  });
  return { buffer: Buffer.concat([header, ...pngs]), sizes };
}

app.whenReady().then(async () => {
  try {
    // A file:// page, so it may load the font from node_modules.
    const page = path.join(app.getPath('temp'), 'shelf-icon.html');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8">');
    const win = new BrowserWindow({ show: false });
    await win.loadFile(page);
    const { png, fontOk, inkW, inkH, error } = await win.webContents.executeJavaScript(draw);
    if (error) throw new Error(error);
    if (!fontOk) throw new Error('Archivo did not load; run `npm run setup` first');

    const image = nativeImage.createFromDataURL(png);
    const { width } = image.getSize();
    if (width !== SIZE) throw new Error(`unexpected width ${width}`);
    const bitmap = image.toBitmap(); // BGRA
    const alphaAt = (x, y) => bitmap[(y * SIZE + x) * 4 + 3];
    if (alphaAt(4, 4) !== 0 || alphaAt(512, 512) !== 255) throw new Error('icon did not render');

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, image.toPNG());
    const icon = ico(image);
    fs.writeFileSync(OUT.replace(/\.png$/, '.ico'), icon.buffer);
    console.log(`icon -> build/icon.png (${SIZE}px, S ink ${Math.round(inkW)}x${Math.round(inkH)})`);
    console.log(`icon -> build/icon.ico (${icon.sizes.join(', ')})`);
  } catch (err) {
    console.error('make-icon failed:', err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});

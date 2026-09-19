// Render the Shelf mark to build/icon.png (1024 px, transparent corners) and
// build/icon.ico. electron-builder makes the macOS .icns and Linux icons from
// the PNG; the .ico goes into Shelf.exe and the installer.
//
//   npm run icon
//
// The mark is what the app is: a shelf with things standing on it, one of them
// a film case with sprocket holes. An amber tile, the app's own accent. It is
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

const draw = (simple) => `(async () => { try {
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

  const INK = '#14100A';
  const SHELF_Y = 726;      // top of the plank: everything stands on this line
  const PLANK_H = 60;

  // Four things on a shelf. The second is a film case, which is what makes the
  // mark say "films and series" and not "books".
  // At 16 and 24 pixels the detailed mark turns to mush, so those sizes get a
  // simpler one: three chunky cases, wide gaps, no sprocket holes.
  const spines = ${simple}
    ? [
        { x: 236, w: 156, h: 320, lean: 0, film: false },
        { x: 428, w: 172, h: 430, lean: 0, film: false },
        { x: 636, w: 156, h: 360, lean: 0, film: false },
      ]
    : [
        { x: 252, w: 104, h: 300, lean: 0, film: false },
        { x: 374, w: 136, h: 384, lean: 0, film: true },
        { x: 528, w: 104, h: 330, lean: 0, film: false },
        { x: 650, w: 104, h: 338, lean: 9, film: false },
      ];

  g.fillStyle = INK;
  for (const s of spines) {
    g.save();
    if (s.lean) {
      // Lean it on its bottom-right corner, the way a case slumps on a shelf.
      g.translate(s.x + s.w, SHELF_Y);
      g.rotate((s.lean * Math.PI) / 180);
      g.translate(-(s.x + s.w), -SHELF_Y);
    }
    g.beginPath();
    g.roundRect(s.x, SHELF_Y - s.h, s.w, s.h, 16);
    g.fill();
    if (s.film) {
      // Sprocket holes in the tile's own amber, so they read as holes in a
      // film case rather than holes in the icon.
      g.fillStyle = base;
      const hw = 34, hh = 26, cx = s.x + s.w / 2 - hw / 2;
      for (let i = 0; i < 4; i++) {
        g.beginPath();
        g.roundRect(cx, SHELF_Y - s.h + 52 + i * 62, hw, hh, 7);
        g.fill();
      }
      g.fillStyle = INK;
    }
    g.restore();
  }

  // The plank itself, drawn last so the spines meet it cleanly.
  g.fillStyle = INK;
  const plankX = ${simple} ? 180 : 196;
  g.beginPath();
  g.roundRect(plankX, SHELF_Y, S - plankX * 2, ${simple} ? 86 : PLANK_H, 18);
  g.fill();

  return { png: c.toDataURL('image/png'), fontOk: true };
} catch (e) { return { error: String(e) }; } })()`;

function ico(detailed, simple) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) =>
    (s <= 24 ? simple : detailed).resize({ width: s, height: s, quality: 'best' }).toPNG()
  );
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
    const { png, error } = await win.webContents.executeJavaScript(draw(false));
    if (error) throw new Error(error);
    const small = await win.webContents.executeJavaScript(draw(true));
    if (small.error) throw new Error(small.error);

    const image = nativeImage.createFromDataURL(png);
    const { width } = image.getSize();
    if (width !== SIZE) throw new Error(`unexpected width ${width}`);
    const bitmap = image.toBitmap(); // BGRA
    const alphaAt = (x, y) => bitmap[(y * SIZE + x) * 4 + 3];
    if (alphaAt(4, 4) !== 0 || alphaAt(512, 512) !== 255) throw new Error('icon did not render');

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, image.toPNG());
    const icon = ico(image, nativeImage.createFromDataURL(small.png));
    fs.writeFileSync(OUT.replace(/\.png$/, '.ico'), icon.buffer);
    console.log(`icon -> build/icon.png (${SIZE}px)`);
    console.log(`icon -> build/icon.ico (${icon.sizes.join(', ')})`);
  } catch (err) {
    console.error('make-icon failed:', err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});

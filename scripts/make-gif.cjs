// Record the README animation: Shelf, driven through a short tour, captured
// frame by frame and written as a GIF.
//
//   npx electron scripts/make-gif.cjs
//
// Needs a Shelf server with a library in it (GIF_BASE, default :4184). Frames
// come from Electron's own renderer, so what is recorded is the real app, not
// a mockup. One palette is built from the whole recording and reused for every
// frame: a per-frame palette shimmers on gradients, which this design is full of.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const BASE = process.env.GIF_BASE || 'http://127.0.0.1:4184';
const OUT = path.resolve(process.env.GIF_OUT || path.join(__dirname, '..', 'docs', 'shelf.gif'));
const WIDTH = Number(process.env.GIF_W) || 960;
const HEIGHT = Number(process.env.GIF_H) || 600;
const FPS = Number(process.env.GIF_FPS) || 8;
const COLOURS = Number(process.env.GIF_COLOURS) || 160;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();

/** The tour. Each step runs in the page, then that many frames are recorded. */
const STEPS = [
  { do: null, frames: 10, note: 'the library' },
  { do: `document.querySelector('a[href^="/show/"]').click()`, frames: 14, note: 'a series' },
  { do: `window.scrollTo({ top: 520, behavior: 'smooth' })`, frames: 10, note: 'its episodes' },
  { do: `document.querySelector('a[href="/organize"]').click()`, frames: 8, note: 'the organizer' },
  { do: `window.scrollTo({ top: 980, behavior: 'smooth' })`, frames: 18, note: 'what it would do' },
  { do: `document.querySelector('a[href="/stats"]').click(); window.scrollTo(0, 0)`, frames: 12, note: 'statistics' },
  { do: `document.querySelector('a[href="/"]').click()`, frames: 4, note: 'back to the library' },
  { do: `[...document.querySelectorAll('[role="tab"]')].find(t => /genres/i.test(t.textContent))?.click()`, frames: 14, note: 'by genre' },
];

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#08090c',
      webPreferences: { backgroundThrottling: false },
    });

    await win.loadURL(BASE + '/');
    await win.webContents.executeJavaScript(`localStorage.removeItem('shelf.theme.v2')`);
    await sleep(2500);

    const frames = [];
    const capture = async () => {
      let image = await win.webContents.capturePage();
      if (image.isEmpty()) {
        win.showInactive();
        await sleep(300);
        image = await win.webContents.capturePage();
      }
      // capturePage follows the display's scale factor; the GIF should not.
      const { width } = image.getSize();
      if (width !== WIDTH) image = image.resize({ width: WIDTH, height: HEIGHT, quality: 'good' });
      frames.push(image.toBitmap()); // BGRA
    };

    const interval = Math.round(1000 / FPS);
    for (const step of STEPS) {
      if (step.do) await win.webContents.executeJavaScript(step.do).catch(() => {});
      await sleep(450); // let the click land and the page settle
      for (let i = 0; i < step.frames; i++) {
        const started = Date.now();
        await capture();
        const left = interval - (Date.now() - started);
        if (left > 0) await sleep(left);
      }
      console.log(`captured ${step.frames} frames of ${step.note}`);
    }
    win.destroy();

    // BGRA from Electron, RGBA for the encoder.
    const rgba = frames.map((bgra) => {
      const out = new Uint8Array(bgra.length);
      for (let i = 0; i < bgra.length; i += 4) {
        out[i] = bgra[i + 2];
        out[i + 1] = bgra[i + 1];
        out[i + 2] = bgra[i];
        out[i + 3] = 255;
      }
      return out;
    });

    // One palette for the whole film, sampled across it rather than from the
    // first frame, which would know nothing of the later screens.
    const sample = [];
    const step = Math.max(1, Math.floor(rgba.length / 12));
    for (let i = 0; i < rgba.length; i += step) sample.push(rgba[i]);
    const merged = new Uint8Array(sample.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of sample) {
      merged.set(f, at);
      at += f.length;
    }
    const palette = quantize(merged, COLOURS, { format: 'rgba4444' });

    const gif = GIFEncoder();
    for (const frame of rgba) {
      gif.writeFrame(applyPalette(frame, palette, 'rgba4444'), WIDTH, HEIGHT, {
        palette,
        delay: interval,
      });
    }
    gif.finish();

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(gif.bytes()));
    const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
    console.log(`\n${path.relative(process.cwd(), OUT)}  ${frames.length} frames, ${WIDTH}x${HEIGHT}, ${mb} MB`);
    app.quit();
  } catch (err) {
    console.error('make-gif failed:', err);
    app.exit(1);
  }
});

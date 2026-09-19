// Screenshot every Shelf route using Electron's own renderer.
//
// Useful for README images and for eyeballing a redesign without a browser.
// Needs the dev servers running (npm run dev:server + npm run dev:client).
//
//   npx electron scripts/snap.cjs
//
// Env: SNAP_BASE (default http://localhost:5180), SNAP_OUT (default ./snaps),
//      SNAP_W / SNAP_H (viewport), SNAP_WAIT (ms after load), SNAP_ROUTES
//      ("name:/path,name:/path" -- {show} and {movie} are replaced with real ids),
//      SNAP_SCROLL (pixels to scroll first -- a window cannot be taller than the
//      screen, so this is how to photograph something further down a page).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.SNAP_BASE || 'http://localhost:5180';
const OUT = path.resolve(process.env.SNAP_OUT || path.join(__dirname, '..', 'snaps'));
const WIDTH = Number(process.env.SNAP_W) || 1440;
const HEIGHT = Number(process.env.SNAP_H) || 1000;
const WAIT = Number(process.env.SNAP_WAIT) || 1800;
const SCROLL = Number(process.env.SNAP_SCROLL) || 0;

const DEFAULT_ROUTES =
  'library:/,show:/show/{show},movie:/movie/{movie},upnext:/up-next,missing:/missing,' +
  'organize:/organize,stats:/stats,wrapped:/wrapped,settings:/settings';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });

    const getJson = async (p) => (await fetch(BASE + '/api' + p)).json();
    const shows = await getJson('/shows');
    const movies = await getJson('/movies');
    const show = shows.find((s) => s.title === 'Severance') || shows[0];
    const movie = movies.find((m) => m.collection_name) || movies[0];

    const routes = (process.env.SNAP_ROUTES || DEFAULT_ROUTES).split(',').map((entry) => {
      const [name, ...rest] = entry.split(':');
      const url = rest
        .join(':')
        .replace('{show}', show?.id ?? '')
        .replace('{movie}', movie?.id ?? '');
      return { name, url };
    });

    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#08090c',
      webPreferences: { backgroundThrottling: false },
    });

    // SNAP_THEME=<preset id> renders every route in that theme. Without it the
    // saved theme is cleared, so runs are deterministic (Projection default).
    // This localStorage belongs to the snapper's own profile, never the app's.
    await win.loadURL(BASE + '/');
    await win.webContents.executeJavaScript(
      process.env.SNAP_THEME
        ? `localStorage.setItem('shelf.theme.v2', ${JSON.stringify(
            JSON.stringify({ presetId: process.env.SNAP_THEME })
          )})`
        : `localStorage.removeItem('shelf.theme.v2')`
    );

    for (const route of routes) {
      await win.loadURL(BASE + route.url);
      await sleep(WAIT);
      if (SCROLL) {
        await win.webContents.executeJavaScript(`window.scrollTo(0, ${SCROLL})`);
        await sleep(600);
      }

      let image = await win.webContents.capturePage();
      if (image.isEmpty()) {
        // Some GPU/driver setups will not paint a hidden window.
        win.showInactive();
        await sleep(400);
        image = await win.webContents.capturePage();
      }
      const file = path.join(OUT, `${route.name}.png`);
      fs.writeFileSync(file, image.toPNG());
      console.log(`snap ${route.name} -> ${file}`);
    }
  } catch (err) {
    console.error('snap failed:', err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});

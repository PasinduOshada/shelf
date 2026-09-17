// Electron entry point.
//
// Hosts the same Express app the web build uses, on an ephemeral port, and
// points a BrowserWindow at it. The server never learns it is inside Electron
// beyond the writable paths it is handed below.
//
// When "keep running in the background" is on, closing the window leaves
// Shelf in the system tray so watched folders keep being organised, and it can
// start with Windows (hidden, straight to the tray).
const { app, BrowserWindow, shell, dialog, ipcMain, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('node:path');

// Redirect all writable state into userData BEFORE the server module loads.
// Note: userData is derived from package.json `productName`.
const userData = app.getPath('userData');
process.env.SHELF_DATA_DIR = userData;
process.env.SHELF_DB_PATH = path.join(userData, 'shelf.db');
process.env.SHELF_UPLOADS_DIR = path.join(userData, 'uploads');
process.env.SHELF_CLIENT_DIST = path.join(__dirname, 'client', 'dist');

const ICON = path.join(__dirname, 'build', 'icon.png');
const startHidden = process.argv.includes('--hidden');

let mainWindow = null;
let server = null;
let port = null;
let tray = null;
let quitting = false;
let settings = null; // { get, set } from the server's db module
let toldAboutTray = false;

// One Shelf at a time: a second launch just brings the window forward.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

const background = () => settings?.get('app.background') === '1';

async function startServer() {
  // The server is ESM; Electron's main process is CJS.
  const { createApp } = await import('./server/src/app.js');
  const { scheduleMetadataRefresh } = await import('./server/src/tmdb.js');
  const { scheduleAutoOrganize, autoEvents } = await import('./server/src/autoOrganize.js');
  const { getSetting, setSetting } = await import('./server/src/db.js');
  const { setTrashHandler } = await import('./server/src/trash.js');
  const { scheduleAiringAlerts, airingEvents } = await import('./server/src/airing.js');
  const { scheduleProbe } = await import('./server/src/mediainfo.js');
  const { scheduleTraktSync } = await import('./server/src/importers/trakt.js');
  const { playbackEvents } = await import('./server/src/playback.js');
  settings = { get: getSetting, set: setSetting };
  // The Recycle Bin, through Windows itself.
  setTrashHandler((p) => shell.trashItem(p));
  autoEvents.on('run', notifyRun);
  airingEvents.on('aired', notifyAired);
  playbackEvents.on('watched', (e) => notify(`Marked ${e.label || 'it'} as watched.`, '/up-next'));
  const expressApp = createApp();

  return new Promise((resolve, reject) => {
    // Port 0 = let the OS pick a free one, so two copies never collide.
    server = expressApp.listen(0, '127.0.0.1', () => {
      scheduleMetadataRefresh();
      scheduleAutoOrganize();
      scheduleAiringAlerts();
      scheduleProbe();
      scheduleTraktSync();
      resolve(server.address().port);
    });
    server.on('error', reject);
  });
}

function createWindow({ show = true, route = '/' } = {}) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#0a0a0e',
    show: false,
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}${route}`);

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (quitting || !background()) return;
    // Stay in the tray so watched folders keep being organised.
    event.preventDefault();
    mainWindow.hide();
    ensureTray();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({
        title: 'Shelf is still running',
        body: 'It keeps organising your watched folders. Right-click the tray icon to quit.',
        icon: ICON,
      }).show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow(route) {
  if (!port) return;
  if (!mainWindow) {
    createWindow({ route: route || '/' });
    return;
  }
  if (route) mainWindow.loadURL(`http://127.0.0.1:${port}${route}`);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Shelf');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Shelf', click: () => showWindow() },
    { label: 'Organize downloads now', click: () => runNow() },
    { label: 'Organizer', click: () => showWindow('/organize') },
    { type: 'separator' },
    { label: 'Quit Shelf', click: () => quit() },
  ]));
  tray.on('click', () => showWindow());
}

async function runNow() {
  const { runAutoOrganize } = await import('./server/src/autoOrganize.js');
  const entry = await runAutoOrganize({ manual: true });
  if (!entry && Notification.isSupported()) {
    new Notification({ title: 'Shelf', body: 'Nothing to organize right now.', icon: ICON }).show();
  } else if (entry && !entry.moved && !entry.error && Notification.isSupported()) {
    new Notification({
      title: 'Shelf',
      body: entry.waiting ? `${entry.waiting} file${entry.waiting === 1 ? '' : 's'} waiting for your review.` : 'Your downloads are already organised.',
      icon: ICON,
    }).show();
  }
}

function notify(body, route) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: 'Shelf', body, icon: ICON });
  if (route) note.on('click', () => showWindow(route));
  note.show();
}

function notifyAired(list) {
  if (!list?.length) return;
  if (list.length === 1) {
    const e = list[0];
    const code = `S${String(e.season_number).padStart(2, '0')}E${String(e.episode_number).padStart(2, '0')}`;
    notify(`New episode: ${e.show_title} ${code}${e.episode_title ? ` · ${e.episode_title}` : ''}`, `/show/${e.show_id}`);
  } else {
    const shows = [...new Set(list.map((e) => e.show_title))];
    notify(`${list.length} new episodes: ${shows.slice(0, 3).join(', ')}${shows.length > 3 ? '…' : ''}`, '/up-next');
  }
}

function notifyRun(entry) {
  if (!Notification.isSupported() || !entry) return;
  let body = null;
  if (entry.error) body = `Couldn't organise your downloads: ${entry.error}`;
  else if (entry.moved) {
    const names = entry.titles.slice(0, 3).join(', ');
    body = `Organised ${entry.moved} file${entry.moved === 1 ? '' : 's'}${names ? `: ${names}` : ''}.`;
    if (entry.waiting) body += ` ${entry.waiting} waiting for review.`;
  } else if (entry.waiting && !entry.manual) {
    body = `${entry.waiting} download${entry.waiting === 1 ? '' : 's'} need${entry.waiting === 1 ? 's' : ''} your review.`;
  }
  if (!body) return;
  const note = new Notification({ title: 'Shelf', body: entry.batch_id ? `${body} Click to review or undo.` : body, icon: ICON });
  note.on('click', () => showWindow(entry.batch_id ? `/organize?batch=${entry.batch_id}` : '/organize'));
  note.show();
}

function quit() {
  quitting = true;
  app.quit();
}

function applyLoginItem(openAtLogin) {
  // Packaged builds only: a dev run would register electron.exe itself.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] });
}

// Native folder picker, so choosing folders doesn't rely on the web fallback.
ipcMain.handle('shelf:pickFolder', async (_event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: typeof title === 'string' ? title.slice(0, 80) : 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Choosing a video player program.
ipcMain.handle('shelf:pickPlayer', async () => {
  const filters = process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a video player',
    defaultPath: process.platform === 'darwin' ? '/Applications' : process.env.ProgramFiles,
    properties: ['openFile'],
    filters,
  });
  return result.canceled ? null : result.filePaths[0];
});

// ---------------------------------------------------------------- updates

// Published installers are checked on start and every six hours. Updates
// download in the background and install when Shelf next quits.
let updateState = { status: 'idle' };

function setupUpdates() {
  if (!app.isPackaged) {
    updateState = { status: 'unavailable', message: 'Updates are checked in the installed app' };
    return null;
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => (updateState = { status: 'checking' }));
  autoUpdater.on('update-not-available', () => (updateState = { status: 'current', checked_at: new Date().toISOString() }));
  autoUpdater.on('update-available', (i) => (updateState = { status: 'downloading', version: i.version }));
  autoUpdater.on('download-progress', (p) => (updateState = { ...updateState, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    updateState = { status: 'ready', version: i.version };
    notify(`Shelf ${i.version} is ready. It installs when you quit Shelf.`);
  });
  autoUpdater.on('error', (err) => {
    // No published releases yet, offline, etc.: never bother the user.
    updateState = { status: 'error', message: String(err?.message || err).split('\n')[0].slice(0, 200) };
  });
  return autoUpdater;
}

let updater = null;

function checkForUpdates() {
  if (!updater || settings?.get('app.autoUpdate') === '0') return;
  updater.checkForUpdates().catch(() => {});
}

ipcMain.handle('shelf:updates', () => ({
  ...updateState,
  version: updateState.version || null,
  current: app.getVersion(),
  enabled: settings?.get('app.autoUpdate') !== '0',
}));

ipcMain.handle('shelf:checkUpdates', async () => {
  if (!updater) return { ...updateState, current: app.getVersion() };
  await updater.checkForUpdates().catch(() => {});
  return { ...updateState, current: app.getVersion() };
});

ipcMain.handle('shelf:setAutoUpdate', (_event, on) => {
  settings.set('app.autoUpdate', on ? '1' : '0');
  return { enabled: on };
});

ipcMain.handle('shelf:installUpdate', () => {
  if (updateState.status !== 'ready' || !updater) return false;
  quitting = true;
  updater.quitAndInstall();
  return true;
});

// Background running and start-with-Windows.
ipcMain.handle('shelf:getDesktop', () => ({
  background: background(),
  openAtLogin: app.isPackaged ? app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin : false,
  canStartAtLogin: app.isPackaged,
}));

ipcMain.handle('shelf:setDesktop', (_event, patch = {}) => {
  if (typeof patch.background === 'boolean') {
    settings.set('app.background', patch.background ? '1' : '0');
    if (patch.background) ensureTray();
  }
  if (typeof patch.openAtLogin === 'boolean') {
    applyLoginItem(patch.openAtLogin);
    // Starting with Windows only makes sense if Shelf then stays in the tray.
    if (patch.openAtLogin) settings.set('app.background', '1');
  }
  return {
    background: background(),
    openAtLogin: app.isPackaged ? app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin : false,
    canStartAtLogin: app.isPackaged,
  };
});

app.whenReady().then(async () => {
  if (!primary) return;
  try {
    port = await startServer();
  } catch (err) {
    dialog.showErrorBox('Shelf failed to start', String(err?.message || err));
    quit();
    return;
  }
  if (background()) ensureTray();
  // Started with Windows: go straight to the tray.
  if (!(startHidden && background())) createWindow();

  updater = setupUpdates();
  setTimeout(checkForUpdates, 30_000);
  setInterval(checkForUpdates, 6 * 60 * 60_000).unref?.();
});

app.on('activate', () => showWindow());

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (background() && !quitting) return;
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});

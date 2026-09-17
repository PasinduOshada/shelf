// Send a file to the Recycle Bin (Windows), Trash (macOS) or the desktop
// trash (Linux). Never a permanent delete: the user can always restore it.
//
// The desktop app swaps in Electron's shell.trashItem; the web build uses the
// operating system's own tools. Paths are passed through an environment
// variable, never pasted into a command line.
import { execFile } from 'node:child_process';

let handler = null;

export function setTrashHandler(fn) {
  handler = fn;
}

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 }, (err, _out, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve()
    );
  });
}

export async function moveToTrash(path) {
  if (handler) return handler(path);
  if (process.platform === 'win32') {
    const script =
      'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:SHELF_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { SHELF_TRASH_PATH: path });
  }
  if (process.platform === 'darwin') {
    return run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete POSIX file (item 1 of argv)', '-e', 'end run', path]);
  }
  return run('gio', ['trash', path]);
}

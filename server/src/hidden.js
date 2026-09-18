// Hidden files and folders are hidden on purpose: a scan walks straight past
// them, and so does an organize run.
//
// Windows keeps "hidden" in a file attribute that Node cannot read through
// readdir or stat, so one `dir /a:h` pass per library collects them up front —
// a single native traversal, rather than a shell call per folder. Everywhere
// else, and for names like ".sync" on Windows too, a leading dot is the rule.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Every hidden file and folder under `root`, lowercased, as full paths. */
function hiddenUnder(root) {
  const found = new Set();
  if (process.platform !== 'win32') return found;
  try {
    const out = execFileSync(
      'cmd',
      ['/d', '/u', '/c', 'dir', '/a:h', '/b', '/s', resolve(root)],
      { encoding: 'buffer', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
    );
    // /u makes cmd write UTF-16, so names with accents survive the round trip.
    for (const line of out.toString('utf16le').split(/\r?\n/)) {
      const path = line.trim();
      if (path) found.add(path.toLowerCase());
    }
  } catch {
    // `dir` exits non-zero when it finds nothing, which is the common case.
  }
  return found;
}

/**
 * A `(path, name) -> boolean` test for the roots given, built once per scan.
 * Folders are tested as well as files, so nothing inside a hidden folder is
 * reached at all.
 */
export function hiddenFilter(roots) {
  const hidden = new Set();
  for (const root of roots) {
    for (const path of hiddenUnder(root)) hidden.add(path);
  }
  return (path, name) => name.startsWith('.') || hidden.has(String(path).toLowerCase());
}

/** Used where a scan has no filter of its own (tests, non-library walks). */
export const nothingHidden = (_path, name) => name.startsWith('.');

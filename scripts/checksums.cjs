// Write SHA-256 sums for the built installers, and the release notes to go
// with them.
//
//   npm run checksums          (runs automatically at the end of npm run dist)
//
// Shelf is not code signed - a certificate costs more than this project makes -
// so Windows shows a SmartScreen warning on first run. Checksums are what an
// unsigned download can offer instead: anyone can confirm the file they got is
// the file that was built.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const OUT_DIR = path.join(__dirname, '..', 'dist-desktop');
const { version } = require('../package.json');

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const artifacts = fs
  .readdirSync(OUT_DIR)
  .filter((name) => name.endsWith('.exe'))
  .sort();

if (!artifacts.length) {
  console.error('No .exe in dist-desktop. Run npm run dist first.');
  process.exit(1);
}

const sums = artifacts.map((name) => ({ name, hash: sha256(path.join(OUT_DIR, name)) }));

// The format `sha256sum -c` and every checksum tool understands.
const sumsFile = path.join(OUT_DIR, 'SHA256SUMS.txt');
fs.writeFileSync(sumsFile, sums.map((s) => `${s.hash}  ${s.name}\n`).join(''));

const notes = `## Shelf ${version}

Windows, 64-bit. Install with **Shelf Setup ${version}.exe**, or run **Shelf ${version}.exe**
without installing anything.

### Windows will warn you

Shelf is not code signed, so Windows SmartScreen shows **"Windows protected your PC"** the
first time you run it. That warning means the file is unsigned, not that anything is wrong
with it. To continue: click **More info**, then **Run anyway**.

A signing certificate costs more per year than this project takes in donations, so instead
every file is published with its SHA-256 below. You can check the one you downloaded:

\`\`\`powershell
Get-FileHash "Shelf Setup ${version}.exe" -Algorithm SHA256
\`\`\`

${sums.map((s) => `- \`${s.hash}\`  ${s.name}`).join('\n')}
`;

const notesFile = path.join(OUT_DIR, 'RELEASE-NOTES.md');
fs.writeFileSync(notesFile, notes);

console.log('Wrote:');
console.log(' ', path.relative(process.cwd(), sumsFile));
console.log(' ', path.relative(process.cwd(), notesFile), '(paste into the GitHub release)');
console.log();
for (const s of sums) console.log(` ${s.hash}  ${s.name}`);

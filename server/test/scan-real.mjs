// Manual check: scan real folders and print what the scanner made of them.
//
//   node test/scan-real.mjs "D:/Media/TV" "D:/Media/Films"
//
// Writes to the database the SHELF_DB_PATH points at, so aim it at a scratch
// one: SHELF_DB_PATH=./tmp.db node test/scan-real.mjs ...
import { addLibrary, scanLibraries } from '../src/scanner/scan.js';
import { db, setSetting } from '../src/db.js';

db.exec('DELETE FROM libraries');
// Folders to skip, e.g. SHELF_EXCLUDES="Captures,Home videos"
setSetting('scan.excludes', JSON.stringify((process.env.SHELF_EXCLUDES || '').split(',').filter(Boolean)));

const [tvRoot, movieRoot] = process.argv.slice(2);
if (!tvRoot && !movieRoot) {
  console.error('Usage: node test/scan-real.mjs "<TV folder>" "<films folder>"');
  process.exit(1);
}
if (tvRoot) addLibrary({ path: tvRoot, kind: 'tv', label: 'TV Series' });
if (movieRoot) addLibrary({ path: movieRoot, kind: 'movie', label: 'Movies' });

const stats = scanLibraries();
console.log('SCAN STATS:', JSON.stringify(stats));

const q = (sql) => db.prepare(sql).get();
console.log('\nshows      ', q('SELECT COUNT(*) c FROM shows').c);
console.log('episodes   ', q('SELECT COUNT(*) c FROM episodes').c);
console.log('movies     ', q('SELECT COUNT(*) c FROM movies').c);
console.log('collections', q('SELECT COUNT(*) c FROM collections').c);
console.log('files      ', q('SELECT COUNT(*) c FROM files').c);

console.log('\n--- Documentaries split into separate shows? ---');
for (const r of db.prepare(`
  SELECT s.title, COUNT(e.id) eps FROM shows s
  LEFT JOIN episodes e ON e.show_id = s.id
  WHERE s.folder_path LIKE '%Documentaries%'
  GROUP BY s.id ORDER BY s.title`).all()) {
  console.log(`  ${String(r.eps).padStart(3)} eps  ${r.title}`);
}

console.log('\n--- Collections ---');
for (const r of db.prepare(`
  SELECT c.name, COUNT(m.id) n FROM collections c
  LEFT JOIN movies m ON m.collection_id = c.id GROUP BY c.id ORDER BY n DESC`).all()) {
  console.log(`  ${r.n}  ${r.name}`);
}

console.log('\n--- Duplicate episode files ---');
for (const r of db.prepare(`
  SELECT s.title, f.parsed_season sn, f.parsed_episode en, COUNT(*) n
  FROM files f JOIN shows s ON s.id = f.show_id
  WHERE f.episode_id IS NOT NULL
  GROUP BY f.episode_id HAVING n > 1 ORDER BY n DESC LIMIT 10`).all()) {
  console.log(`  ${r.n}x  ${r.title} S${r.sn}E${r.en}`);
}

console.log('\n--- Gap detection ---');
const rows = db.prepare(`
  SELECT s.title, e.season_number sn, e.episode_number en
  FROM episodes e JOIN shows s ON s.id = e.show_id
  ORDER BY s.sort_title, e.season_number, e.episode_number`).all();
const bySeason = new Map();
for (const r of rows) {
  const key = `${r.title}||${r.sn}`;
  if (!bySeason.has(key)) bySeason.set(key, []);
  bySeason.get(key).push(r.en);
}
let gapCount = 0;
for (const [key, eps] of bySeason) {
  const [title, sn] = key.split('||');
  const have = new Set(eps);
  const missing = [];
  for (let i = 1; i <= Math.max(...eps); i++) if (!have.has(i)) missing.push(i);
  if (missing.length) {
    console.log(`  ${title} S${sn}: missing E${missing.join(', E')}`);
    gapCount++;
  }
}
console.log(`  (${gapCount} seasons with gaps)`);

console.log('\n--- Storage by show (top 8) ---');
for (const r of db.prepare(`
  SELECT s.title, ROUND(SUM(f.size_bytes)/1073741824.0, 1) gb, COUNT(f.id) n
  FROM files f JOIN shows s ON s.id = f.show_id
  GROUP BY s.id ORDER BY SUM(f.size_bytes) DESC LIMIT 8`).all()) {
  console.log(`  ${String(r.gb).padStart(6)} GB  ${String(r.n).padStart(3)} files  ${r.title}`);
}

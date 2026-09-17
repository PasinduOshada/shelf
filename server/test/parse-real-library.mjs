// Validation harness: run the parser over the real library and report accuracy.
import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseFilename, parseFolderName, isVideoFile } from '../src/scanner/parse.js';

// Usage: node test/parse-real-library.mjs "<TV folder>" "<films folder>"
const [TV_ROOT, MOVIE_ROOT] = process.argv.slice(2);
if (!TV_ROOT || !MOVIE_ROOT) {
  console.error('Usage: node test/parse-real-library.mjs "<TV folder>" "<films folder>"');
  process.exit(1);
}

function walk(dir, depth = 0) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full, depth + 1));
    else out.push(full);
  }
  return out;
}

console.log('='.repeat(70));
console.log('TV SERIES PARSING');
console.log('='.repeat(70));

let tvTotal = 0;
let tvOk = 0;
const tvFails = [];

for (const seriesDir of readdirSync(TV_ROOT, { withFileTypes: true })) {
  if (!seriesDir.isDirectory()) continue;
  const seriesPath = join(TV_ROOT, seriesDir.name);
  const folder = parseFolderName(seriesDir.name);

  for (const f of walk(seriesPath)) {
    if (!isVideoFile(basename(f))) continue;
    tvTotal++;

    // Season hint from the "Season N" folder the file sits in.
    const seasonMatch = f.match(/Season (\d+)/i);
    const defaultSeason = seasonMatch ? Number(seasonMatch[1]) : 1;

    const p = parseFilename(basename(f), { folderTitle: seriesDir.name, defaultSeason });

    if (p.isEpisode && p.season != null && p.episode != null && p.title) {
      tvOk++;
    } else {
      tvFails.push({ folder: seriesDir.name, file: basename(f), parsed: p });
    }
  }
}

console.log(`Parsed ${tvOk}/${tvTotal} episode files (${((tvOk / tvTotal) * 100).toFixed(1)}%)`);
if (tvFails.length) {
  console.log(`\nFAILURES (${tvFails.length}):`);
  for (const f of tvFails.slice(0, 25)) {
    console.log(`  [${f.folder}] ${f.file}`);
    console.log(`     -> title=${JSON.stringify(f.parsed.title)} S=${f.parsed.season} E=${f.parsed.episode}`);
  }
}

console.log('\n' + '='.repeat(70));
console.log('SAMPLE TV PARSES');
console.log('='.repeat(70));
const samples = [
  '[MPM-EZI]The.End.of.the.Fucking.World.S01E01.720p.10bit.x265.mkv',
  'Fargo.S01E01.720p.BluRay.x264-GalaxyTV.mkv',
  '[TIF]_S02_E01_Fargo_720p_10bit.mkv',
  'Alexander The Making of a God - S01E01 - The Boy King.mkv',
  '[MPM] Oggy and the Cockroaches - Bitter Chocolate (s01e01).mp4',
  '[MPM-EZI] The Bondsman E01 [720p].mkv',
  'Vikings.S06E03.720p.HDTV.x265.[@SeriesLand4U] (1).mkv',
  'A_Shop_for_Killers_A_K_A_Sarinjaui_Syopingmol_S01E01_KOREAN_720p.mkv',
  'Hijack 2023 S02E05 720p 10bit WEBRip 2CH x265 HEVC-PSA.mkv',
  'The.Last.Frontier.2025.S01E06.720p.10bit.WEBRip.2CH.x265.HEV.mkv',
  'Squid.Game.S03E01.DUAL-AUDIO.KOR-ENG.720p.10bit.WEBRip.2CH.x.mkv',
];
for (const s of samples) {
  const p = parseFilename(s);
  console.log(`${s}\n   -> ${JSON.stringify(p.title)} S${p.season}E${p.episode} ${p.quality || ''} ${p.codec || ''}`);
}

console.log('\n' + '='.repeat(70));
console.log('MOVIE PARSING');
console.log('='.repeat(70));

let mvTotal = 0;
let mvOk = 0;
const mvFails = [];

for (const f of walk(MOVIE_ROOT)) {
  const name = basename(f);
  if (!isVideoFile(name)) continue;
  mvTotal++;
  const p = parseFilename(name);
  if (p.title && p.title.length > 1) mvOk++;
  else mvFails.push({ file: name, parsed: p });
}

console.log(`Parsed ${mvOk}/${mvTotal} movie files (${((mvOk / mvTotal) * 100).toFixed(1)}%)`);
if (mvFails.length) {
  console.log(`\nFAILURES (${mvFails.length}):`);
  for (const f of mvFails.slice(0, 20)) {
    console.log(`  ${f.file} -> ${JSON.stringify(f.parsed.title)}`);
  }
}

console.log('\n' + '='.repeat(70));
console.log('SAMPLE MOVIE PARSES');
console.log('='.repeat(70));
const movieSamples = [
  'Anaconda.2025.720p.10bit.WEBRip.6CH.x265.HEVC-PSA.mkv',
  '[MPM] Ed Kemper 2025 1080p WEB-DL.mp4',
  'Kingdom_Of_Heaven_2005_DIRECTOR S_CUT_ROADSHOW_BLURAY_720p_B.mp4',
  '@Madhushan wijesingheᴺˢ Missing.You.2016.720p.NF.WEB-DL.x265.mkv',
  '[MPM-EZI] Happy.Gilmore.1996.720p.Bluray.x265.10Bit-Pahe.in.mkv',
  'The.Godfather.Part.II.1974.REMASTERED.720p.10bit.BluRay.mkv',
  'Cold Case (2021) Malayalam 720p HDRIp.mkv',
  'Mission.Impossible.-.The.Final.Reckoning.2025.720p.AMZN.WEB-.mkv',
];
for (const s of movieSamples) {
  const p = parseFilename(s);
  console.log(`${s}\n   -> ${JSON.stringify(p.title)} (${p.year}) ${p.quality || ''} ${p.codec || ''}`);
}

console.log('\n' + '='.repeat(70));
console.log('FOLDER NAME PARSING');
console.log('='.repeat(70));
for (const d of readdirSync(TV_ROOT, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const r = parseFolderName(d.name);
  if (r.title !== d.name) console.log(`  ${d.name.padEnd(42)} -> ${JSON.stringify(r.title)}${r.year ? ` (${r.year})` : ''}`);
}

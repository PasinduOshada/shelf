import { Router } from 'express';
import { playerSettings, setPlayer, playFile, revealFile, findFile } from '../player.js';
import {
  subtitleSettings, setSubtitlePrefs, setApiKey, signIn, signOut, searchSubtitles, downloadSubtitle,
  localSubtitles,
} from '../subtitles.js';

const router = Router();

const target = (src) => ({
  fileId: src.fileId || null,
  episodeId: src.episodeId || null,
  movieId: src.movieId || null,
});

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    res.status(err.status || 400).json({ error: String(err?.message || err) });
  }
};

// ---------------------------------------------------------------- player

router.get('/player', handle(() => playerSettings()));
router.put('/player', handle((req) => setPlayer(req.body?.path ?? null)));
router.post('/play', handle((req) => playFile(target(req.body || {}))));
router.post('/reveal', handle((req) => revealFile(target(req.body || {}))));

// ---------------------------------------------------------------- subtitles

router.get('/subtitles/settings', handle(() => subtitleSettings()));
router.patch('/subtitles/settings', handle((req) => setSubtitlePrefs(req.body || {})));
router.post('/subtitles/key', handle((req) => setApiKey(req.body?.key)));
router.post('/subtitles/login', handle((req) => signIn(req.body?.username, req.body?.password)));
router.post('/subtitles/logout', handle(() => signOut()));

router.get('/subtitles/local', handle((req) => localSubtitles(findFile(target(req.query)).path)));
router.get('/subtitles/search', handle((req) =>
  searchSubtitles(target(req.query), { languages: req.query.languages })
));
router.post('/subtitles/download', handle((req) =>
  downloadSubtitle(target(req.body || {}), {
    subtitleFileId: req.body?.subtitleFileId,
    language: req.body?.language,
  })
));

export default router;

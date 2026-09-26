import { Router } from 'express';
import {
  DEFAULT_OPTIONS, normalizeOptions, organizeJob, currentPlan, startPlan, startApply, startUndo,
  organizeHistory,
} from '../organizer.js';
import { scanLibraries } from '../scanner/scan.js';
import { getSetting, setSetting } from '../db.js';
import { autoStatus, setAutoConfig, runAutoOrganize } from '../autoOrganize.js';
import { fetchSubtitlesFor } from '../autoSubtitles.js';
import { startProbe } from '../mediainfo.js';

const router = Router();

const fail = (res, err, status = 400) => res.status(status).json({ error: String(err?.message || err) });

/** Defaults plus whatever the user chose last time. */
router.get('/organize/defaults', (_req, res) => {
  const last = JSON.parse(getSetting('organize.last', 'null') || 'null');
  res.json({
    options: normalizeOptions(last?.options || DEFAULT_OPTIONS),
    source: last?.source || '',
    tvRoot: last?.tvRoot || '',
    movieRoot: last?.movieRoot || '',
  });
});

/** Start a dry run. Reads folders, never changes them. */
router.post('/organize/preview', (req, res) => {
  const { source, sources, tvRoot, movieRoot, options, remember = true } = req.body || {};
  try {
    const job = startPlan({ source, sources, tvRoot, movieRoot, options });
    // Quick actions (watched folders, library tidy) don't overwrite the form.
    if (remember && source) {
      setSetting('organize.last', JSON.stringify({ source, tvRoot, movieRoot, options: normalizeOptions(options) }));
    }
    res.json(job);
  } catch (err) {
    fail(res, err);
  }
});

router.get('/organize/job', (_req, res) => {
  res.json(organizeJob());
});

/** The finished preview. */
router.get('/organize/plan', (_req, res) => {
  const plan = currentPlan();
  if (!plan) return res.status(404).json({ error: 'No preview yet' });
  res.json(plan);
});

/**
 * Carry out part of a preview. Requires an explicit confirm flag and a list
 * of chosen files, so a stray request can never move anything.
 */
router.post('/organize/apply', (req, res) => {
  const { planId, ids, confirm = false } = req.body || {};
  if (confirm !== true) return fail(res, 'confirm: true is required to move files');
  try {
    res.json(startApply({
      planId,
      ids,
      // Paths changed on disk; refresh the index so the library stays truthful.
      afterApply: async (_plan, result) => {
        await scanLibraries();
        startProbe();
        fetchSubtitlesFor(result.moved_paths);
      },
    }));
  } catch (err) {
    fail(res, err);
  }
});

router.post('/organize/undo', (req, res) => {
  const { batchId } = req.body || {};
  if (!batchId) return fail(res, 'batchId is required');
  try {
    res.json(startUndo(batchId, async () => scanLibraries()));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/organize/history', (req, res) => {
  res.json(organizeHistory(Math.min(Number(req.query.limit) || 20, 100)));
});

// ---------------------------------------------------------------- watched folders

router.get('/organize/auto', (_req, res) => {
  res.json(autoStatus());
});

router.put('/organize/auto', (req, res) => {
  try {
    res.json(setAutoConfig(req.body || {}));
  } catch (err) {
    fail(res, err);
  }
});

/** Run the watched folders now. Waits for the pass so the UI can show the result. */
router.post('/organize/auto/run', async (_req, res) => {
  try {
    const entry = await runAutoOrganize({ manual: true });
    if (!entry) return fail(res, 'Nothing to do: add a watched folder, or wait for the current job to finish', 409);
    res.json({ entry, status: autoStatus() });
  } catch (err) {
    fail(res, err, 500);
  }
});

export default router;

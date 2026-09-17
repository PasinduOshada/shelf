import { Router } from 'express';
import { cacheImage, isValidImageRequest } from '../images.js';

const router = Router();

// GET /img/w342/abc123.jpg -> served from the local cache, fetched once on a miss.
router.get('/:size/:file', async (req, res) => {
  const { size, file } = req.params;
  if (!isValidImageRequest(size, file)) return res.status(400).end();

  try {
    const path = await cacheImage(size, file);
    res.set({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.sendFile(path);
  } catch (err) {
    // Offline with nothing cached lands here too; the client falls back to the
    // generated poster.
    // TMDB's CDN answers an unknown file with a 4xx; only network trouble is a 502.
    res.status(err.status >= 400 && err.status < 500 ? 404 : 502).end();
  }
});

export default router;

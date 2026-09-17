import { createApp } from './app.js';
import { scheduleMetadataRefresh } from './tmdb.js';
import { scheduleAutoOrganize } from './autoOrganize.js';
import { scheduleAiringAlerts } from './airing.js';
import { scheduleProbe } from './mediainfo.js';
import { scheduleTraktSync } from './importers/trakt.js';

const PORT = Number(process.env.PORT) || 4100;
// Loopback only: the API can move files and launch programs.
const HOST = process.env.HOST || '127.0.0.1';

createApp().listen(PORT, HOST, () => {
  console.log(`Shelf server -> http://${HOST}:${PORT}`);
  scheduleMetadataRefresh();
  scheduleAutoOrganize();
  scheduleAiringAlerts();
  scheduleProbe();
  scheduleTraktSync();
});

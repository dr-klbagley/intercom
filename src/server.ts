import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ScriptGatherer } from './gather.js';
import { hermesClient, hermesReachable } from './hermes.js';
import { sidecarClient } from './sidecar.js';
import { AudioStore, TurnRunner } from './turns.js';

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const cfg = loadConfig();
const hermesOpts = {
  url: cfg.hermesUrl, key: cfg.hermesKey, profile: cfg.hermesProfile, timeoutMs: cfg.hermesTimeoutMs,
  model: cfg.hermesModel, provider: cfg.hermesProvider,
};
const speech = sidecarClient(cfg.sidecarUrl);
const audio = new AudioStore();
const gatherer = new ScriptGatherer({
  scriptsDir: cfg.scriptsDir,
  python: cfg.gatherPython,
  digestScript: cfg.digestScript,
  calendarScript: cfg.calendarScript,
  log: (line) => console.log(new Date().toISOString(), line),
});

// Keep mail, calendar and the digests warm during waking hours, so most questions skip the fetch (spec §7).
if (cfg.prefetchMinutes > 0) {
  const tick = () => {
    const h = new Date().getHours();
    if (h >= cfg.prefetchHours[0] && h < cfg.prefetchHours[1]) void gatherer.prefetch();
  };
  setTimeout(tick, 5_000);
  setInterval(tick, cfg.prefetchMinutes * 60_000).unref();
}

const runner = new TurnRunner({
  speech,
  ask: hermesClient(hermesOpts),
  gatherer,
  audio,
  voice: cfg.voice,
  speed: cfg.speed,
  // Timing only: no transcripts or audio in logs (spec §12).
  log: (line) => console.log(new Date().toISOString(), line),
});

const app = createApp({
  runner,
  audio,
  allowedLogin: cfg.allowedLogin,
  devTrustLocal: cfg.devTrustLocal,
  webDir: cfg.webDir,
  ortDir: path.join(path.dirname(cfg.webDir), 'node_modules/onnxruntime-web/dist'),
  health: async () => {
    const [sidecar, hermes] = await Promise.all([speech.healthy(), hermesReachable(hermesOpts)]);
    return { server: true, sidecar, hermes };
  },
});

// Pre-record the fillers once the speech sidecar is up, so they play instantly.
void (async () => {
  for (let i = 0; i < 30; i++) {
    if (await speech.healthy()) { await runner.warmFillers().catch(() => {}); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
})();

app.listen(cfg.port, '127.0.0.1', () => console.log(`Intercom listening on http://127.0.0.1:${cfg.port}`));

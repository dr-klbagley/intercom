import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ScriptGatherer } from './gather.js';
import { hermesClient, hermesReachable } from './hermes.js';
import { sidecarClient } from './sidecar.js';
import { AudioStore, TurnRunner } from './turns.js';

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const cfg = loadConfig();
const hermesOpts = { url: cfg.hermesUrl, key: cfg.hermesKey, profile: cfg.hermesProfile, timeoutMs: cfg.hermesTimeoutMs };
const speech = sidecarClient(cfg.sidecarUrl);
const audio = new AudioStore();
const runner = new TurnRunner({
  speech,
  ask: hermesClient(hermesOpts),
  gatherer: new ScriptGatherer({
    scriptsDir: cfg.scriptsDir,
    python: cfg.gatherPython,
    digestScript: cfg.digestScript,
  }),
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
  health: async () => {
    const [sidecar, hermes] = await Promise.all([speech.healthy(), hermesReachable(hermesOpts)]);
    return { server: true, sidecar, hermes };
  },
});

app.listen(cfg.port, '127.0.0.1', () => console.log(`Intercom listening on http://127.0.0.1:${cfg.port}`));

import { randomUUID } from 'node:crypto';
import express from 'express';
import { requireKevin } from './auth.js';
import type { ActionStore } from './actions.js';
import type { AudioStore, TurnEvent, TurnRunner } from './turns.js';

export interface AppDeps {
  runner: TurnRunner;
  audio: AudioStore;
  allowedLogin: string;
  devTrustLocal: boolean;
  webDir: string;
  /** onnxruntime-web's dist folder, served at /vendor/ort for the wake word. */
  ortDir?: string;
  health: () => Promise<Record<string, boolean>>;
  /** Phase 2 (spec §14), only when INTERCOM_ACTIONS=1. */
  actions?: ActionStore;
  /** Synthesizes a short line into the audio store; returns its id. */
  speak?: (text: string) => Promise<string | undefined>;
}

const ID = /^[\w-]{1,64}$/;

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', async (_req, res) => {
    const checks = await deps.health();
    res.status(Object.values(checks).every(Boolean) ? 200 : 503).json({ ok: Object.values(checks).every(Boolean), ...checks });
  });

  const api = express.Router();
  api.use(requireKevin({ allowedLogin: deps.allowedLogin, devTrustLocal: deps.devTrustLocal }));

  api.get('/status', async (_req, res) => res.json(await deps.health()));

  // A turn: raw audio body (audio/*) or JSON {text}. Streams NDJSON TurnEvents.
  api.post(
    '/turn',
    express.raw({ type: ['audio/*', 'video/webm', 'video/mp4', 'application/octet-stream'], limit: '15mb' }),
    express.json({ limit: '32kb' }),
    async (req, res) => {
      const device = String(req.query.device ?? '');
      const conversation = String(req.query.conversation ?? '');
      const turnId = String(req.query.turn ?? randomUUID());
      if (![device, conversation, turnId].every((v) => ID.test(v))) return void res.status(400).json({ error: 'bad_ids' });
      const isAudio = Buffer.isBuffer(req.body) && req.body.length > 0;
      const text = !isAudio && typeof req.body?.text === 'string' ? req.body.text.slice(0, 2000) : undefined;
      if (!isAudio && !text) return void res.status(400).json({ error: 'no_input' });

      res.status(200).set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableFinished) abort.abort(); });
      const emit = (e: TurnEvent) => { if (!res.writableEnded) res.write(JSON.stringify(e) + '\n'); };
      try {
        await deps.runner.run(
          { turnId, device, conversation, text, audio: isAudio ? req.body : undefined, mime: req.header('Content-Type') ?? '', speak: req.query.mute !== '1' },
          emit,
          abort.signal,
        );
      } catch (err) {
        emit({ type: 'error', message: (err as Error).message });
      }
      res.end();
    },
  );

  api.get('/audio/:id', (req, res) => {
    const buf = deps.audio.get(req.params.id);
    if (!buf) return void res.status(404).end();
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(buf);
  });

  // Siri Shortcut (spec §11): JSON in, JSON out, no audio. A device's conversation continues for 5 minutes.
  const shortcutConvos = new Map<string, { id: string; at: number }>();
  api.post('/ask', express.json({ limit: '32kb' }), async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 2000) : '';
    const device = ID.test(String(req.body?.device ?? '')) ? String(req.body.device) : 'shortcut';
    if (!text.trim()) return void res.status(400).json({ error: 'no_input' });
    let convo = shortcutConvos.get(device);
    if (!convo || Date.now() - convo.at > 5 * 60_000) convo = { id: randomUUID(), at: 0 };
    convo.at = Date.now();
    shortcutConvos.set(device, convo);
    const sentences: string[] = [];
    const cards: unknown[] = [];
    let error: string | undefined;
    await deps.runner.run({ turnId: randomUUID(), device, conversation: convo.id, text, speak: false }, (e) => {
      if (e.type === 'sentence') sentences.push(e.text);
      else if (e.type === 'card') cards.push(e.card);
      else if (e.type === 'error') error = e.spoken ?? e.message;
      else if (e.type === 'action') sentences.push('Open Intercom to confirm, sir.');
    });
    res.json({ speech: error ?? sentences.join(' '), cards });
  });

  // Phase 2: Kevin's tap on a confirmation card. Only the pending action's id (and his edits) come from
  // the page; what runs is what Intercom checked and showed (spec §14.3).
  api.post('/action/:id/:verb', express.json({ limit: '16kb' }), async (req, res) => {
    if (!deps.actions) return void res.status(404).json({ error: 'actions_off' });
    const { id, verb } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return void res.status(400).json({ error: 'bad_id' });
    if (verb === 'cancel') return void res.json({ ok: deps.actions.cancel(id), message: 'Cancelled.' });
    if (verb !== 'confirm') return void res.status(404).json({ error: 'not_found' });
    const edits = req.body && typeof req.body.edits === 'object' ? req.body.edits as Record<string, unknown> : {};
    const result = await deps.actions.confirm(id, edits);
    const audio = req.body?.mute ? undefined : await deps.speak?.(result.message).catch(() => undefined);
    res.json({ ...result, audio });
  });

  app.use('/api', api);
  if (deps.ortDir) app.use('/vendor/ort', express.static(deps.ortDir, { maxAge: '7d' }));
  app.use(express.static(deps.webDir, { index: 'index.html', maxAge: 0 }));
  return app;
}

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Gatherer } from '../src/gather.js';
import type { AskHermes, HermesEvent, HermesRequest } from '../src/hermes.js';
import type { Speech } from '../src/sidecar.js';
import { AudioStore, TurnRunner } from '../src/turns.js';

function setup(opts: { answer?: string[]; error?: string; transcript?: string; devTrustLocal?: boolean } = {}) {
  const asks: HermesRequest[] = [];
  const gathered: string[][] = [];
  const speech: Speech = {
    transcribe: vi.fn(async () => opts.transcript ?? 'Any emails from tier 1 today?'),
    speak: vi.fn(async (text: string) => Buffer.from(`wav:${text}`)),
    healthy: async () => true,
  };
  const ask: AskHermes = async function* (req): AsyncGenerator<HermesEvent> {
    asks.push(req);
    if (opts.error) { yield { type: 'error', message: opts.error }; return; }
    for (const d of opts.answer ?? ['One from Brent. ', 'He needs the deck today.']) yield { type: 'delta', text: d };
    yield { type: 'done', status: 'completed' };
  };
  const gatherer: Gatherer = {
    gather: async (topics) => { gathered.push([...topics]); return { context: 'INBOX: Brent Layton — deck', sources: ['mail'] }; },
  };
  const audio = new AudioStore();
  const runner = new TurnRunner({ speech, ask, gatherer, audio, voice: 'bm_george', speed: 1, statusDelayMs: 10_000 });
  const app = createApp({
    runner, audio, allowedLogin: 'kevin@example.com', devTrustLocal: opts.devTrustLocal ?? false, webDir: '/nonexistent',
    health: async () => ({ server: true, sidecar: true, hermes: true }),
  });
  return { app, asks, gathered, speech };
}

const KEVIN = { 'Tailscale-User-Login': 'kevin@example.com' };
const lines = (text: string) => text.trim().split('\n').map((l) => JSON.parse(l));

describe('auth', () => {
  it('rejects requests without Kevin\'s Tailscale identity', async () => {
    const { app } = setup();
    await request(app).post('/api/turn?device=d1&conversation=c1').send({ text: 'hi' }).expect(403);
    await request(app).post('/api/turn?device=d1&conversation=c1').set('Tailscale-User-Login', 'someone@else.com').send({ text: 'hi' }).expect(403);
  });
  it('leaves /healthz open for the household dashboard', async () => {
    const { app } = setup();
    const res = await request(app).get('/healthz').expect(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/turn', () => {
  it('transcribes audio, gathers mail context, and streams sentences with audio', async () => {
    const { app, asks, gathered } = setup();
    const res = await request(app).post('/api/turn?device=d1&conversation=c1&turn=t1').set(KEVIN)
      .set('Content-Type', 'audio/webm').send(Buffer.alloc(5000, 1)).expect(200);
    const events = lines(res.text);
    expect(events[0]).toEqual({ type: 'transcript', text: 'Any emails from tier 1 today?' });
    expect(events.filter((e) => e.type === 'sentence').map((e) => e.text)).toEqual(['One from Brent.', 'He needs the deck today.']);
    expect(events.at(-1).type).toBe('done');
    expect(gathered).toEqual([['mail']]);
    expect(asks[0].sessionKey).toBe('intercom-d1-c1');
    expect(asks[0].idempotencyKey).toBe('intercom-t1');
    expect(asks[0].instructions).toMatch(/read-only voice session/);
    expect(asks[0].input).toMatch(/CONTEXT[\s\S]*Brent Layton/);

    const audioId = events.find((e) => e.type === 'sentence').audio;
    const wav = await request(app).get(`/api/audio/${audioId}`).set(KEVIN).expect(200);
    expect(wav.headers['content-type']).toBe('audio/wav');
  });

  it('keeps the topic for a follow-up in the same conversation', async () => {
    const { app, gathered } = setup();
    await request(app).post('/api/turn?device=d1&conversation=c2').set(KEVIN).send({ text: 'What is on my calendar tomorrow?' });
    await request(app).post('/api/turn?device=d1&conversation=c2').set(KEVIN).send({ text: 'And after that?' });
    expect(gathered).toEqual([['calendar'], ['calendar']]);
  });

  it('skips Hermes when nothing was heard', async () => {
    const { app, asks } = setup({ transcript: ' ' });
    const res = await request(app).post('/api/turn?device=d1&conversation=c1').set(KEVIN).set('Content-Type', 'audio/mp4').send(Buffer.alloc(5000));
    expect(lines(res.text)).toMatchObject([{ type: 'error', spoken: "Didn't catch that." }]);
    expect(asks).toHaveLength(0);
  });

  it('says so out loud when Jarvis is unreachable', async () => {
    const { app } = setup({ error: "Can't reach Jarvis" });
    const res = await request(app).post('/api/turn?device=d1&conversation=c1').set(KEVIN).send({ text: 'Any emails?' });
    expect(lines(res.text).at(-1)).toMatchObject({ type: 'error', spoken: "I can't reach Jarvis right now." });
  });

  it('produces no audio when muted', async () => {
    const { app, speech } = setup();
    const res = await request(app).post('/api/turn?device=d1&conversation=c1&mute=1').set(KEVIN).send({ text: 'Any emails?' });
    expect(lines(res.text).filter((e) => e.type === 'sentence').every((e) => !e.audio)).toBe(true);
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it('rejects bad ids', async () => {
    const { app } = setup();
    await request(app).post('/api/turn?device=../x&conversation=c1').set(KEVIN).send({ text: 'hi' }).expect(400);
  });
});

describe('POST /api/ask (Siri Shortcut)', () => {
  it('returns plain speech text and cards', async () => {
    const { app } = setup({ answer: ['Two meetings tomorrow. ', '```intercom-card\n{"kind":"agenda","items":[{"title":"Board"}]}\n```'] });
    const res = await request(app).post('/api/ask').set(KEVIN).send({ text: 'Calendar tomorrow?' }).expect(200);
    expect(res.body).toEqual({ speech: 'Two meetings tomorrow.', cards: [{ kind: 'agenda', items: [{ title: 'Board' }] }] });
  });
});

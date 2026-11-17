// One spoken (or typed) question, end to end (spec §6).
import { randomUUID } from 'node:crypto';
import type { Gatherer } from './gather.js';
import type { AskHermes } from './hermes.js';
import type { Speech } from './sidecar.js';
import { classify, type Topic } from './topics.js';
import { SpeechStream, VOICE_INSTRUCTIONS, type Card } from './voice.js';

export type TurnEvent =
  | { type: 'transcript'; text: string }
  | { type: 'status'; text: string; audio?: string }
  | { type: 'sentence'; text: string; audio?: string }
  | { type: 'card'; card: Card }
  | { type: 'done'; text: string; ms: number }
  | { type: 'error'; message: string; spoken?: string; audio?: string };

export interface TurnInput {
  turnId: string;
  device: string;
  conversation: string;
  text?: string;
  audio?: Buffer;
  mime?: string;
  /** When false, no TTS is produced (muted page, Siri Shortcut). */
  speak: boolean;
}

/** Holds synthesized audio briefly so the browser can fetch each sentence. */
export class AudioStore {
  private items = new Map<string, { buf: Buffer; expires: number }>();
  constructor(private ttlMs = 5 * 60_000) {}
  put(buf: Buffer): string {
    this.sweep();
    const id = randomUUID();
    this.items.set(id, { buf, expires: Date.now() + this.ttlMs });
    return id;
  }
  get(id: string): Buffer | undefined {
    const it = this.items.get(id);
    return it && it.expires > Date.now() ? it.buf : undefined;
  }
  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.items) if (v.expires <= now) this.items.delete(k);
  }
}

const STATUS: Record<Topic, string> = {
  mail: 'Checking your inbox.',
  calendar: 'Looking at your calendar.',
  headlines: 'Pulling up the headlines.',
  briefing: 'Getting this morning\'s briefing.',
};

/** Names and companies Whisper should spell right (spec §6 step 2). */
export const NAME_HINT = 'Jarvis, Kevin Bagley, Bagley Strategies, Brent Layton, Zane Yates, Jared Allgood, Healthy Together, Twenty, Sharecare, Medicaid, Rivendell, Entmoot, Gandalf.';

export interface TurnDeps {
  speech: Speech;
  ask: AskHermes;
  gatherer: Gatherer;
  audio: AudioStore;
  voice: string;
  speed: number;
  statusDelayMs?: number;
  log?: (line: string) => void;
}

export class TurnRunner {
  /** Last topics per conversation, so "and Thursday?" keeps the calendar context. */
  private lastTopics = new Map<string, { topics: Set<Topic>; at: number }>();

  constructor(private deps: TurnDeps) {}

  async run(input: TurnInput, emit: (e: TurnEvent) => void, signal?: AbortSignal): Promise<void> {
    const started = Date.now();
    const { speech, voice, speed } = this.deps;
    const say = async (text: string): Promise<string | undefined> => {
      if (!input.speak) return undefined;
      try { return this.deps.audio.put(await speech.speak(text, voice, speed)); } catch { return undefined; }
    };
    const fail = async (message: string, spoken: string) => emit({ type: 'error', message, spoken, audio: await say(spoken) });

    // 1–3. Transcribe and show what was heard.
    let question = input.text?.trim() ?? '';
    if (!question && input.audio) {
      try {
        question = await speech.transcribe(input.audio, input.mime ?? '', NAME_HINT);
      } catch (err) {
        return fail((err as Error).message, 'Sorry, I couldn\'t hear that properly.');
      } finally {
        input.audio = undefined; // audio is never kept (spec §12)
      }
    }
    if (!question || !/[\p{L}\p{N}]/u.test(question) || /^\s*(\[.*\]|thank you\.?|you)\s*$/i.test(question)) {
      return fail('empty_transcript', 'Didn\'t catch that.');
    }
    emit({ type: 'transcript', text: question });

    const sessionKey = `intercom-${input.device}-${input.conversation}`;
    let topics = classify(question);
    const prev = this.lastTopics.get(sessionKey);
    if (!topics.size && prev && Date.now() - prev.at < 10 * 60_000) topics = prev.topics;
    if (topics.size) this.lastTopics.set(sessionKey, { topics, at: Date.now() });

    // Say what he's doing if nothing has been said after a moment (spec §6 step 6).
    let spokeSomething = false;
    const statusTimer = topics.size
      ? setTimeout(async () => {
          if (spokeSomething) return;
          const text = STATUS[[...topics][0]];
          emit({ type: 'status', text, audio: await say(text) });
        }, this.deps.statusDelayMs ?? 2500)
      : undefined;

    try {
      // 4. Gather read-only context (spec §8).
      let context = 'No extra context was gathered for this question.';
      if (topics.size) {
        try { context = (await this.deps.gatherer.gather(topics, question)).context; }
        catch (err) { context = `CONTEXT UNAVAILABLE: ${(err as Error).message}`; }
        // Log only the gatherers' own failure lines (no mail or calendar content) so outages are visible.
        for (const m of context.matchAll(/^[A-Z ]*UNAVAILABLE[^\n]{0,900}/gm)) this.deps.log?.(`turn ${input.turnId} gather: ${m[0]}`);
      }
      if (signal?.aborted) return;

      // 5–8. Ask Jarvis, speak sentence by sentence.
      const stream = new SpeechStream();
      let full = '';
      const speakQueue: Promise<void>[] = [];
      let chain = Promise.resolve();
      const emitSentence = (s: string) => {
        spokeSomething = true;
        // Synthesize in parallel but emit in order.
        const audio = say(s);
        chain = chain.then(async () => emit({ type: 'sentence', text: s, audio: await audio }));
        speakQueue.push(chain);
      };
      const input2 = `QUESTION (spoken by Kevin): ${question}\n\nCONTEXT (gathered read-only by Intercom just now):\n${context}`;
      for await (const ev of this.deps.ask({
        input: input2,
        instructions: VOICE_INSTRUCTIONS,
        sessionKey,
        idempotencyKey: `intercom-${input.turnId}`,
        signal,
      })) {
        if (ev.type === 'delta') {
          full += ev.text;
          for (const s of stream.push(ev.text)) emitSentence(s);
        } else if (ev.type === 'error') {
          await chain;
          return fail(ev.message, 'I can\'t reach Jarvis right now.');
        } else if (ev.type === 'done') {
          break;
        }
      }
      const end = stream.finish();
      for (const s of end.sentences) emitSentence(s);
      await Promise.all(speakQueue);
      for (const card of end.cards) emit({ type: 'card', card });
      if (!full.trim()) return fail('empty_answer', 'Jarvis didn\'t have an answer.');
      const ms = Date.now() - started;
      this.deps.log?.(`turn ${input.turnId} topics=${[...topics].join('+') || 'none'} ms=${ms}`);
      emit({ type: 'done', text: end.text, ms });
    } finally {
      if (statusTimer) clearTimeout(statusTimer);
    }
  }
}

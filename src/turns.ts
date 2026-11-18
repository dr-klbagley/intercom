// One spoken (or typed) question, end to end (spec §6).
import { createHash, randomUUID } from 'node:crypto';
import { wantsFresh, type Gatherer } from './gather.js';
import type { AskHermes } from './hermes.js';
import type { Speech } from './sidecar.js';
import { classify, EXPLICIT_CALENDAR, isAction, isQuestion, isReply, wantsWeb, webQuery, type Topic } from './topics.js';
import { SAY_NO, SAY_YES, type ActionStore, type ActionView } from './actions.js';
import { ACTION_INSTRUCTIONS, SpeechStream, VOICE_INSTRUCTIONS, type Card } from './voice.js';

export type TurnEvent =
  | { type: 'transcript'; text: string }
  | { type: 'status'; text: string; audio?: string }
  | { type: 'sentence'; text: string; audio?: string }
  | { type: 'card'; card: Card }
  | { type: 'action'; action: ActionView }
  | { type: 'action_result'; id: string; ok: boolean; message: string }
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

/** Spoken when Hermes can't be reached or doesn't answer. */
export const HERMES_DOWN = 'My servers appear to be unreachable at the moment.';

/**
 * What he says when nothing has been said for a few seconds (never the same twice in a row). They fire
 * before the question is understood, so they must suit any question, a "thanks" included.
 */
export const FILLERS = ['One moment, sir.', 'Just a moment, sir.', 'Let me see, sir.', 'Bear with me, sir.', 'Right, one moment.'];
/** A second line if the wait drags on. */
export const LONG_FILLERS = ['Nearly there, sir.', 'Still with you, sir. One more moment.', 'Almost there, sir.'];

/** Names and companies Whisper should spell right (spec §6 step 2). */
export const NAME_HINT = 'Jarvis, Kevin Bagley, Bagley Strategies, Brent Layton, Zane Yates, Jared Allgood, Healthy Together, Twenty, Sharecare, Medicaid, Rivendell, Entmoot, Gandalf.';

export interface TurnDeps {
  speech: Speech;
  ask: AskHermes;
  gatherer: Gatherer;
  audio: AudioStore;
  voice: string;
  speed: number;
  /** Silence before the first filler, counted from when the question arrives (default 3 s). */
  statusDelayMs?: number;
  /** Silence before the second filler (default 13 s). */
  longStatusDelayMs?: number;
  log?: (line: string) => void;
  /** Phase 2 (spec §14): set only when INTERCOM_ACTIONS=1. */
  actions?: ActionStore;
}

export class TurnRunner {
  /** Last topics per conversation, so "and Thursday?" keeps the calendar context. */
  private lastTopics = new Map<string, { topics: Set<Topic>; at: number; query?: string }>();
  private lastFiller = new Map<string[], number>();
  /** Context sections already sent in each conversation (Hermes keeps the history), by content hash. */
  private sentSections = new Map<string, { hashes: Set<string>; at: number }>();
  /** Fillers are synthesized once and reused, so they play at once instead of queueing behind transcription. */
  private fillerAudio = new Map<string, Promise<Buffer | undefined>>();

  constructor(private deps: TurnDeps) {}

  private fillerWav(text: string): Promise<Buffer | undefined> {
    let p = this.fillerAudio.get(text);
    if (!p) {
      p = this.deps.speech.speak(text, this.deps.voice, this.deps.speed).catch(() => { this.fillerAudio.delete(text); return undefined; });
      this.fillerAudio.set(text, p);
    }
    return p;
  }

  /** Synthesizes every filler in advance (call at startup, once the speech sidecar is up). */
  async warmFillers(): Promise<void> {
    for (const t of [...FILLERS, ...LONG_FILLERS]) await this.fillerWav(t);
  }

  /** Sends each context section once per conversation; repeats become a one-line pointer. */
  private dedupe(sessionKey: string, full: string, sections: { name: string; text: string }[]): string {
    const now = Date.now();
    for (const [k, v] of this.sentSections) if (now - v.at > 60 * 60_000) this.sentSections.delete(k);
    const seen = this.sentSections.get(sessionKey) ?? { hashes: new Set<string>(), at: now };
    seen.at = now;
    this.sentSections.set(sessionKey, seen);
    const head = full.split('\n\n')[0]; // the "Now:" line
    const parts = sections.map((s) => {
      const h = createHash('sha256').update(s.text).digest('hex');
      if (seen.hashes.has(h)) return `## ${s.name}: unchanged since you were given it earlier in this conversation (use that).`;
      seen.hashes.add(h);
      return s.text;
    });
    return [head, ...parts].join('\n\n');
  }

  private pick(list: string[]): string {
    let i = Math.floor(Math.random() * list.length);
    if (i === this.lastFiller.get(list)) i = (i + 1) % list.length;
    this.lastFiller.set(list, i);
    return list[i];
  }

  async run(input: TurnInput, emit: (e: TurnEvent) => void, signal?: AbortSignal): Promise<void> {
    const started = Date.now();
    const { speech, voice, speed } = this.deps;
    const say = async (text: string): Promise<string | undefined> => {
      if (!input.speak) return undefined;
      try { return this.deps.audio.put(await speech.speak(text, voice, speed)); } catch { return undefined; }
    };
    const fail = async (message: string, spoken: string) => emit({ type: 'error', message, spoken, audio: await say(spoken) });
    const stage: Record<string, number> = {};
    const mark = (name: string) => { stage[name] ??= Date.now() - started; };

    // If nothing has been said a few seconds after the question arrives, say a short filler; a second one
    // if the wait drags on. Counted from arrival, so slow transcription counts too (spec §6 step 6).
    let spokeSomething = false;
    const filler = (list: string[]) => async () => {
      if (spokeSomething || signal?.aborted) return;
      const text = this.pick(list);
      const wav = input.speak ? await this.fillerWav(text) : undefined;
      if (spokeSomething) return;
      mark('filler');
      emit({ type: 'status', text, audio: wav ? this.deps.audio.put(wav) : undefined });
    };
    const timers = [
      setTimeout(filler(FILLERS), this.deps.statusDelayMs ?? 3000),
      setTimeout(filler(LONG_FILLERS), this.deps.longStatusDelayMs ?? 13_000),
    ];
    try {

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
    mark('stt');
    if (!question || !/[\p{L}\p{N}]/u.test(question) || /^\s*(\[.*\]|thank you\.?|you)\s*$/i.test(question)) {
      return fail('empty_transcript', 'Didn\'t catch that.');
    }
    emit({ type: 'transcript', text: question });

    const sessionKey = `intercom-${input.device}-${input.conversation}`;

    // A spoken "yes" / "no" settles the to-do cards on screen (Kevin chose voice confirm for to-dos only;
    // email still needs a tap). Only the whole utterance counts, and only cards from this conversation.
    if (this.deps.actions && (SAY_YES.test(question) || SAY_NO.test(question))) {
      const todos = this.deps.actions.openIn(sessionKey, true);
      if (todos.length) {
        const yes = SAY_YES.test(question);
        let ok = 0;
        for (const card of todos) {
          const r = yes ? await this.deps.actions.confirm(card.id, {}, 'voice') : { ok: this.deps.actions.cancel(card.id, 'voice'), message: 'Cancelled.' };
          if (r.ok) ok++;
          emit({ type: 'action_result', id: card.id, ok: r.ok, message: r.message });
        }
        const others = this.deps.actions.openIn(sessionKey, false).length;
        const n = todos.length;
        let text = yes
          ? (ok === n ? (n === 1 ? 'Done, sir. It\'s on your list.' : n === 2 ? 'Done, sir. Both are on your list.' : `Done, sir. All ${n} are on your list.`) : `${ok} of ${n} went through, sir. The rest didn't change.`)
          : (n === 1 ? 'Right, I\'ve dropped it.' : n === 2 ? 'Right, I\'ve dropped both.' : `Right, I've dropped all ${n}.`);
        if (yes && others) text += ' The email still needs a tap to send.';
        spokeSomething = true;
        emit({ type: 'sentence', text, audio: await say(text) });
        this.deps.log?.(`turn ${input.turnId} voice ${yes ? 'confirm' : 'cancel'} todos=${n} ok=${ok}`);
        emit({ type: 'done', text, ms: Date.now() - started });
        return;
      }
    }
    // Replies and sign-offs need no lookup; a question-shaped follow-up keeps the last topic.
    let topics = isReply(question) ? new Set<Topic>() : classify(question);
    const prev = this.lastTopics.get(sessionKey);
    const recent = prev && Date.now() - prev.at < 10 * 60_000;
    if (!topics.size && recent && (isQuestion(question) || isAction(question)) && !isReply(question)) topics = prev.topics;
    // "Push the Sara Howard one to Monday": a weekday alone doesn't make an action about the calendar.
    else if (recent && isAction(question) && topics.size === 1 && topics.has('calendar') && !EXPLICIT_CALENDAR.test(question)) topics = prev.topics;
    // Web search: when asked, or when a real question matches none of Kevin's own sources. A follow-up to a
    // search ("and who won?") searches again with the earlier question for context.
    let query: string | undefined;
    if (topics.has('web') && recent && prev?.query) query = `${prev.query} ${webQuery(question)}`.slice(0, 300);
    else if (wantsWeb(question, topics)) { topics = new Set([...topics, 'web']); query = webQuery(question); }
    if (topics.size) this.lastTopics.set(sessionKey, { topics, at: Date.now(), query: query ?? (topics.has('web') ? prev?.query : undefined) });
    const fresh = wantsFresh(question);
    const lookingUp = topics.size > 0 && !(this.deps.gatherer.isWarm?.(topics, question, { fresh }) ?? false);

      // 4. Gather read-only context (spec §8).
      const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' });
      let context = `Now: ${now} (America/Chicago)\nNothing new was looked up for this; answer from the conversation so far.`;
      if (topics.size) {
        try {
          const g = await this.deps.gatherer.gather(topics, question, { fresh, webQuery: query });
          context = g.sections ? this.dedupe(sessionKey, g.context, g.sections) : g.context;
        }
        catch (err) { context = `CONTEXT UNAVAILABLE: ${(err as Error).message}`; }
        // Log only the gatherers' own failure lines (no mail or calendar content) so outages are visible.
        for (const m of context.matchAll(/^[A-Z ]*UNAVAILABLE[^\n]{0,900}/gm)) this.deps.log?.(`turn ${input.turnId} gather: ${m[0]}`);
      }
      mark('gather');
      if (signal?.aborted) return;

      // 5–8. Ask Jarvis, speak sentence by sentence.
      const stream = new SpeechStream();
      let full = '';
      const speakQueue: Promise<void>[] = [];
      let chain = Promise.resolve();
      const emitSentence = (s: string) => {
        spokeSomething = true;
        mark('firstSentence');
        // Synthesize in parallel but emit in order.
        const audio = say(s);
        chain = chain.then(async () => { const a = await audio; mark('firstAudio'); emit({ type: 'sentence', text: s, audio: a }); });
        speakQueue.push(chain);
      };
      const input2 = `QUESTION (spoken by Kevin): ${question}\n\nCONTEXT (gathered read-only by Intercom just now):\n${context}`;
      for await (const ev of this.deps.ask({
        input: input2,
        instructions: this.deps.actions ? VOICE_INSTRUCTIONS + ACTION_INSTRUCTIONS : VOICE_INSTRUCTIONS,
        sessionKey,
        idempotencyKey: `intercom-${input.turnId}`,
        signal,
      })) {
        if (ev.type === 'delta') {
          mark('firstToken');
          full += ev.text;
          for (const s of stream.push(ev.text)) emitSentence(s);
        } else if (ev.type === 'error') {
          await chain;
          return fail(ev.message, HERMES_DOWN);
        } else if (ev.type === 'done') {
          break;
        }
      }
      const end = stream.finish();
      for (const s of end.sentences) emitSentence(s);
      await Promise.all(speakQueue);
      for (const card of end.cards) emit({ type: 'card', card });
      // Proposed actions: checked against Slotherium / Mail, then shown for Kevin to confirm.
      if (this.deps.actions) {
        for (const raw of end.proposals.slice(0, 3)) {
          const r = await this.deps.actions.propose(raw, input.device, question, sessionKey).catch((err: Error) => ({ error: err.message }));
          if ('error' in r) this.deps.log?.(`turn ${input.turnId} action dropped: ${r.error}`);
          else emit({ type: 'action', action: r });
        }
      }
      if (!full.trim()) return fail('empty_answer', 'Jarvis didn\'t have an answer.');
      const ms = Date.now() - started;
      // Timings only (ms from arrival): stt, gather, firstToken (Jarvis), firstAudio (first sentence ready), filler.
      const stages = Object.entries(stage).map(([k, v]) => `${k}=${v}`).join(' ');
      this.deps.log?.(`turn ${input.turnId} topics=${[...topics].join('+') || 'none'}${lookingUp ? ' live' : topics.size ? ' cached' : ''} ms=${ms} ${stages}`);
      emit({ type: 'done', text: end.text, ms });
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  }
}

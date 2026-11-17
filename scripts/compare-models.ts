// Runs the same spoken-style conversations through Jarvis on two models, with identical gathered context,
// and prints timings and answers. Doesn't touch the running service.
//   npx tsx scripts/compare-models.ts                       (GPT default vs ollama-local gemma4:12b-64k)
//   MODELS="default;ollama-local:gemma4:12b-64k" npx tsx scripts/compare-models.ts
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { ScriptGatherer } from '../src/gather.js';
import { hermesClient } from '../src/hermes.js';
import { classify, isQuestion, isReply, type Topic } from '../src/topics.js';
import { SpeechStream, VOICE_INSTRUCTIONS } from '../src/voice.js';

const plist = `${os.homedir()}/Library/LaunchAgents/com.jarvis.intercom.plist`;
const key = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :EnvironmentVariables:INTERCOM_HERMES_KEY', plist]).toString().trim();
const cfg = loadConfig({ ...process.env, INTERCOM_HERMES_KEY: key });
const gatherer = new ScriptGatherer({ scriptsDir: cfg.scriptsDir, python: cfg.gatherPython, digestScript: cfg.digestScript, calendarScript: cfg.calendarScript });

const CONVERSATIONS = [
  ['Any emails from tier 1 senders today?', 'Anything from Brent?'],
  ["What's on the docket today?", "Let's have the demo take priority. Thanks, Jarvis.", 'And what does tomorrow look like?', 'No, thanks.'],
  ["What's in the headlines?"],
];

const models = (process.env.MODELS ?? 'default;ollama-local:gemma4:12b-64k').split(';').map((m) => {
  if (m === 'default') return { label: 'default (gpt-6-sol)', model: undefined, provider: undefined };
  const i = m.indexOf(':');
  return { label: m.slice(i + 1), provider: m.slice(0, i), model: m.slice(i + 1) };
});

await gatherer.prefetch();
for (const m of models) {
  const ask = hermesClient({ url: cfg.hermesUrl, key, profile: cfg.hermesProfile, timeoutMs: 180_000, model: m.model, provider: m.provider });
  console.log(`\n=================== ${m.label}`);
  for (const convo of CONVERSATIONS) {
    const sessionKey = `intercom-compare-${randomUUID()}`;
    let last: Set<Topic> = new Set();
    for (const q of convo) {
      let topics = isReply(q) ? new Set<Topic>() : classify(q);
      if (!topics.size && last.size && isQuestion(q) && !isReply(q)) topics = last;
      if (topics.size) last = topics;
      const context = topics.size ? (await gatherer.gather(topics, q)).context : 'Nothing new was looked up for this; answer from the conversation so far.';
      const t0 = Date.now();
      let first = 0, text = '';
      const stream = new SpeechStream();
      for await (const ev of ask({ input: `QUESTION (spoken by Kevin): ${q}\n\nCONTEXT (gathered read-only by Intercom just now):\n${context}`, instructions: VOICE_INSTRUCTIONS, sessionKey, idempotencyKey: `cmp-${randomUUID()}` })) {
        if (ev.type === 'delta') { if (!first && ev.text.trim()) first = Date.now() - t0; stream.push(ev.text); }
        if (ev.type === 'error') { text = `ERROR: ${ev.message}`; break; }
      }
      const end = stream.finish();
      text ||= end.text;
      console.log(`\nKevin: ${q}\nJarvis (${(first / 1000).toFixed(1)}s to first words, ${((Date.now() - t0) / 1000).toFixed(1)}s total${end.cards.length ? `, ${end.cards.length} card` : ''}): ${text}`);
    }
  }
}

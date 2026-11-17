// Runs each real read-only gatherer once and prints only sizes, timing and warnings (never content).
//   npx tsx scripts/check-gather.ts
import { loadConfig } from '../src/config.js';
import { ScriptGatherer } from '../src/gather.js';
import type { Topic } from '../src/topics.js';

async function main() {
  const c = loadConfig({});
  const g = new ScriptGatherer({ scriptsDir: c.scriptsDir, python: c.gatherPython, digestScript: c.digestScript, calendarScript: c.calendarScript });
  const sets: Topic[][] = [['mail', 'calendar'], ['headlines'], ['briefing']];
  for (const t of sets) {
    const t0 = Date.now();
    const r = await g.gather(new Set(t), 'today');
    const warnings = (r.context.match(/^.*UNAVAILABLE.*$/gm) ?? []).map((s) => s.slice(0, 90));
    console.log(`${t.join('+')} | chars ${r.context.length} | ${Date.now() - t0} ms | sources ${r.sources.join(',') || 'none'} | warnings: ${warnings.join(' / ') || 'none'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

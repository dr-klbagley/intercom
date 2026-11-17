// Read-only gatherers (spec §8): Intercom collects the context, Jarvis only answers.
// Mail and calendar come from Jarvis's own briefing scripts; headlines and the briefing from the
// newest digest emails Jarvis sent Kevin.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Topic } from './topics.js';

export interface GatherResult {
  context: string;
  sources: string[];
  /** True if anything had to be fetched now (no fresh copy in the cache). */
  live: boolean;
}

export interface GatherOptions {
  /** Skip the cache ("check again", "anything new"). */
  fresh?: boolean;
}

export interface Gatherer {
  gather(topics: Set<Topic>, question: string, opts?: GatherOptions): Promise<GatherResult>;
  /** Whether gather() would answer from the cache without fetching anything. */
  isWarm?(topics: Set<Topic>, question: string, opts?: GatherOptions): boolean;
}

/** Questions that want the latest data rather than what was fetched a few minutes ago. */
export function wantsFresh(question: string): boolean {
  return /(again|refresh|re-?check|just now|right now|latest|anything new|any new|newest|since)/i.test(question);
}

interface Options {
  scriptsDir: string;
  python: string;
  /** scripts/latest_digest.py in this repo. */
  digestScript: string;
  /** scripts/calendar.sh in this repo (Jarvis's calendar helper without `open -W`). */
  calendarScript: string;
  log?: (line: string) => void;
  timeoutMs?: number;
  /** How long a fetched part is reused (default 6 min; the prefetch refreshes every 5). */
  cacheMs?: number;
}

type Part = 'mc2' | 'mc7' | 'headlines' | 'briefing';
const HEADLINES = 'Medicaid & Health Insurance Headlines — ';
const BRIEFING = 'Daily briefing — ';
const clock = (d: Date) => d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });

function run(cmd: string, args: string[], timeoutMs: number, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // On timeout, SIGABRT makes Python print where it was stuck (PYTHONFAULTHANDLER) instead of dying silently.
    execFile(cmd, args, { cwd, timeout: timeoutMs, killSignal: 'SIGABRT', env: { ...process.env, PYTHONFAULTHANDLER: '1' }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
        const why = e.killed || e.signal === 'SIGABRT' ? `timed out after ${timeoutMs / 1000}s` : `exit ${e.code ?? '?'}${e.signal ? ` (${e.signal})` : ''}`;
        reject(new Error(`${path.basename(cmd)} ${why}: ${stderr.toString().trim().slice(-700) || 'no error output'}`));
      }
      else resolve(stdout.toString());
    });
  });
}

export class ScriptGatherer implements Gatherer {
  private cache = new Map<Part, { at: number; text: string }>();
  private inflight = new Map<Part, Promise<string>>();

  constructor(private opts: Options) {}

  private parts(topics: Set<Topic>, question: string): Part[] {
    const parts: Part[] = [];
    // One mail+calendar set (2 days of mail) serves mail, calendar and mixed questions; "this week" needs 7.
    if (topics.has('mail') || topics.has('calendar')) parts.push(/\b(week|7 days|seven days)\b/i.test(question) ? 'mc7' : 'mc2');
    if (topics.has('headlines')) parts.push('headlines');
    if (topics.has('briefing')) parts.push('briefing');
    return parts;
  }

  private cached(part: Part): { at: number; text: string } | undefined {
    const hit = this.cache.get(part);
    return hit && Date.now() - hit.at < (this.opts.cacheMs ?? 6 * 60_000) ? hit : undefined;
  }

  isWarm(topics: Set<Topic>, question: string, opts: GatherOptions = {}): boolean {
    return !opts.fresh && this.parts(topics, question).every((p) => this.cached(p));
  }

  /** Fetches one part, sharing a fetch already in progress (the prefetch and a question can overlap). */
  private fetch(part: Part): Promise<string> {
    let p = this.inflight.get(part);
    if (!p) {
      p = (part === 'mc2' ? this.mailAndCalendar(2) : part === 'mc7' ? this.mailAndCalendar(7) : this.digest(part === 'headlines' ? HEADLINES : BRIEFING))
        .then((text) => { this.cache.set(part, { at: Date.now(), text }); return text; })
        .finally(() => this.inflight.delete(part));
      this.inflight.set(part, p);
    }
    return p;
  }

  /** Keeps the common parts warm so most questions skip the fetch (spec §7). Errors are logged, not thrown. */
  async prefetch(): Promise<void> {
    await Promise.all((['mc2', 'headlines', 'briefing'] as Part[]).map((p) =>
      this.fetch(p).catch((err: Error) => this.opts.log?.(`prefetch ${p}: ${err.message.slice(0, 300)}`))));
  }

  async gather(topics: Set<Topic>, question: string, opts: GatherOptions = {}): Promise<GatherResult> {
    const now = new Date();
    const out: string[] = [`Now: ${now.toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' })} (America/Chicago)`];
    const sources: string[] = [];
    let live = false;
    const results = await Promise.all(this.parts(topics, question).map(async (part) => {
      const hit = opts.fresh ? undefined : this.cached(part);
      if (!hit) live = true;
      try {
        const text = hit ? hit.text : await this.fetch(part);
        const at = hit ? hit.at : Date.now();
        return { part, text, at, ok: true as const };
      } catch (err) {
        return { part, text: (err as Error).message, at: 0, ok: false as const };
      }
    }));
    for (const r of results) {
      const asOf = Date.now() - r.at > 60_000 ? ` (fetched at ${clock(new Date(r.at))}; mention that only if Kevin asks about something very recent)` : '';
      if (r.part === 'mc2' || r.part === 'mc7') {
        out.push(r.ok ? `## Mail and calendar${asOf}\n${r.text}` : `MAIL AND CALENDAR UNAVAILABLE: ${r.text}. Tell Kevin they couldn't be checked.`);
        if (r.ok) sources.push('mail+calendar');
      } else if (r.part === 'headlines') {
        out.push(r.ok ? `## Latest headlines digest Jarvis emailed Kevin\n${r.text}` : 'HEADLINES UNAVAILABLE: no digest emailed in the last 2 days.');
        if (r.ok) sources.push('headlines');
      } else {
        out.push(r.ok ? `## This morning's briefing Jarvis emailed Kevin\n${r.text}` : 'BRIEFING UNAVAILABLE: no briefing emailed in the last 2 days.');
        if (r.ok) sources.push('briefing');
      }
    }
    return { context: out.join('\n\n'), sources, live };
  }

  /** Newest digest Jarvis emailed Kevin, read from Apple Mail (the jobs keep only a delivery note). */
  private digest(subjectPrefix: string): Promise<string> {
    return run(this.opts.python, [this.opts.digestScript, this.opts.scriptsDir, subjectPrefix], this.opts.timeoutMs ?? 45_000, this.opts.scriptsDir);
  }

  private async mailAndCalendar(days: number): Promise<string> {
    const { scriptsDir, python } = this.opts;
    const timeout = this.opts.timeoutMs ?? 45_000;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intercom-cal-'));
    const calFile = path.join(dir, 'cal.json');
    try {
      const args = ['--days', String(days), '--no-sync'];
      try {
        await fs.writeFile(calFile, await run(this.opts.calendarScript, [], timeout, scriptsDir), { mode: 0o600 });
        args.unshift('--calendar', calFile);
      } catch (err) {
        // briefing_gather reports CALENDAR UNAVAILABLE itself; record why the helper failed (error text only).
        this.opts.log?.(`calendar helper: ${(err as Error).message.slice(0, 400)}`);
      }
      return await run(python, [path.join(scriptsDir, 'briefing_gather.py'), ...args], timeout, scriptsDir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

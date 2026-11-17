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
}

export interface Gatherer {
  gather(topics: Set<Topic>, question: string): Promise<GatherResult>;
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
  cacheMs?: number;
}

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
  private cache = new Map<string, { at: number; value: GatherResult }>();

  constructor(private opts: Options) {}

  async gather(topics: Set<Topic>, question: string): Promise<GatherResult> {
    const days = /\b(week|7 days|seven days)\b/i.test(question) ? 7 : 2;
    const key = `${[...topics].sort().join(',')}|${days}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (this.opts.cacheMs ?? 60_000)) return hit.value;

    const parts: string[] = [`Now: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' })} (America/Chicago)`];
    const sources: string[] = [];
    const jobs: Promise<void>[] = [];

    if (topics.has('mail') || topics.has('calendar')) {
      jobs.push(this.mailAndCalendar(topics.has('mail') ? days : 1).then(
        (text) => { parts.push(text); sources.push('mail+calendar'); },
        (err: Error) => { parts.push(`MAIL AND CALENDAR UNAVAILABLE: ${err.message}. Tell Kevin they couldn't be checked.`); },
      ));
    }
    if (topics.has('headlines')) {
      jobs.push(this.digest('Medicaid & Health Insurance Headlines — ').then(
        (text) => { parts.push(`## Latest headlines digest Jarvis emailed Kevin\n${text}`); sources.push('headlines'); },
        () => { parts.push('HEADLINES UNAVAILABLE: no digest emailed in the last 2 days.'); },
      ));
    }
    if (topics.has('briefing')) {
      jobs.push(this.digest('Daily briefing — ').then(
        (text) => { parts.push(`## This morning's briefing Jarvis emailed Kevin\n${text}`); sources.push('briefing'); },
        () => { parts.push('BRIEFING UNAVAILABLE: no briefing emailed in the last 2 days.'); },
      ));
    }
    await Promise.all(jobs);
    const value = { context: parts.join('\n\n'), sources };
    this.cache.set(key, { at: Date.now(), value });
    return value;
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

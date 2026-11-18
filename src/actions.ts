// Phase 2: actions with confirmation (spec §14). Jarvis proposes in a hidden ```intercom-action``` block;
// Intercom checks the proposal against reality, holds it as a pending action, and runs it only when Kevin
// taps Confirm on the page. Nothing here runs on Jarvis's say-so alone.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Slotherium, Todo } from './slotherium.js';

export type Proposal =
  | { kind: 'todo.add'; title: string; due_date?: string; notes?: string }
  | { kind: 'todo.complete'; id: number }
  | { kind: 'todo.update'; id: number; title?: string; due_date?: string }
  | { kind: 'email.reply'; to: string; subject: string; body: string; reply_all?: boolean };

/** What the page shows and lets Kevin edit. */
export interface ActionView {
  id: string;
  kind: Proposal['kind'];
  title: string;
  lines: string[];
  /** Editable fields and their current values. */
  fields: { name: string; label: string; type: 'text' | 'date' | 'textarea'; value: string }[];
  expiresAt: number;
}

interface Pending {
  view: ActionView;
  proposal: Proposal;
  /** The conversation it was proposed in: a spoken "yes" only confirms cards from the same one. */
  conversation: string;
  /** For email: the exact message being replied to, resolved by Intercom (never taken from Jarvis). */
  message?: MailMessage;
  todo?: Todo;
  device: string;
  question: string;
}

export interface MailMessage {
  rowid: number;
  from: string;
  fromName: string;
  subject: string;
  date: string;
}

export interface ActionDeps {
  slotherium?: Slotherium;
  /** Finds the newest inbox message from `from` with this subject (scripts/mail_find.py). */
  findMessage: (from: string, subject: string) => Promise<MailMessage[]>;
  /** Sends a reply to message `rowid` (scripts/mail_reply.applescript). */
  sendReply: (rowid: number, body: string, replyAll: boolean) => Promise<string>;
  /** Appends one line to the audit log in the vault. */
  audit: (line: string) => Promise<void>;
  ttlMs?: number;
  log?: (line: string) => void;
}

/** A whole utterance that just says yes to the cards on screen ("yes", "yes please, add them", "go ahead"). */
export const SAY_YES = /^\s*(?:(?:yes|yeah|yep|yup|sure|ok(?:ay)?|confirm(?:ed)?|do it|go ahead|please do|sounds good|that's right|correct|perfect|great|add (?:it|them|that|those|both)(?: to my list)?|that's (?:fine|good|great))[\s,.!]*)+(?:(?:please|thanks|thank you|jarvis|sir)[\s,.!]*)*$/i;
/** A whole utterance that declines them ("no", "cancel that", "never mind"). */
export const SAY_NO = /^\s*(?:(?:no|nope|nah|cancel(?: (?:it|that|them|those|both))?|never ?mind|scratch that|don't (?:add|do) (?:it|that|them))[\s,.!]*)+(?:(?:thanks|thank you|jarvis|sir)[\s,.!]*)*$/i;

const ACTION_RE = /```intercom-action\s*([\s\S]*?)```/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Pulls every intercom-action block out of an answer (they are never spoken). */
export function extractActions(text: string): { text: string; proposals: unknown[] } {
  const proposals: unknown[] = [];
  const stripped = text.replace(ACTION_RE, (_m, body: string) => {
    try { proposals.push(JSON.parse(body)); } catch { /* malformed: dropped */ }
    return '';
  });
  return { text: stripped.trim(), proposals };
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
const optDate = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : typeof v === 'string' && DATE.test(v) ? v : null);

/** Strict shape check; returns undefined for anything that isn't exactly a known action. */
export function parseProposal(raw: unknown): Proposal | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case 'todo.add': {
      const title = str(r.title, 200); const due = optDate(r.due_date);
      if (!title || due === null) return undefined;
      return { kind: 'todo.add', title, due_date: due, notes: str(r.notes, 1000) };
    }
    case 'todo.complete':
      return Number.isInteger(r.id) && (r.id as number) > 0 ? { kind: 'todo.complete', id: r.id as number } : undefined;
    case 'todo.update': {
      const due = optDate(r.due_date); const title = r.title === undefined ? undefined : str(r.title, 200);
      if (!Number.isInteger(r.id) || due === null || (r.title !== undefined && !title) || (!title && !due)) return undefined;
      return { kind: 'todo.update', id: r.id as number, title, due_date: due };
    }
    case 'email.reply': {
      const to = typeof r.to === 'string' ? r.to.trim().toLowerCase() : '';
      const subject = str(r.subject, 300); const body = str(r.body, 4000);
      if (!EMAIL.test(to) || !subject || !body) return undefined;
      return { kind: 'email.reply', to, subject, body, reply_all: r.reply_all === true };
    }
    default:
      return undefined;
  }
}

const niceDate = (d?: string) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '');

export class ActionStore {
  private pending = new Map<string, Pending>();
  constructor(private deps: ActionDeps) {}

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.view.expiresAt <= now) this.pending.delete(k);
  }

  /** Checks a proposal against Slotherium / Mail and, if it holds up, makes it a pending action. */
  async propose(raw: unknown, device: string, question: string, conversation = ''): Promise<ActionView | { error: string }> {
    this.sweep();
    const p = parseProposal(raw);
    if (!p) return { error: 'not a valid action' };
    const id = randomUUID();
    const expiresAt = Date.now() + (this.deps.ttlMs ?? 10 * 60_000);
    let view: ActionView;
    const extra: Partial<Pending> = {};

    if (p.kind !== 'email.reply') {
      if (!this.deps.slotherium) return { error: 'Slotherium is not configured' };
      if (p.kind === 'todo.add') {
        view = { id, kind: p.kind, expiresAt, title: 'Add to your to-do list', lines: [],
          fields: [
            { name: 'title', label: 'To-do', type: 'text', value: p.title },
            { name: 'due_date', label: 'Due', type: 'date', value: p.due_date ?? '' },
            { name: 'notes', label: 'Notes', type: 'textarea', value: p.notes ?? '' },
          ] };
      } else {
        const todos = await this.deps.slotherium.call('list_todos', { status: 'open' }) as Todo[];
        const todo = todos.find((t) => t.id === p.id);
        if (!todo) return { error: `no open to-do with id ${p.id}` };
        extra.todo = todo;
        if (p.kind === 'todo.complete') {
          view = { id, kind: p.kind, expiresAt, title: 'Mark as done', lines: [todo.title, todo.due_date ? `Due ${niceDate(todo.due_date)}` : ''].filter(Boolean), fields: [] };
        } else {
          view = { id, kind: p.kind, expiresAt, title: 'Change a to-do', lines: [todo.title],
            fields: [
              { name: 'title', label: 'To-do', type: 'text', value: p.title ?? todo.title },
              { name: 'due_date', label: 'Due', type: 'date', value: p.due_date ?? todo.due_date ?? '' },
            ] };
        }
      }
    } else {
      const matches = await this.deps.findMessage(p.to, p.subject);
      if (matches.length === 0) return { error: 'no inbox message from that sender with that subject' };
      const m = matches[0]; // newest
      extra.message = m;
      view = { id, kind: p.kind, expiresAt, title: p.reply_all ? 'Reply all' : 'Reply',
        lines: [`To: ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}${p.reply_all ? ' and everyone on the email' : ''}`, `Re: ${m.subject.replace(/^(re|fwd?):\s*/i, '')}`, `Replying to the email of ${m.date}`],
        fields: [{ name: 'body', label: 'Message', type: 'textarea', value: p.body }] };
    }
    this.pending.set(id, { view, proposal: p, device, question, conversation, ...extra });
    return view;
  }

  /** Open cards in this conversation, oldest first; `todosOnly` for what a spoken yes/no may settle. */
  openIn(conversation: string, todosOnly: boolean): ActionView[] {
    this.sweep();
    return [...this.pending.values()]
      .filter((p) => p.conversation === conversation && (!todosOnly || p.view.kind.startsWith('todo.')))
      .map((p) => p.view);
  }

  cancel(id: string, via: 'tap' | 'voice' = 'tap'): boolean {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (p) void this.deps.audit(`cancelled (${via}) · ${p.view.kind} · ${p.view.lines[0] ?? p.view.fields[0]?.value ?? ''}`).catch(() => {});
    return !!p;
  }

  /** Runs a pending action once, with Kevin's edits. Returns what to say. */
  async confirm(id: string, edits: Record<string, unknown> = {}, via: 'tap' | 'voice' = 'tap'): Promise<{ ok: boolean; message: string }> {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return { ok: false, message: 'That has expired, sir. Ask me again if you still want it.' };
    this.pending.delete(id); // once only, whatever happens next
    const edited = (name: string) => {
      const field = p.view.fields.find((f) => f.name === name);
      if (!field) return undefined;
      const v = edits[name] ?? field.value;
      return typeof v === 'string' ? v.trim() : undefined;
    };
    let message: string; let ok = true; let detail = '';
    try {
      const s = this.deps.slotherium;
      switch (p.proposal.kind) {
        case 'todo.add': {
          const title = edited('title'); const due = edited('due_date') || undefined; const notes = edited('notes') || undefined;
          if (!title || title.length > 200 || (due && !DATE.test(due))) throw new Error('the to-do needs a title and a valid date');
          await s!.call('add_todo', { title, ...(due ? { due_date: due } : {}), ...(notes ? { notes } : {}), source: 'intercom' });
          message = `Added to your list${due ? `, due ${niceDate(due)}` : ''}.`; detail = title;
          break;
        }
        case 'todo.complete':
          await s!.call('complete_todo', { id: p.todo!.id });
          message = 'Marked as done.'; detail = p.todo!.title;
          break;
        case 'todo.update': {
          const title = edited('title'); const due = edited('due_date');
          if (!title || (due && !DATE.test(due))) throw new Error('the to-do needs a title and a valid date');
          await s!.call('update_todo', { id: p.todo!.id, ...(title !== p.todo!.title ? { title } : {}), ...(due && due !== p.todo!.due_date ? { due_date: due } : {}) });
          message = `Updated${due ? `, now due ${niceDate(due)}` : ''}.`; detail = `${p.todo!.title} → ${title}${due ? ` (due ${due})` : ''}`;
          break;
        }
        case 'email.reply': {
          const body = edited('body');
          if (!body) throw new Error('the reply is empty');
          await this.deps.sendReply(p.message!.rowid, body, p.proposal.reply_all === true);
          const who = p.message!.fromName || p.message!.from;
          message = `Sent to ${who}.`; detail = `to ${p.message!.from} re "${p.message!.subject}": ${body.replace(/\s+/g, ' ').slice(0, 300)}`;
          break;
        }
      }
    } catch (err) {
      ok = false;
      message = 'That didn\'t go through, sir. Nothing was changed.';
      detail = (err as Error).message.slice(0, 300);
      this.deps.log?.(`action ${p.view.kind} failed: ${detail}`);
    }
    await this.deps.audit(`${ok ? 'done' : 'FAILED'} (${via}) · ${p.view.kind} · ${detail} · asked: "${p.question.slice(0, 200)}"`).catch((e) => this.deps.log?.(`audit failed: ${(e as Error).message}`));
    return { ok, message: message! };
  }
}

// ---------------------------------------------------------------- real dependencies

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) =>
    err ? reject(new Error(`${path.basename(cmd)}: ${stderr.toString().trim().slice(-300) || err.message}`)) : resolve(stdout.toString())));
}

export function mailFinder(script: string) {
  return async (from: string, subject: string): Promise<MailMessage[]> =>
    JSON.parse(await run('/usr/bin/python3', [script, from, subject])) as MailMessage[];
}

export function mailReplier(script: string) {
  return async (rowid: number, body: string, replyAll: boolean): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intercom-reply-'));
    const file = path.join(dir, 'body.txt');
    try {
      await fs.writeFile(file, body, { mode: 0o600 });
      return await run('/usr/bin/osascript', [script, String(rowid), file, replyAll ? 'all' : 'sender'], 60_000);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

/** Appends to Jarvis/Intercom actions.md in the vault (Jarvis's own folder; synced like the rest). */
export function vaultAudit(vaultDir: string) {
  const file = path.join(vaultDir, 'Jarvis', 'Intercom actions.md');
  return async (line: string) => {
    try { await fs.access(file); } catch {
      await fs.writeFile(file, '# Intercom actions\n\nEvery action Kevin confirmed (or cancelled) in Intercom, newest last. Written by Intercom.\n\n');
    }
    const ts = new Date().toLocaleString('en-CA', { timeZone: 'America/Chicago', hour12: false }).replace(',', '');
    await fs.appendFile(file, `- ${ts} · ${line.replace(/\n/g, ' ')}\n`);
  };
}

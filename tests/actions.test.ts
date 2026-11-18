import { describe, expect, it, vi } from 'vitest';
import { ActionStore, extractActions, parseProposal, SAY_NO, SAY_YES, type MailMessage } from '../src/actions.js';
import { AudioStore, TurnRunner, type TurnEvent } from '../src/turns.js';
import type { Slotherium, Todo } from '../src/slotherium.js';
import { SpeechStream } from '../src/voice.js';

const TODOS: Todo[] = [{ id: 5, list_id: 1, title: 'Set a Dr Appt for myself', notes: null, due_date: '2026-09-28', status: 'open' }];
const MSG: MailMessage = { rowid: 21303, from: 'laquetta@example.gov', fromName: 'LaQuetta', subject: 'RE: Connect,', date: 'Tue Nov 17, 3:10 PM' };

function setup(opts: { messages?: MailMessage[]; ttlMs?: number } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const slotherium: Slotherium = {
    call: vi.fn(async (tool: string, args: Record<string, unknown>) => { calls.push([tool, args]); return tool === 'list_todos' ? TODOS : { ok: true }; }),
  };
  const sendReply = vi.fn(async () => 'Sent');
  const audit = vi.fn(async () => {});
  const store = new ActionStore({ slotherium, findMessage: async () => opts.messages ?? [MSG], sendReply, audit, ttlMs: opts.ttlMs });
  return { store, calls, sendReply, audit };
}

describe('parseProposal', () => {
  it('accepts exactly the known kinds and fields', () => {
    expect(parseProposal({ kind: 'todo.add', title: 'Send deck', due_date: '2026-11-20' })).toMatchObject({ kind: 'todo.add', title: 'Send deck' });
    expect(parseProposal({ kind: 'todo.add', title: 'x', due_date: 'Friday' })).toBeUndefined();
    expect(parseProposal({ kind: 'todo.complete', id: '5' })).toBeUndefined();
    expect(parseProposal({ kind: 'email.send', to: 'a@b.co', body: 'hi' })).toBeUndefined();
    expect(parseProposal({ kind: 'email.reply', to: 'not an address', subject: 's', body: 'b' })).toBeUndefined();
    expect(parseProposal({ kind: 'email.reply', to: 'A@B.co', subject: 'Connect,', body: 'Yes.\nKevin' })).toMatchObject({ to: 'a@b.co', reply_all: false });
  });
});

describe('action blocks', () => {
  it('are pulled out of the answer and never spoken', () => {
    const s = new SpeechStream();
    const spoken = [...s.push('I\'ve drafted that, sir. '), ...s.push('```intercom-action\n{"kind":"todo.add","title":"Call Brent"}\n```')];
    const end = s.finish();
    expect([...spoken, ...end.sentences].join(' ')).toBe("I've drafted that, sir.");
    expect(end.proposals).toEqual([{ kind: 'todo.add', title: 'Call Brent' }]);
    expect(end.text).not.toMatch(/intercom-action/);
    expect(extractActions('x ```intercom-action\n{bad json}\n```').proposals).toEqual([]);
  });
});

describe('ActionStore', () => {
  it('adds a to-do only on confirm, with Kevin\'s edits, once', async () => {
    const { store, calls, audit } = setup();
    const view = await store.propose({ kind: 'todo.add', title: 'Send Brent the deck', due_date: '2026-11-20' }, 'd1', 'add a to-do');
    if ('error' in view) throw new Error(view.error);
    expect(calls).toEqual([]);
    const r = await store.confirm(view.id, { title: 'Send Brent the Mississippi deck' });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([['add_todo', { title: 'Send Brent the Mississippi deck', due_date: '2026-11-20', source: 'intercom' }]]);
    expect(audit).toHaveBeenCalledOnce();
    expect((await store.confirm(view.id)).ok).toBe(false); // once only
  });

  it('drops a completion for a to-do that doesn\'t exist', async () => {
    const { store } = setup();
    expect(await store.propose({ kind: 'todo.complete', id: 99 }, 'd1', 'q')).toMatchObject({ error: expect.stringMatching(/no open to-do/) });
    const ok = await store.propose({ kind: 'todo.complete', id: 5 }, 'd1', 'q');
    expect(ok).toMatchObject({ title: 'Mark as done', lines: ['Set a Dr Appt for myself', expect.any(String)] });
  });

  it('replies only to a message Intercom found itself, to its real sender', async () => {
    const none = setup({ messages: [] });
    expect(await none.store.propose({ kind: 'email.reply', to: 'x@y.co', subject: 'Connect,', body: 'Yes' }, 'd1', 'q')).toHaveProperty('error');
    const { store, sendReply } = setup();
    const view = await store.propose({ kind: 'email.reply', to: 'laquetta@example.gov', subject: 'Connect,', body: 'Central works.\nKevin' }, 'd1', 'q');
    if ('error' in view) throw new Error(view.error);
    expect(view.lines[0]).toBe('To: LaQuetta <laquetta@example.gov>');
    await store.confirm(view.id, { body: 'Yes, Central time works.\nKevin' });
    expect(sendReply).toHaveBeenCalledWith(21303, 'Yes, Central time works.\nKevin', false);
  });

  it('expires', async () => {
    const { store, calls } = setup({ ttlMs: -1 });
    const view = await store.propose({ kind: 'todo.add', title: 'x' }, 'd1', 'q');
    if ('error' in view) throw new Error(view.error);
    expect((await store.confirm(view.id)).message).toMatch(/expired/);
    expect(calls).toEqual([]);
  });
});

describe('spoken yes / no', () => {
  it('only the whole utterance counts', () => {
    for (const y of ['Yes.', 'Yes please.', 'Yeah, add it.', 'Go ahead, Jarvis.', 'Yes, add them. Thanks.', 'Okay.', 'Do it.', 'Sure, sir.']) expect(SAY_YES.test(y), y).toBe(true);
    for (const n of ['Yes, and add one for Friday.', 'Yes, what else is due?', 'Is that added?', 'Add a to-do to call Brent.']) expect(SAY_YES.test(n), n).toBe(false);
    for (const n of ['No.', 'No thanks.', 'Cancel that.', 'Never mind.', "Don't add it."]) expect(SAY_NO.test(n), n).toBe(true);
    expect(SAY_NO.test('No, make it Monday instead.')).toBe(false);
  });

  it('confirms the to-do cards of this conversation by voice, but never an email', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const slotherium: Slotherium = { call: async (tool, args) => { calls.push([tool, args]); return tool === 'list_todos' ? TODOS : {}; } };
    const sendReply = vi.fn(async () => 'Sent');
    const store = new ActionStore({ slotherium, findMessage: async () => [MSG], sendReply, audit: async () => {} });
    const answers = [
      ['Shall I add it, sir?\n```intercom-action\n{"kind":"todo.add","title":"Call Zane","due_date":"2026-11-24"}\n```\n```intercom-action\n{"kind":"email.reply","to":"laquetta@example.gov","subject":"Connect,","body":"Yes.\\nKevin"}\n```'],
    ];
    const asks: string[] = [];
    const runner = new TurnRunner({
      speech: { transcribe: async () => '', speak: async () => Buffer.from('wav'), healthy: async () => true },
      ask: async function* (req) { asks.push(req.input); for (const d of answers.shift() ?? ['Okay.']) yield { type: 'delta' as const, text: d }; yield { type: 'done' as const, status: 'completed' as const }; },
      gatherer: { gather: async () => ({ context: 'ctx', sources: [], live: false }) },
      audio: new AudioStore(), voice: 'v', speed: 1, statusDelayMs: 60_000, longStatusDelayMs: 60_000, actions: store,
    });
    const run = async (text: string, conversation = 'c1') => {
      const ev: TurnEvent[] = [];
      await runner.run({ turnId: crypto.randomUUID(), device: 'd1', conversation, text, speak: false }, (e) => ev.push(e));
      return ev;
    };
    const first = await run('Remind me to call Zane next Tuesday, and reply yes to LaQuetta.');
    expect(first.filter((e) => e.type === 'action')).toHaveLength(2);
    expect(await run('Yes.', 'other-conversation')).toEqual(expect.not.arrayContaining([expect.objectContaining({ type: 'action_result' })]));
    const yes = await run('Yes please.');
    expect(yes.filter((e) => e.type === 'action_result')).toEqual([expect.objectContaining({ ok: true })]);
    expect(yes.find((e) => e.type === 'sentence')).toMatchObject({ text: "Done, sir. It's on your list. The email still needs a tap to send." });
    expect(calls.filter(([t]) => t === 'add_todo')).toHaveLength(1);
    expect(sendReply).not.toHaveBeenCalled();
    expect(asks).toHaveLength(2); // "Yes please." never went to Jarvis
  });
});

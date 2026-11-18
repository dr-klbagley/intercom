// Slotherium (household to-dos) over its MCP server: read for context, write only for confirmed actions (spec §14).
export interface Todo {
  id: number;
  list_id: number;
  title: string;
  notes: string | null;
  due_date: string | null;
  status: 'open' | 'done' | string;
  completed_at?: string | null;
}

export interface Slotherium {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export function slotheriumClient(url: string, key: string, timeoutMs = 8000): Slotherium {
  let session: string | undefined;
  let id = 0;
  const headers = () => ({
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(session ? { 'Mcp-Session-Id': session } : {}),
  });
  async function rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    if (notify) return undefined;
    if (!res.ok) throw new Error(`Slotherium HTTP ${res.status}`);
    const text = await res.text();
    // Streamable HTTP answers either plain JSON or an SSE "data:" line.
    const json = text.trim().startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!json) throw new Error('Slotherium returned no data');
    const msg = JSON.parse(json);
    if (msg.error) throw new Error(`Slotherium: ${msg.error.message ?? 'error'}`);
    return msg.result;
  }
  let ready: Promise<void> | undefined;
  const init = () => (ready ??= (async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'intercom', version: '1' } });
    await rpc('notifications/initialized', undefined, true);
  })().catch((err) => { ready = undefined; throw err; }));

  return {
    async call(tool, args) {
      await init();
      let result;
      try { result = await rpc('tools/call', { name: tool, arguments: args }); }
      catch (err) {
        // An expired session: start a new one and retry once.
        ready = undefined; session = undefined;
        await init();
        result = await rpc('tools/call', { name: tool, arguments: args });
        void err;
      }
      if (result?.isError) throw new Error(`Slotherium ${tool}: ${result.content?.[0]?.text ?? 'failed'}`);
      const text = result?.content?.[0]?.text;
      try { return text ? JSON.parse(text) : result; } catch { return text; }
    },
  };
}

/** Open to-dos plus those completed in the last 14 days, for Jarvis, with ids so he can name one exactly. */
export function formatTodoContext(open: Todo[], done: Todo[], today: string): string {
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const recent = done.filter((t) => (t.completed_at ?? '').slice(0, 10) >= cutoff)
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
  const doneText = recent.length ? recent.map((t) => `- ${t.title} (done ${(t.completed_at ?? '').slice(0, 10)})`).join('\n') : 'None in the last 14 days.';
  return `### Open (${open.length})\n${formatTodos(open, today)}\n\n### Completed in the last 14 days\n${doneText}`;
}

/** Open to-dos as a compact list for Jarvis, with ids so he can name one exactly. */
export function formatTodos(todos: Todo[], today: string): string {
  if (!todos.length) return 'No open to-dos.';
  const sorted = [...todos].sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.id - b.id);
  return sorted.map((t) => {
    const due = t.due_date ? (t.due_date < today ? ` (OVERDUE, was due ${t.due_date})` : ` (due ${t.due_date})`) : '';
    const notes = t.notes ? ` — ${t.notes.replace(/\s+/g, ' ').slice(0, 160)}` : '';
    return `- [todo ${t.id}] ${t.title}${due}${notes}`;
  }).join('\n');
}

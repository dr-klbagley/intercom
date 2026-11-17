// Streaming client for the Hermes API server's Responses endpoint (spec §6 step 5).
export type HermesEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; status: 'completed' | 'incomplete' }
  | { type: 'error'; message: string };

export interface HermesRequest {
  input: string;
  instructions: string;
  sessionKey: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export type AskHermes = (req: HermesRequest) => AsyncIterable<HermesEvent>;

export interface HermesOptions {
  url: string;
  key: string;
  profile: string;
  timeoutMs: number;
  /** Optional model for this channel instead of Jarvis's default (needs `provider` too, e.g. a custom_providers name). */
  model?: string;
  provider?: string;
}

export function endpoint(opts: HermesOptions, route: string): string {
  const prefix = opts.profile && opts.profile !== 'default' ? `/p/${encodeURIComponent(opts.profile)}` : '';
  return `${opts.url.replace(/\/$/, '')}${prefix}${route}`;
}

/** Parses an SSE byte stream into {event, data} records. */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

export function hermesClient(opts: HermesOptions): AskHermes {
  return async function* ask(req) {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(endpoint(opts, '/v1/responses'), {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.key}`,
          'X-Hermes-Session-Key': req.sessionKey,
          'Idempotency-Key': req.idempotencyKey,
        },
        body: JSON.stringify({
          input: req.input, instructions: req.instructions, stream: true,
          ...(opts.model && opts.provider ? { model: opts.model, provider: opts.provider } : {}),
        }),
      });
    } catch (err) {
      yield { type: 'error', message: timeout.aborted ? 'Jarvis took too long to answer' : `Can't reach Jarvis (${(err as Error).message})` };
      return;
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      yield { type: 'error', message: `Jarvis returned HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
      return;
    }
    let finished: HermesEvent | undefined;
    try {
      for await (const { event, data } of sse(res.body)) {
        if (data === '[DONE]') break;
        let payload: Record<string, any> = {};
        try { payload = JSON.parse(data); } catch { continue; }
        const type: string = payload.type ?? event;
        if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
          yield { type: 'delta', text: payload.delta };
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          // Keep reading to the end of the stream: Hermes only closes the turn (and admits the next one
          // in this session) once the response has been fully delivered.
          finished = { type: 'done', status: type === 'response.completed' ? 'completed' : 'incomplete' };
        } else if (type === 'response.failed' || type === 'response.cancelled' || type === 'error') {
          yield { type: 'error', message: payload.response?.error?.message ?? payload.message ?? type };
          return;
        } else if (/tool/.test(type)) {
          const name = payload.item?.name ?? payload.name ?? payload.tool ?? 'tool';
          yield { type: 'tool', name: String(name) };
        }
      }
      yield finished ?? { type: 'done', status: 'completed' };
    } catch (err) {
      yield { type: 'error', message: timeout.aborted ? 'Jarvis took too long to answer' : (err as Error).message };
    }
  };
}

export async function hermesReachable(opts: HermesOptions): Promise<boolean> {
  try {
    const res = await fetch(endpoint(opts, '/v1/models'), {
      headers: { Authorization: `Bearer ${opts.key}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

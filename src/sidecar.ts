// Client for the local speech sidecar (spec §4): /stt (mlx-whisper) and /tts (Kokoro).
export interface Speech {
  transcribe(audio: Buffer, mime: string, prompt: string): Promise<string>;
  speak(text: string, voice: string, speed: number): Promise<Buffer>;
  healthy(): Promise<boolean>;
}

export function sidecarClient(url: string): Speech {
  const base = url.replace(/\/$/, '');
  return {
    async transcribe(audio, mime, prompt) {
      const res = await fetch(`${base}/stt?prompt=${encodeURIComponent(prompt)}`, {
        method: 'POST',
        headers: { 'Content-Type': mime || 'application/octet-stream' },
        body: new Uint8Array(audio),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`speech-to-text failed (HTTP ${res.status})`);
      const { text } = (await res.json()) as { text: string };
      return text.trim();
    },
    async speak(text, voice, speed) {
      const res = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, speed }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`text-to-speech failed (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
    async healthy() {
      try {
        const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

import { describe, expect, it } from 'vitest';
import '../web/vad.js';

const { Vad } = (globalThis as any).IntercomVad;
const TICK = 60;
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noise = (base: number) => base * (0.7 + 0.6 * rnd());
// Speech: loud syllables with brief dips between them.
const speech = (ms: number, base: number) => Array.from({ length: ms / TICK }, (_, i) => (i % 5 === 4 ? noise(base) * 1.5 : Math.max(0.12, base * 4) + 0.1 * rnd()));

/** When tap mode would hang up (ms after speech ends), with the page's 3 s rule. */
function hangUp(levels: number[], speechEnd: number, floor: number | null = null) {
  const vad = new Vad({ floor });
  let heard = false, quietSince = 0;
  for (let i = 0; i < levels.length; i++) {
    const t = i * TICK;
    if (vad.push(levels[i])) { heard = true; quietSince = 0; } else if (!quietSince) quietSince = t;
    if (heard && quietSince && t - quietSince > 3000) return t - speechEnd;
  }
  return Infinity;
}

describe('end of speech', () => {
  for (const [room, base] of [['quiet room', 0.004], ['fan / street noise', 0.035], ['loud room', 0.06]] as const) {
    it(`hangs up about 3 s after Kevin stops, in a ${room}`, () => {
      const lead = Array.from({ length: 10 }, () => noise(base));
      const talk = speech(4000, base);
      const tail = Array.from({ length: 200 }, () => noise(base));
      const end = (lead.length + talk.length) * TICK;
      const ms = hangUp([...lead, ...talk, ...tail], end);
      expect(ms).toBeGreaterThan(2900);
      expect(ms).toBeLessThan(3600);
    });
  }

  it('a single click is not speech', () => {
    const vad = new Vad();
    const hits = [0.01, 0.01, 0.3, 0.01, 0.01].map((l) => vad.push(l));
    expect(hits).not.toContain(true);
  });
});

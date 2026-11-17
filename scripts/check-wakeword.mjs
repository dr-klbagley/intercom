// Runs the browser wake-word code (web/wakeword.js) on WAV files in Node, through the same 48 kHz ->
// 16 kHz resampling worklet the page uses. Prints the peak "hey jarvis" score per file.
//   node scripts/check-wakeword.mjs clip1.wav [clip2.wav …]   (16-bit mono WAVs)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ort = require('onnxruntime-web');
ort.env.wasm.numThreads = 1;
require(path.join(root, 'web/wakeword.js'));
const { WakeDetector, WORKLET } = globalThis.IntercomWake;

function readWav(file) {
  const b = fs.readFileSync(file);
  const rate = b.readUInt32LE(24);
  let off = 12; while (b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const n = b.readUInt32LE(off + 4) / 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
  return { rate, samples: out };
}
// Load the worklet class as the browser would, at a 48 kHz context rate.
function makeWorklet(rate) {
  let Cls; const posted = [];
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WORKLET)(
    class { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } }, (_n, c) => { Cls = c; }, rate);
  return { node: new Cls(), posted };
}

for (const file of process.argv.slice(2)) {
  const { rate, samples } = readWav(file);
  // Upsample 16k -> 48k (repeat) to exercise the resampler like a real mic would.
  const up = new Float32Array(samples.length * 3);
  for (let i = 0; i < up.length; i++) up[i] = samples[Math.floor(i / 3)];
  const w = makeWorklet(rate * 3);
  for (let i = 0; i + 128 <= up.length; i += 128) w.node.process([[up.subarray(i, i + 128)]]);
  const det = new WakeDetector(ort, async (n) => fs.readFileSync(path.join(root, 'web/models', n + '.onnx')));
  await det.load();
  let peak = 0, at = 0, t = 0;
  for (const block of w.posted) {
    const s = await det.push(block); t += block.length / 16000;
    if (s !== null && s > peak) { peak = s; at = t; }
  }
  console.log(`${path.basename(file)}: peak ${peak.toFixed(3)} at ${at.toFixed(2)} s`);
}

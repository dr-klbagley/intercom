// "Hey Jarvis" wake word, in the browser (spec §5.2). openWakeWord's published models run through
// onnxruntime-web: 16 kHz audio -> mel spectrogram -> speech embeddings -> "hey jarvis" score.
// Audio never leaves the device for this. Plain script: sets globalThis.IntercomWake (also loads in Node for tests).
(() => {
  'use strict';
  const CHUNK = 1280;          // 80 ms at 16 kHz: one step of the openWakeWord pipeline
  const MEL_CONTEXT = 160 * 3; // extra samples the mel model needs before each chunk
  const MEL_WINDOW = 76;       // mel frames per embedding
  const FEATURES = 16;         // embeddings per wake-word prediction (about 1.3 s)

  class WakeDetector {
    /** @param ort onnxruntime-web; @param loadModel (name) => Promise<ArrayBuffer|Uint8Array> */
    constructor(ort, loadModel, model = 'hey_jarvis_v0.1') {
      this.ort = ort; this.loadModel = loadModel; this.model = model; this.ready = null;
      this.reset();
    }
    load() {
      if (!this.ready) {
        const open = async (name) => this.ort.InferenceSession.create(await this.loadModel(name), { executionProviders: ['wasm'] });
        this.ready = Promise.all([open('melspectrogram'), open('embedding_model'), open(this.model)])
          .then(([mel, emb, kw]) => { this.mel = mel; this.emb = emb; this.kw = kw; });
      }
      return this.ready;
    }
    /** Forget recent audio (after a detection, or when listening resumes). */
    reset() {
      this.pending = new Float32Array(0);
      this.raw = new Float32Array(CHUNK + MEL_CONTEXT);
      this.melRows = [];
      this.features = [];
    }
    /**
     * Feed 16 kHz mono samples in the -1..1 range. Returns the highest wake score (0..1) seen in
     * the chunks this call completed, or null if not enough audio has arrived yet.
     */
    async push(samples) {
      const joined = new Float32Array(this.pending.length + samples.length);
      joined.set(this.pending); joined.set(samples, this.pending.length);
      let best = null, off = 0;
      for (; off + CHUNK <= joined.length; off += CHUNK) {
        const score = await this.step(joined.subarray(off, off + CHUNK));
        if (score !== null) best = Math.max(best ?? 0, score);
      }
      this.pending = joined.slice(off);
      return best;
    }
    async step(chunk) {
      const { ort } = this;
      // Keep the last CHUNK + MEL_CONTEXT samples, in int16 scale as openWakeWord expects.
      this.raw.copyWithin(0, CHUNK);
      for (let i = 0; i < CHUNK; i++) this.raw[MEL_CONTEXT + i] = Math.max(-32768, Math.min(32767, chunk[i] * 32767));

      const melOut = (await this.mel.run({ [this.mel.inputNames[0]]: new ort.Tensor('float32', this.raw.slice(), [1, this.raw.length]) }))[this.mel.outputNames[0]];
      const frames = melOut.dims[2], data = melOut.data;
      for (let f = 0; f < frames; f++) {
        const row = new Float32Array(32);
        for (let j = 0; j < 32; j++) row[j] = data[f * 32 + j] / 10 + 2;
        this.melRows.push(row);
      }
      if (this.melRows.length > 200) this.melRows.splice(0, this.melRows.length - 200);
      if (this.melRows.length < MEL_WINDOW) return null;

      const win = new Float32Array(MEL_WINDOW * 32);
      this.melRows.slice(-MEL_WINDOW).forEach((r, i) => win.set(r, i * 32));
      const embOut = (await this.emb.run({ [this.emb.inputNames[0]]: new ort.Tensor('float32', win, [1, MEL_WINDOW, 32, 1]) }))[this.emb.outputNames[0]];
      this.features.push(Float32Array.from(embOut.data));
      if (this.features.length > FEATURES) this.features.shift();
      if (this.features.length < FEATURES) return null;

      const feats = new Float32Array(FEATURES * 96);
      this.features.forEach((f, i) => feats.set(f, i * 96));
      const kwOut = (await this.kw.run({ [this.kw.inputNames[0]]: new ort.Tensor('float32', feats, [1, FEATURES, 96]) }))[this.kw.outputNames[0]];
      return kwOut.data[0];
    }
  }

  /** AudioWorklet that resamples the mic to 16 kHz and posts ~80 ms Float32Array blocks. */
  const WORKLET = `
  class Down16k extends AudioWorkletProcessor {
    constructor() { super(); this.ratio = sampleRate / 16000; this.pos = 1; this.prev = 0; this.out = []; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) {
        // Linear interpolation down to 16 kHz. buf[0] is the previous block's last sample, so
        // positions carry across blocks without a seam.
        const buf = new Float32Array(ch.length + 1);
        buf[0] = this.prev; buf.set(ch, 1);
        let p = this.pos;
        while (p + 1 < buf.length) {
          const i = Math.floor(p), t = p - i;
          this.out.push(buf[i] + (buf[i + 1] - buf[i]) * t);
          p += this.ratio;
        }
        this.pos = p - ch.length; this.prev = ch[ch.length - 1];
        if (this.out.length >= 1280) { this.port.postMessage(Float32Array.from(this.out)); this.out = []; }
      }
      return true;
    }
  }
  registerProcessor('intercom-down16k', Down16k);`;

  globalThis.IntercomWake = { WakeDetector, WORKLET, CHUNK };
})();

// End-of-speech detection for tap mode and "Hey Jarvis" follow-ups. A fixed loudness threshold
// mistook background noise (raised further by the mic's auto gain) for talking, so the line stayed
// open. This learns the room's noise floor and only counts sound well above it as speech.
// Plain script: sets globalThis.IntercomVad (also loads in Node for tests).
(() => {
  'use strict';

  /** Feed one RMS level per tick; true while Kevin is talking. Anything else counts toward the quiet timer. */
  class Vad {
    constructor(opts = {}) {
      this.floor = opts.floor ?? null; // carried between recordings: the room doesn't change between turns
      this.speechRatio = opts.speechRatio ?? 2.5; // speech is this many times the noise floor
      this.minSpeech = opts.minSpeech ?? 0.02; // never call anything softer than this speech
      this.confirmTicks = opts.confirmTicks ?? 2; // a door click or cough is one tick, not speech
      this.run = 0;
    }

    push(l) {
      if (this.floor === null) this.floor = l;
      // The floor drops fast to quieter readings and creeps up slowly, so pauses between words
      // keep it at the room's level while talking barely moves it.
      this.floor += (l - this.floor) * (l < this.floor ? 0.3 : 0.005);
      const speakAt = Math.max(this.minSpeech, this.floor * this.speechRatio);
      this.run = l > speakAt ? this.run + 1 : 0;
      return this.run >= this.confirmTicks;
    }
  }

  globalThis.IntercomVad = { Vad };
})();

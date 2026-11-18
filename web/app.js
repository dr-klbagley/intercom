// Intercom PWA: push-to-talk (hold, or tap and it stops on silence), streamed answers, spoken replies.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const talk = $('talk'), stateEl = $('state'), log = $('log'), dot = $('dot');

  // ---------- per-device ids (localStorage is a convenience; everything works without it)
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const device = store.get('intercom.device') || (() => { const d = uuid(); store.set('intercom.device', d); return d; })();
  let conversation = uuid();
  let lastTurnAt = 0;
  let muted = store.get('intercom.muted') === '1';

  // ---------- audio playback (Web Audio, unlocked on the first tap; iOS needs a gesture)
  let ctx = null;
  const playing = new Set();
  let playChain = Promise.resolve();
  function audioCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  async function fetchDecode(id) {
    const res = await fetch(`api/audio/${id}`);
    if (!res.ok) throw new Error('audio ' + res.status);
    return audioCtx().decodeAudioData(await res.arrayBuffer());
  }
  function playBuffer(buf) {
    return new Promise((resolve) => {
      const src = audioCtx().createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx().destination);
      src.onended = () => { playing.delete(src); resolve(); if (!playing.size && mode === 'speaking') setMode(inflight ? 'thinking' : 'idle'); };
      playing.add(src);
      src.start();
      setMode('speaking');
    });
  }
  function enqueueAudio(id) {
    if (!id || muted) return;
    const decoded = fetchDecode(id).catch(() => null);
    playChain = playChain.then(async () => { const buf = await decoded; if (buf && !stopped) await playBuffer(buf); });
  }
  let stopped = false;
  function stopSpeaking() {
    stopped = true;
    for (const src of playing) { try { src.stop(); } catch { /* already stopped */ } }
    playing.clear();
    playChain = Promise.resolve().then(() => { stopped = false; });
  }
  function tone(up) {
    if (muted) return;
    const c = audioCtx(), o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(up ? 660 : 880, c.currentTime);
    o.frequency.linearRampToValueAtTime(up ? 880 : 620, c.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, c.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.16);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(c.currentTime + 0.18);
  }

  // ---------- UI state
  let mode = 'idle'; // idle | listening | thinking | speaking
  const LABEL = { idle: 'Hold to talk', listening: 'Listening… release to send', thinking: 'Thinking…', speaking: 'Tap to interrupt' };
  function setMode(m) {
    const was = mode;
    mode = m;
    if (m === 'idle' && was === 'speaking') onSpeakingDone();
    talk.className = 'talk ' + (m === 'idle' ? '' : m);
    stateEl.textContent = m === 'listening' && tapMode ? 'Listening… tap to send' : m === 'idle' && wake.on ? 'Say “Hey Jarvis”' : LABEL[m];
  }
  function add(cls, text) {
    $('empty')?.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function renderCard(card) {
    const el = document.createElement('section');
    el.className = 'card';
    const h = document.createElement('h3');
    h.textContent = card.title || ({ emails: 'Emails', agenda: 'Agenda', headlines: 'Headlines' }[card.kind] || 'Details');
    el.appendChild(h);
    const ul = document.createElement('ul');
    for (const it of (card.items || []).slice(0, 25)) {
      const li = document.createElement('li');
      const t = document.createElement('div'); t.className = 't';
      if (it.tag) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = it.tag; t.appendChild(tag); }
      if (it.url && /^https?:\/\//.test(it.url)) {
        const a = document.createElement('a'); a.href = it.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = it.title || '';
        t.appendChild(a);
      } else t.appendChild(document.createTextNode(it.title || ''));
      li.appendChild(t);
      if (it.subtitle) { const s = document.createElement('div'); s.className = 's'; s.textContent = it.subtitle; li.appendChild(s); }
      if (it.meta) { const m = document.createElement('div'); m.className = 'm'; m.textContent = it.meta; li.appendChild(m); }
      ul.appendChild(li);
    }
    el.appendChild(ul);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  // Phase 2: a proposed action. Nothing happens until Kevin taps Confirm (spec §14.3).
  const actionCards = new Map(); // id -> { finish } so a spoken yes/no can settle the card
  function renderAction(a) {
    $('empty')?.remove();
    const el = document.createElement('section');
    el.className = 'card action';
    const h = document.createElement('h3'); h.textContent = a.title; el.appendChild(h);
    const body = document.createElement('div'); body.className = 'action-body';
    for (const line of a.lines || []) { const p = document.createElement('p'); p.className = 'line'; p.textContent = line; body.appendChild(p); }
    const inputs = {};
    for (const f of a.fields || []) {
      const label = document.createElement('label'); label.className = 'field';
      const span = document.createElement('span'); span.textContent = f.label; label.appendChild(span);
      const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input');
      if (f.type !== 'textarea') input.type = f.type;
      if (f.type === 'textarea') input.rows = Math.min(10, Math.max(3, (f.value || '').split('\n').length + 1));
      input.value = f.value || '';
      label.appendChild(input); body.appendChild(label);
      inputs[f.name] = input;
    }
    el.appendChild(body);
    const bar = document.createElement('div'); bar.className = 'action-bar';
    const status = document.createElement('span'); status.className = 'action-status';
    const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel';
    const confirm = document.createElement('button'); confirm.className = 'btn btn-primary'; confirm.textContent = 'Confirm';
    bar.append(status, cancel, confirm); el.appendChild(bar);
    const finish = (text, state) => {
      status.textContent = text; el.dataset.state = state;
      cancel.remove(); confirm.remove();
      for (const i of Object.values(inputs)) i.disabled = true;
    };
    const tick = () => {
      if (el.dataset.state) return;
      const left = a.expiresAt - Date.now();
      if (left <= 0) return finish('Expired', 'expired');
      status.textContent = `Expires in ${Math.ceil(left / 60000)} min`;
      setTimeout(tick, 15_000);
    };
    tick();
    cancel.onclick = async () => {
      finish('Cancelled', 'cancelled');
      fetch(`api/action/${a.id}/cancel`, { method: 'POST' }).catch(() => {});
    };
    const doConfirm = async (quiet) => {
      if (el.dataset.state || confirm.disabled) return;
      audioCtx();
      confirm.disabled = cancel.disabled = true; status.textContent = 'Working…';
      const edits = {}; for (const [k, i] of Object.entries(inputs)) edits[k] = i.value;
      try {
        const r = await fetch(`api/action/${a.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edits, mute: muted }) });
        const j = await r.json();
        finish(j.message || (j.ok ? 'Done' : 'Failed'), j.ok ? 'done' : 'failed');
        if (!quiet) { stopSpeaking(); enqueueAudio(j.audio); }
        return j.ok;
      } catch {
        finish(SERVERS_DOWN, 'failed'); if (!quiet) speakLocally(SERVERS_DOWN);
        return false;
      }
    };
    confirm.onclick = () => doConfirm(false);
    actionCards.set(a.id, { finish, open: () => !el.dataset.state });
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return { doConfirm, open: () => !el.dataset.state };
  }

  // Several proposals in one answer ("add these three"): one tap confirms every card still open.
  function renderConfirmAll(cards) {
    const bar = document.createElement('div');
    bar.className = 'confirm-all';
    const btn = document.createElement('button'); btn.className = 'btn btn-primary';
    btn.textContent = `Confirm all ${cards.length}`;
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Working…';
      let ok = 0;
      for (const c of cards) if (c.open() && await c.doConfirm(true)) ok++;
      bar.remove();
      const msg = ok === cards.length ? `All ${ok} done.` : `${ok} of ${cards.length} done.`;
      add('status', msg);
    };
    bar.appendChild(btn);
    log.appendChild(bar);
    log.scrollTop = log.scrollHeight;
  }

  // When Intercom itself can't be reached there is no server voice, so the browser says it.
  const SERVERS_DOWN = 'My servers appear to be unreachable at the moment.';
  function speakLocally(text) {
    if (muted || !window.speechSynthesis) return;
    try { const u = new SpeechSynthesisUtterance(text); u.lang = 'en-GB'; speechSynthesis.speak(u); } catch { /* no voice */ }
  }

  // ---------- one turn: upload, then read the NDJSON stream
  let inflight = null;
  async function sendTurn(body, contentType) {
    if (Date.now() - lastTurnAt > 30 * 60_000) conversation = uuid(); // idle reset (spec §10)
    lastTurnAt = Date.now();
    inflight?.abort();
    const abort = new AbortController();
    inflight = abort;
    setMode('thinking');
    const qs = new URLSearchParams({ device, conversation, turn: uuid(), mute: muted ? '1' : '0' });
    let bubble = null;
    const audioIds = [];
    const turnActions = [];
    try {
      const res = await fetch(`api/turn?${qs}`, { method: 'POST', headers: { 'Content-Type': contentType }, body, signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(res.status === 403 ? 'This device isn\'t signed in to Tailscale as Kevin.' : `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'transcript') add('me', ev.text);
          else if (ev.type === 'status') { add('status', ev.text); enqueueAudio(ev.audio); }
          else if (ev.type === 'sentence') {
            if (!bubble) bubble = add('jarvis', '');
            bubble.textContent += (bubble.textContent ? ' ' : '') + ev.text;
            log.scrollTop = log.scrollHeight;
            if (ev.audio) audioIds.push(ev.audio);
            enqueueAudio(ev.audio);
          } else if (ev.type === 'card') renderCard(ev.card);
          else if (ev.type === 'action') turnActions.push(renderAction(ev.action));
          else if (ev.type === 'action_result') {
            const c = actionCards.get(ev.id);
            if (c?.open()) c.finish(ev.message, ev.message === 'Cancelled.' ? 'cancelled' : ev.ok ? 'done' : 'failed');
            if (![...actionCards.values()].some((x) => x.open())) document.querySelectorAll('.confirm-all').forEach((b) => b.remove());
          }
          else if (ev.type === 'error') { add('error', ev.spoken || ev.message); enqueueAudio(ev.audio); }
          else if (ev.type === 'done' && bubble) {
            const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = `${(ev.ms / 1000).toFixed(1)}s`;
            if (audioIds.length) {
              const r = document.createElement('button'); r.className = 'replay'; r.innerHTML = '<svg class="ico"><use href="#i-replay"/></svg>Replay'; r.title = 'Play again';
              const ids = audioIds.slice();
              r.onclick = () => { stopSpeaking(); ids.forEach(enqueueAudio); };
              meta.appendChild(r);
            }
            bubble.appendChild(meta);
          }
        }
      }
      if (turnActions.length > 1) renderConfirmAll(turnActions);
    } catch (err) {
      if (err.name === 'AbortError') { /* replaced by a newer turn */ }
      else if (err instanceof TypeError) { add('error', SERVERS_DOWN); speakLocally(SERVERS_DOWN); }
      else add('error', String(err.message || err));
    } finally {
      if (inflight === abort) inflight = null;
      playChain.then(() => { if (mode === 'thinking') { setMode('idle'); if (audioIds.length) onSpeakingDone(); } });
      if (mode === 'thinking' && !playing.size) setMode('idle');
    }
  }

  // ---------- recording
  let micStream = null, recorder = null, chunks = [], tapMode = false, pressAt = 0, startedAt = 0;
  let analyser = null, micSource = null, vadTimer = null, heardSpeech = false, quietSince = 0;
  const MIME = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';

  async function ensureMic() {
    if (micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live')) return micStream;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    analyser = audioCtx().createAnalyser();
    analyser.fftSize = 1024;
    micSource = audioCtx().createMediaStreamSource(micStream);
    micSource.connect(analyser);
    if (wake.on) wakeAttach();
    return micStream;
  }
  function releaseMic() {
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null; analyser = null; micSource = null; wakeDetach();
  }
  function level() {
    if (!analyser) return 0;
    const d = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(d);
    let s = 0; for (const v of d) s += v * v;
    return Math.sqrt(s / d.length);
  }

  async function startListening() {
    stopSpeaking();
    inflight?.abort();
    try { await ensureMic(); } catch (err) {
      add('error', 'Microphone not available: ' + (err.message || err.name));
      return setMode('idle');
    }
    chunks = [];
    recorder = new MediaRecorder(micStream, MIME ? { mimeType: MIME } : undefined);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start(250);
    startedAt = Date.now(); heardSpeech = false; quietSince = 0;
    tone(true);
    setMode('listening');
    clearInterval(vadTimer);
    vadTimer = setInterval(() => {
      const l = level();
      talk.style.setProperty('--level', String(1 + Math.min(l * 8, 0.35)));
      if (l > 0.02) { heardSpeech = true; quietSince = 0; } else if (!quietSince) quietSince = Date.now();
      const elapsed = Date.now() - startedAt;
      // Tap mode ends itself 3 s after you stop talking; any recording stops at 30 s.
      if ((tapMode && heardSpeech && quietSince && Date.now() - quietSince > 3000) || elapsed > 30_000) finishListening(true);
      if (tapMode && !heardSpeech && elapsed > 8000) finishListening(false);
    }, 60);
  }

  function finishListening(send) {
    clearInterval(vadTimer);
    talk.style.removeProperty('--level');
    if (!recorder || recorder.state === 'inactive') return;
    const rec = recorder;
    const long = Date.now() - startedAt > 400;
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || MIME || 'audio/webm' });
      chunks = [];
      if (send && long && blob.size > 2000) sendTurn(blob, blob.type.split(';')[0] || 'audio/webm');
      else setMode('idle');
    };
    tone(false);
    rec.stop();
    recorder = null;
  }

  // Hold = push-to-talk. A quick tap = tap mode (stops on silence, or tap again).
  talk.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    audioCtx();
    if (mode === 'listening') { finishListening(true); return; }
    pressAt = Date.now();
    tapMode = false;
    startListening();
  });
  const release = () => {
    if (mode !== 'listening' || !pressAt) return;
    if (Date.now() - pressAt < 350) { tapMode = true; setMode('listening'); }
    else finishListening(true);
    pressAt = 0;
  };
  talk.addEventListener('pointerup', release);
  talk.addEventListener('pointercancel', release);
  talk.addEventListener('contextmenu', (e) => e.preventDefault());

  // Desktop: hold the space bar.
  let spaceDown = false;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || document.activeElement === $('typed-input')) return;
    e.preventDefault(); spaceDown = true; audioCtx(); tapMode = false; startListening();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !spaceDown) return;
    e.preventDefault(); spaceDown = false; finishListening(true);
  });

  // ---------- typed questions, mute, new conversation
  $('keyboard').onclick = () => { const f = $('typed'); f.hidden = !f.hidden; if (!f.hidden) $('typed-input').focus(); };
  $('typed').onsubmit = (e) => {
    e.preventDefault();
    audioCtx();
    const text = $('typed-input').value.trim();
    if (!text) return;
    $('typed-input').value = '';
    stopSpeaking();
    sendTurn(JSON.stringify({ text }), 'application/json');
  };
  const muteBtn = $('mute');
  const showMute = () => { muteBtn.setAttribute('aria-pressed', String(muted)); muteBtn.querySelector('use').setAttribute('href', muted ? '#i-muted' : '#i-volume'); muteBtn.title = muted ? 'Unmute spoken replies' : 'Mute spoken replies'; };
  muteBtn.onclick = () => { muted = !muted; store.set('intercom.muted', muted ? '1' : '0'); if (muted) stopSpeaking(); showMute(); };
  showMute();
  $('new').onclick = () => {
    conversation = uuid(); stopSpeaking(); inflight?.abort();
    log.replaceChildren(); add('status', 'New conversation.'); setMode('idle');
  };

  // Free the mic when the page is hidden (iOS shows a mic indicator otherwise).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (mode === 'listening') finishListening(false); releaseMic(); }
    else if (wake.on) { ensureMic().catch(() => setWake(false)); keepAwake(); }
  });

  // ---------- "Hey Jarvis" wake word (spec §5.2): detection runs here, on the device
  const wake = { on: false, detector: null, node: null, sink: null, busy: false, cooldownUntil: 0, followUp: false, lock: null };
  const wakeBtn = $('wake');
  const WAKE_THRESHOLD = 0.5;
  let workletReady = null;

  async function loadDetector() {
    if (wake.detector) return wake.detector.load();
    if (!window.ort) await new Promise((ok, fail) => {
      const s = document.createElement('script'); s.src = 'vendor/ort/ort.wasm.min.js'; s.onload = ok; s.onerror = () => fail(new Error('wake word engine didn\'t load'));
      document.head.appendChild(s);
    });
    ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href;
    ort.env.wasm.numThreads = 1;
    wake.detector = new IntercomWake.WakeDetector(ort, async (name) => {
      const r = await fetch(`models/${name}.onnx`);
      if (!r.ok) throw new Error(`wake word model missing (${name})`);
      return new Uint8Array(await r.arrayBuffer());
    });
    return wake.detector.load();
  }
  function wakeAttach() {
    if (!micSource || wake.node || !workletReady) return;
    workletReady.then(() => {
      if (!micSource || wake.node) return;
      const c = audioCtx();
      wake.node = new AudioWorkletNode(c, 'intercom-down16k');
      wake.sink = c.createGain(); wake.sink.gain.value = 0;
      micSource.connect(wake.node); wake.node.connect(wake.sink).connect(c.destination);
      wake.detector.reset();
      wake.node.port.onmessage = (e) => onWakeAudio(e.data);
    });
  }
  function wakeDetach() {
    if (!wake.node) return;
    wake.node.port.onmessage = null;
    try { wake.node.disconnect(); wake.sink.disconnect(); } catch { /* already gone */ }
    wake.node = null; wake.sink = null;
  }
  // Listen for the wake word only while idle or while he's talking (barge-in), never mid-question.
  let wakeWasLive = false;
  async function onWakeAudio(samples) {
    const live = wake.on && (mode === 'idle' || mode === 'speaking') && Date.now() > wake.cooldownUntil;
    if (!live) { wakeWasLive = false; return; }
    if (!wakeWasLive) { wake.detector.reset(); wakeWasLive = true; }
    if (wake.busy) return; // drop audio rather than fall behind
    wake.busy = true;
    try {
      const score = await wake.detector.push(samples);
      if (score !== null && score >= WAKE_THRESHOLD && wake.on && (mode === 'idle' || mode === 'speaking')) {
        wake.cooldownUntil = Date.now() + 1500;
        wakeWasLive = false;
        tapMode = true;
        startListening();
      }
    } catch (err) { console.warn('wake word', err); }
    finally { wake.busy = false; }
  }
  // Follow-up window: after he finishes speaking, keep listening briefly without the wake word.
  // Only once the whole answer is in and spoken: a status line ("Looking at your calendar") isn't the end.
  function onSpeakingDone() {
    if (!wake.on || document.hidden || inflight) return;
    setTimeout(() => { if (mode === 'idle' && wake.on && !inflight && !playing.size) { tapMode = true; startListening(); } }, 250);
  }
  async function keepAwake() {
    try { if (wake.on && navigator.wakeLock && !wake.lock) { wake.lock = await navigator.wakeLock.request('screen'); wake.lock.addEventListener('release', () => { wake.lock = null; }); } } catch { /* not allowed */ }
  }
  async function setWake(on) {
    wake.on = on;
    wakeBtn.setAttribute('aria-pressed', String(on));
    if (!on) {
      wakeDetach();
      wake.lock?.release().catch(() => {}); wake.lock = null;
      if (mode === 'idle') setMode('idle');
      return;
    }
    wakeBtn.classList.add('loading');
    try {
      const c = audioCtx();
      workletReady ??= c.audioWorklet.addModule(URL.createObjectURL(new Blob([IntercomWake.WORKLET], { type: 'text/javascript' })));
      await Promise.all([workletReady, loadDetector(), ensureMic()]);
      wakeAttach();
      keepAwake();
      if (mode === 'idle') setMode('idle');
    } catch (err) {
      wake.on = false; wakeBtn.setAttribute('aria-pressed', 'false');
      add('error', 'Wake word unavailable: ' + (err.message || err));
    } finally { wakeBtn.classList.remove('loading'); }
  }
  wakeBtn.onclick = () => setWake(!wake.on);

  // ---------- connection dot
  async function health() {
    try {
      const res = await fetch('api/status', { cache: 'no-store' });
      const s = res.ok ? await res.json() : null;
      dot.className = 'dot ' + (!s ? 'bad' : s.hermes && s.sidecar ? 'ok' : 'warn');
      dot.title = !s ? `Can't reach Intercom (HTTP ${res.status})` : `Jarvis ${s.hermes ? 'reachable' : 'unreachable'} · speech ${s.sidecar ? 'ready' : 'not ready'}`;
    } catch { dot.className = 'dot bad'; dot.title = 'Can\'t reach Intercom'; }
  }
  health(); setInterval(health, 30_000);
  setMode('idle');
})();

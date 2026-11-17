# Intercom — Design Spec

Date: 2026-11-16
Status: Draft for Kevin's review
Name: **Intercom** (the app). Answers come from **Jarvis** himself (the Hermes `default` profile), through his API server, which has no tools (§8).

## 1. Goal

Let Kevin talk to Jarvis out loud from his iPhone or MacBook Pro, wherever he is, and hear Jarvis answer.

Typical questions:

- "Hey Jarvis, have I got any emails from tier 1 senders today?"
- "What does my calendar look like tomorrow?"
- "What's in today's headlines?" / "Give me the briefing."
- Follow-ups that keep the thread: "And Thursday?", "Read me the one from Brent."

Intercom is a small web app on the Mac mini, built like Entmoot, Rivendell and Mind Stone, served over Tailscale at:

**https://kevins-mac-mini.tail6c0069.ts.net/intercom/**

It works phone-first and is comfortable on the desktop. It offers two ways to talk: **push-to-talk** and a **"Hey Jarvis" wake word**.

## 2. Non-goals (phase 1)

- **Acting on anything.** Phase 1 is read-only: no sending, replying, accepting invites, creating events, deleting, scheduling jobs or texting anyone. Actions with on-screen confirmation are phase 2 (§14).
- Listening while the page is closed or the phone is locked. iOS doesn't allow it, and Siri Shortcuts (§11) cover that case.
- A second brain. Intercom never answers on its own; every answer comes from Hermes.
- Multiple users. Kevin only, by Tailscale identity.
- Public internet access. Tailnet only, never Tailscale Funnel.
- Keeping audio. Recordings are deleted once transcribed (§12).

## 3. Context

- **Mac mini:** Apple M6, 24 GB memory, macOS 27. It has no built-in microphone, which doesn't matter here: the iPhone or MacBook does the listening.
- **Hermes** runs as user `jarvis` (`ai.hermes.gateway`). Jarvis is the `default` profile on `openai-codex` / `gpt-6-sol`. Other profiles: `fangorn`, `gandalf`. Kevin talks to Jarvis today over iMessage through BlueBubbles.
- **Hermes API server:** OpenAI-compatible (`/v1/responses`, `/v1/chat/completions`, `/v1/runs`), with streaming, conversation continuity through `X-Hermes-Session-Key`, and idempotency keys. It isn't on yet: setting `API_SERVER_ENABLED` and `API_SERVER_KEY` in `~/.hermes/.env` turns it on, listening at `127.0.0.1:8642`.
- **Speech-to-text is already on in Hermes** (`stt.local.model: base`) for inbound voice messages.
- **Existing rules Jarvis already follows:** tier 1, tier 2 and family senders in the Preferences note (managed in Mind Stone), the inbox-triage job, the 07:30 email and calendar briefing, and the 08:30 Medicaid and health insurance headlines email. Intercom reuses these as they are and defines no rules of its own.
- **Tailscale serve** routes `/entmoot`, `/rivendell`, `/slotherium`, `/mindstone` and `/dashboard` to ports 4173–4180. Ports 4177 and 4178 are free.

## 4. Architecture

```
iPhone / MacBook (Safari/Chrome, PWA)
  │  mic ─► wake word (in browser) / push-to-talk
  │  HTTPS over tailnet (tailscale serve adds Tailscale-User-Login)
  ▼
Intercom server  — Node 24 + TypeScript, 127.0.0.1:4177   (/intercom)
  ├─ auth (Tailscale identity), sessions, turn orchestration, read-only guard, briefing cache
  ├─► voice sidecar — Python, 127.0.0.1:4178 (loopback only)
  │     ├─ /stt  mlx-whisper (large-v3-turbo) on Metal
  │     └─ /tts  Kokoro (kokoro-onnx), sentence-at-a-time
  └─► Hermes API — 127.0.0.1:8642, Jarvis's default profile (no tools on this channel, §8)
```

Why there's a sidecar: the best speech models for Apple Silicon (MLX Whisper, Kokoro) are Python. The Node server stays like its siblings, and the sidecar exposes two loopback endpoints with no auth beyond loopback-only binding.

Both run as launchd agents under `jarvis`, installed by `install.sh` like Mind Stone. `install.sh` also adds the `/intercom` route to `tailscale serve`.

## 5. Ways to talk

### 5.1 Push-to-talk (the default)

- One large round button, reachable with the thumb, at the bottom of the screen.
- **Hold** to talk and release to send. Or **tap** once to start, and it ends on its own after about 1.2 s of silence (voice activity detection in the browser with the Silero VAD model; the cutoff is configurable). Tap again to cancel.
- On the MacBook, holding the **space bar** works like holding the button.
- Earcons: a short rising tone when listening starts, a falling tone when it stops, and a soft pulse while Jarvis is thinking.

### 5.2 Wake word ("Hey Jarvis")

- A toggle in the header: **Listening for "Hey Jarvis"**. It's off by default and remembered per device.
- Detection runs **in the browser**, using openWakeWord's pre-trained `hey_jarvis` model through onnxruntime-web (WebAssembly). Audio isn't sent anywhere until the wake word fires, so there's no constant upload, no server load and little battery cost beyond keeping the page open.
- When it fires, it plays the listening tone, captures the request until silence (§5.1), and sends it. Saying "Hey Jarvis, what's on tomorrow?" in one breath works, because the request starts right after the wake word.
- **Follow-up window:** for 8 s after Jarvis finishes speaking, the mic stays open for a follow-up without the wake word. A thin countdown ring shows the window.
- **Barge-in:** saying the wake word, or tapping the button, while Jarvis is speaking stops him and starts listening.
- **Echo:** the mic uses the browser's echo cancellation (`echoCancellation: true`), and detection is paused while TTS plays except for barge-in, which needs a stricter detection threshold.
- **Limits, shown on screen:** it only works while the page is open, in the foreground, and the screen is on. To keep an iPhone listening on a desk or in the car, the app holds a Screen Wake Lock while the wake word is on. Sensitivity has three presets (Low, Normal, High) and a test mode that shows the detection score.
- **"Hey J":** not in phase 1. openWakeWord can train custom phrases from synthetic speech. That's a phase 1c task, using the same browser pipeline with a different model file.
- **Fallback:** if a browser can't run the model (old device, no WebAssembly SIMD), the toggle is disabled with the reason, and push-to-talk still works.

## 6. A turn, end to end

1. **Capture:** browser records 16 kHz mono (Opus in WebM on Chrome, AAC/MP4 on Safari) and uploads it to `POST /intercom/api/turn` with a turn ID (used as the idempotency key).
2. **Transcribe:** the server sends the audio to the sidecar's `/stt`. `mlx-whisper large-v3-turbo` takes about 0.3 to 0.8 s for a short request on the M6. A **name hint** is passed as the initial prompt: the names and companies from the Preferences VIP list (Brent Layton, Zane Yates, Jared Allgood, Bagley Strategies, Healthy Together…), so they're spelled right. Empty or near-silent audio ends the turn with "Didn't catch that" and no Hermes call.
3. **Show the transcript** immediately, so Kevin can see what was heard and cancel if it's wrong.
4. **Fast path (§7):** if the transcript matches a briefing intent and the cached answer is fresh, answer from the cache.
5. **Ask Jarvis:** `POST /v1/responses` with `stream: true` to Jarvis's default profile, `X-Hermes-Session-Key: intercom-<device>-<conversation>`, and the voice instructions (§9) plus the transcript as `input`.
6. **Say what he's doing:** while Hermes streams tool-progress events, Intercom speaks at most one short status line, once, after 2.5 s, chosen from the tool being used: "Checking your inbox…", "Looking at your calendar…", "Pulling up the headlines…". If the answer arrives first, nothing is said.
7. **Speak:** as answer text streams in, it's split into sentences, and each one goes to `/tts` and is played as soon as it's ready. Kokoro produces a sentence in about 0.1 to 0.3 s on the M6, so speech starts within about half a second of the first sentence.
8. **Show:** the reply text appears as he speaks, plus any card (§10).

**Latency targets:** under 1.5 s from end of speech to "transcript shown". Under 1 s from first sentence to first audio. Total time depends on Hermes: a live inbox or calendar check is expected to take 8 to 30 s, which is why there's a status line and a fast path.

**Failures:** if Hermes is down or times out (60 s), Jarvis's voice says "I can't reach Jarvis right now" and the screen shows a retry button. Audio stays in memory until the turn finishes, so a retry doesn't need Kevin to repeat himself.

## 7. Briefing cache (fast path)

Three intents get near-instant answers from what Jarvis has already prepared:

| Intent | Example phrasing | Source |
|---|---|---|
| Morning briefing | "give me the briefing", "what's my day look like" | The *Daily briefing* email Jarvis sent at 07:30 |
| Headlines | "what's in the news", "today's headlines" | The *Medicaid & Health Insurance Headlines* email Jarvis sent at 08:30 |
| Tier 1 today | "anything from tier 1 today" | Log of *Inbox triage* (every 15 min) |

- Matching is by keywords plus a confidence threshold. Anything ambiguous goes to Hermes.
- The answer always says how old the data is ("As of 7:30 this morning…") and offers **Check again**, which sends the same question to Hermes live.
- Calendar questions ("tomorrow", "Thursday") always go to Hermes, because calendars change.
- Briefing outputs are condensed for speech by Hermes once, when each job finishes, through an Intercom webhook. They aren't condensed at question time.
- **Confirmed 2026-11-16:** the jobs' own output (`~/.hermes/cron/output/<id>/`) holds only a delivery note, so Intercom reads the emails themselves from Apple Mail (`scripts/latest_digest.py`, read-only, newest from Jarvis's address in the last 2 days).
- **Still open:** whether the triage log has enough for "tier 1 today" (it's in "log only" trial mode). Until then, tier 1 questions use the live mail gatherer, which already marks each email's triage level.

## 8. Read-only enforcement (phase 1)

Read-only is enforced by design: **Intercom gathers, Jarvis only answers.** This is the same pattern as the 07:30 briefing ("Do not gather anything yourself").

**How Jarvis reads today (confirmed 2026-11-16):**
- **Mail:** straight from Apple Mail's index (`~/Library/Mail/V10/MailData/Envelope Index`, opened read-only) and `.emlx` files, through the readers in `~/.hermes/scripts/travel_receipts.py` and `briefing_gather.py`. AppleScript is used only to list account names.
- **Calendar:** EventKit through `Hermes Calendar Helper.app`, called by `~/.hermes/scripts/kevin_calendar.sh`. It covers today plus the next 3 business days.
- **Preferences, corrections, tiers:** vault notes, loaded by `briefing_gather.py`.

**Design:**
- **Intercom picks a topic** for each question (mail, calendar, headlines, briefing, general) and runs the matching **read-only gatherer** on the Mac mini: `kevin_calendar.sh` and `briefing_gather.py --calendar … --days N --no-sync` for mail and calendar, and the latest output of the headlines job for news.
- **The gathered text goes into the Hermes request** as context, marked as untrusted data, alongside the voice instructions and the question.
- **Jarvis's API server channel has no tools** (`platform_toolsets.api_server: []` in Jarvis's own `config.yaml`). Whatever an email says, there's nothing to act with. His other channels (iMessage, cron, CLI) keep their tools.
- **Why Jarvis's own profile, not a separate one (decided 2026-11-16):** a cloned profile copies Jarvis's personality, memory and skills once and then drifts apart; using his own profile means Intercom always gets the current Jarvis, and voice conversations sit in the same searchable history as iMessage. Nothing else uses Jarvis's API server today, so nothing loses tools. If another API client ever needs tools, it gets its own profile then.
- **Every request** also carries: "This is a read-only voice session. If Kevin asks you to send, reply, schedule, change or delete anything, say you can't do that by voice yet and suggest he ask in iMessage."
- **Trade-off:** questions outside the gathered topics ("what did Brent say about pricing last month?") only get what's in the context. Phase 1 answers "I can't look that up by voice yet." Wider read-only search is a phase 1c item.
- **Permissions:** Intercom's launchd job runs the gatherers as `jarvis`. Reading Mail's index needs Full Disk Access for the Node binary that runs Intercom. Kevin grants it once in System Settings (Intercom can't grant it itself). The calendar helper already has Calendar access.
- **Test:** a scripted suite of "send / reply / accept / delete / remind me" requests must produce zero side effects (§15).

## 9. Voice persona and reply style

The voice instructions sent with every turn:

- Lead with the answer. 1 to 4 sentences. No markdown, bullets, tables, URLs or emoji.
- Use names, not email addresses. Times as "10:30" or "half past ten", not "10:30:00".
- For lists of more than 3 items, say the count, read the top 3, then "want the rest?"
- Say when something is uncertain or the data is old.
- For email, say who, roughly what about, and whether they're asking for something. Read the body only when asked.

**Voice:** Kokoro `bm_george` (British male) by default, at speed 1.05. Settings let Kevin choose between 4 preset voices, preview them, and change the speed (0.9 to 1.3). The text sent to TTS is cleaned first: "@" in addresses is spoken, abbreviations are expanded (Tue → Tuesday), and stray symbols are removed.

## 10. The screen

- **Header:** "Intercom", connection dot (green: Hermes reachable), wake-word toggle, settings.
- **Conversation:** Kevin's transcript (right, editable before resending), Jarvis's reply (left), with play/replay on each.
- **Cards** for answers that read better than they sound, sent by Hermes as a fenced `intercom-card` JSON block that's stripped before speaking:
  - *Emails:* sender, tier pill (tier 1 / tier 2 / family), subject, time, one-line summary, "asks you to act" flag.
  - *Agenda:* day header, time, title, location or video link, conflicts highlighted (OOO entries shown but never counted as conflicts, per Preferences).
  - *Headlines:* title, source, one-line summary, link.
- **Text input:** a keyboard button for typing a question in places where Kevin can't talk.
- **Mute toggle:** replies shown but not spoken (for meetings).
- **New conversation:** starts a fresh Hermes session. Conversations also reset after 30 minutes idle.
- **Installable** as a home-screen app (manifest, icon, standalone display), like Rivendell.

## 11. Siri Shortcut ("Hey Siri, ask Jarvis")

For when the page isn't open: lock screen, AirPods, CarPlay, Apple Watch.

- `POST /intercom/api/ask` takes `{ "text": "..." }` and returns `{ "speech": "...", "card": {...} }` without streaming.
- The Shortcut: *Dictate Text* → *Get Contents of URL* (POST) → *Speak Text*, using Siri's voice. It works over the tailnet because the phone is on Tailscale.
- The shortcut is installed from a link on Intercom's settings page.
- **Auth:** Tailscale identity, same as the page. Shortcut requests get the same headers through `tailscale serve`. **To verify:** if they don't, fall back to a per-device token stored in the Shortcut.
- Same no-tools channel, voice instructions and briefing cache. A Shortcut conversation continues for 5 minutes, so "and Thursday?" works as a second ask.

## 12. Privacy and security

- **Tailnet only.** `tailscale serve`, never Funnel. Node binds `127.0.0.1:4177`, the sidecar `127.0.0.1:4178`, Hermes `127.0.0.1:8642`.
- **Who:** requests must carry Kevin's `Tailscale-User-Login`. Anything else gets 403. `GET /intercom/healthz` is unauthenticated, for the household dashboard.
- **Keys:** `API_SERVER_KEY` is stored only in Intercom's launchd plist (mode 600) and `~/.hermes/.env`. It never reaches the browser.
- **Audio:** kept in memory, never written to disk, and dropped when the turn ends. All speech processing is local.
- **Transcripts:** stored in Hermes sessions like any conversation, so they're searchable by Jarvis. Intercom keeps only the last 50 turns per device, for the on-screen history.
- **Untrusted content:** email bodies and headlines are data. Jarvis's API channel has no tools to act on what they say, and phase 2 confirmation (§14) covers that case later.
- **Logs:** turn IDs, timing and errors only. No transcripts or audio.

## 13. Install and operations

- **Code:** `~/intercom` (like `~/mindstone`): `server/` (TypeScript), `sidecar/` (Python, `uv`), `web/` (PWA), `install/`.
- **`install.sh`:**
  1. Checks ports 4177 and 4178 are free.
  2. Creates the sidecar's environment and downloads the models (whisper large-v3-turbo about 1.6 GB, Kokoro about 330 MB, `hey_jarvis` and Silero VAD a few MB each, served to the browser from `web/models/`).
  3. Sets `platform_toolsets.api_server: []` in Jarvis's `config.yaml` (backed up first) and confirms through `GET /v1/toolsets` that the API channel has no tools; stops otherwise (§8).
  4. Turns on the Hermes API server if it's off (backs up `.env` first) and restarts the gateway.
  5. Writes both launchd plists and loads them.
  6. Adds `/intercom` to `tailscale serve`.
  7. Runs a smoke test: STT on a bundled clip, TTS on one sentence, one Hermes turn ("What day is it?").
- **Dashboard:** `/healthz` reports server, sidecar, Hermes reachability and model status.
- **Memory:** whisper large-v3-turbo plus Kokoro uses about 3 GB, alongside Hermes and Ollama in 24 GB.
- **Mac mini settings:** "Prevent automatic sleeping" on, so it's always reachable.

## 14. Phase 2: actions with confirmation

Phase 2 lets Jarvis act by voice, but only after Kevin confirms on screen.

- **Still no tools in Hermes, and no second profile.** The API channel stays tool-less. Instead, Intercom passes Jarvis its own **proposal tools** in each request (the Responses API's `tools` field): `propose_email_reply`, `propose_email`, `propose_invite_response`, `propose_event`, `propose_todo`, `propose_text`. When Jarvis calls one, the call comes back to Intercom; Hermes never runs it. Jarvis decides *what* to do and fills in the details (recipient, exact text, event times); nothing happens yet.
- **Every action is a proposal.** Intercom turns each proposal into a **pending action** with an ID and shows it. Jarvis's spoken reply says "I've drafted that, take a look."
- **Confirmation card:** shows exactly what will happen, with **Confirm** and **Cancel** buttons. Kevin can also edit the draft text. Voice "yes" alone is **not** enough to confirm in phase 2: a tap is required, because a misheard "yes" from the TV or a passenger shouldn't send email.
- **On Confirm,** Intercom carries out that exact pending action, unchanged, by ID:
  - **By script where one exists** (preferred: predictable, does exactly what the card showed). Email goes through Jarvis's `kevin_mail_send.py`; other scripts are added per action type.
  - **Otherwise through Jarvis's webhook channel** (`127.0.0.1:8644`, already on; Rivendell uses it to nudge Gandalf), where Jarvis has his normal tools: "Kevin confirmed this exact action: …; do exactly this and report the result." Signed like Rivendell's nudges.
  - The result ("Sent to Brent at 10:42") is spoken and shown.
- **Expiry:** pending actions expire after 10 minutes or when the conversation resets.
- **Siri Shortcut:** actions aren't available there; it says "Open Intercom to confirm" and sends a link.
- **Audit:** each confirmed action is logged to `Jarvis/` in the vault with time, device, transcript and result.
- **Rules from Preferences still apply** (for example quiet hours, and OOO entries never counting as conflicts).
- **Later, maybe:** a spoken confirmation code for hands-free use in the car, if tapping proves impractical there.

## 15. Testing

- **Unit (vitest):** intent matching for the briefing cache, sentence splitting, TTS text cleanup, card parsing, session key handling, auth.
- **API (supertest):** every route against a stub Hermes and a stub sidecar, including streaming, timeouts, retry with the same turn ID, and 403 without identity.
- **Sidecar (pytest):** STT accuracy on 20 recorded clips of Kevin's real questions, with VIP names, against a word error rate target; TTS output for numbers, times, emails and abbreviations.
- **Read-only proof:** 30 scripted requests to send, reply, accept, delete, schedule or remind, run against Jarvis's API channel with a dry-run mail and calendar. Pass means zero side effects and a spoken "can't do that by voice yet."
- **Wake word:** false-trigger count over 1 hour of TV and conversation (target under 1 per hour on Normal); detection rate on 50 real "Hey Jarvis" attempts at 1 m and 3 m (target 90% or more on Normal).
- **Devices:** iPhone Safari (installed and in the browser), MacBook Safari and Chrome, AirPods mic, the Shortcut on a locked phone.
- **Latency log** per turn so the targets in §6 can be checked with real use.

## 16. Build order

**Phase 1a — talk and listen (push-to-talk)**
1. Confirm how Jarvis reads Mail and Calendar, and settle the read-only toolset (§8).
2. Turn on the Hermes API server with no tools on that channel.
3. Voice sidecar: STT and TTS.
4. Intercom server: auth, `/api/turn`, streaming, sentence TTS, sessions.
5. PWA: push-to-talk, conversation, text input, mute, settings.
6. Install, launchd, `tailscale serve`, healthz.

**Phase 1b — faster and hands-free**
7. Wake word in the browser, follow-up window, barge-in, wake lock.
8. Status lines while Hermes works.
9. Briefing cache.
10. Cards.
11. Siri Shortcut and `/api/ask`.

**Phase 1c — polish**
12. Custom "Hey J" wake word.
13. Voice and speed presets.

**Phase 2 — actions with confirmation (§14)**

## 17. Open questions

1. How does Jarvis read Mail and Calendar today, and can it be done without `terminal`? (Blocks §8.)
2. Should Intercom share a conversation with iMessage, so "what did I just ask you on my phone?" works? Proposed: no, separate sessions, but both are searchable by Jarvis.
3. The default voice: British male (`bm_george`) or something else?
4. Wake-word phrase for phase 1: is "Hey Jarvis" fine until "Hey J" is trained?
5. Is the triage log enough for the "tier 1 today" fast path, or should that always ask Hermes live?

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
- **Built (2026-11-17):** `web/wakeword.js` (detector plus a 16 kHz resampling AudioWorklet), models fetched by `install.sh` into `web/models/`, onnxruntime-web served from `/vendor/ort`. Threshold 0.5, fixed for now (no sensitivity presets or test mode yet). Tap mode and the follow-up window end 3 s after Kevin stops talking (changed from about 1 s at his request).
- **"Hey J":** not in phase 1. openWakeWord can train custom phrases from synthetic speech. That's a phase 1c task, using the same browser pipeline with a different model file.
- **Fallback:** if a browser can't run the model (old device, no WebAssembly SIMD), the toggle is disabled with the reason, and push-to-talk still works.

## 6. A turn, end to end

1. **Capture:** browser records 16 kHz mono (Opus in WebM on Chrome, AAC/MP4 on Safari) and uploads it to `POST /intercom/api/turn` with a turn ID (used as the idempotency key).
2. **Transcribe:** the server sends the audio to the sidecar's `/stt`. `mlx-whisper large-v3-turbo` takes about 0.3 to 0.8 s for a short request on the M6. A **name hint** is passed as the initial prompt: the names and companies from the Preferences VIP list (Brent Layton, Zane Yates, Jared Allgood, Bagley Strategies, Healthy Together…), so they're spelled right. Empty or near-silent audio ends the turn with "Didn't catch that" and no Hermes call.
3. **Show the transcript** immediately, so Kevin can see what was heard and cancel if it's wrong.
4. **Fast path (§7):** if the transcript matches a briefing intent and the cached answer is fresh, answer from the cache.
5. **Ask Jarvis:** `POST /v1/responses` with `stream: true` to Jarvis's default profile, `X-Hermes-Session-Key: intercom-<device>-<conversation>`, and the voice instructions (§9) plus the transcript as `input`.
6. **(Changed again 2026-11-17, after iPhone use: answers from the cache still left 11–19 s of silence. Now a filler plays whenever nothing has been said 3 s after the question arrives — cached or not — and a second after 13 s; fillers are pre-synthesized and suit any question: "One moment, sir.") (Earlier the same day: Kevin found task-specific status lines unnatural. Now a short varied filler — "One sec.", "Let me look." — after 4 s, only when the turn has to fetch live data; never for cached answers or replies.)** Originally: **Say what he's doing:** while Hermes streams tool-progress events, Intercom speaks at most one short status line, once, after 2.5 s, chosen from the tool being used: "Checking your inbox…", "Looking at your calendar…", "Pulling up the headlines…". If the answer arrives first, nothing is said.
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
- **Built (2026-11-17): prefetch.** Instead of condensing briefings via a webhook, Intercom keeps the live gatherers warm: mail and calendar (2 days of mail, one set serving mail, calendar and mixed questions) and both digests are refreshed every 5 minutes from 06:00 to 23:00 (`INTERCOM_PREFETCH_MINUTES`, `_FROM`, `_UNTIL`) and reused for up to 6 minutes. "Check again", "anything new" and similar always fetch live. Data older than a minute is labelled with its fetch time in the context. Calendar questions use the prefetched calendar too, since it is at most 5 minutes old.
- **Built (2026-11-17): replies.** Replies and sign-offs ("thanks", "no thanks", "let's have the demo take priority") look nothing up; a follow-up reuses the last topic only when it is question-shaped. Jarvis acknowledges stated decisions briefly instead of explaining voice limits.
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
- **Permissions (settled 2026-11-16):** Intercom's launch agent starts Node through `/usr/bin/osascript`, exactly like `ai.hermes.gateway`, so macOS attributes it to osascript and it uses the Full Disk Access already granted there (Mail's index). Node itself is granted nothing. The calendar comes from `Hermes Calendar Helper.app` (which holds Calendar access) via Intercom's `scripts/calendar.sh`, which waits for the helper to exit instead of using `open -W`; `open -W` failed intermittently with "Unable to block on applications" when the helper exited quickly.
- **Test:** a scripted suite of "send / reply / accept / delete / remind me" requests must produce zero side effects (§15).

## 9. Voice persona and reply style

The voice instructions sent with every turn:

- Lead with the answer. 1 to 4 sentences. No markdown, bullets, tables, URLs or emoji.
- Use names, not email addresses. Times as "10:30" or "half past ten", not "10:30:00".
- For lists of more than 3 items, say the count, read the top 3, then "want the rest?"
- Say when something is uncertain or the data is old.
- For email, say who, roughly what about, and whether they're asking for something. Read the body only when asked.

**Voice:** Kokoro `bm_george` (British male) by default, at speed 1.3. Settings let Kevin choose between 4 preset voices, preview them, and change the speed (0.9 to 1.3). The text sent to TTS is cleaned first: "@" in addresses is spoken, abbreviations are expanded (Tue → Tuesday), and stray symbols are removed.

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

Phase 2 lets Jarvis act by voice, but only after Kevin confirms on screen. **Revised 2026-11-17** after Kevin chose the actions and a spike against Hermes.

### 14.1 Actions (Kevin's priorities)

| Action | What Jarvis can propose | How Intercom carries it out on Confirm |
|---|---|---|
| **To-dos** | add (title, optional due date, notes, list), complete, change due date or title | Slotherium's MCP server (`127.0.0.1:4173/mcp`: `add_todo`, `complete_todo`, `update_todo`), called directly by Intercom. `source: "intercom"`. |
| **Calendar invites** | accept, decline or tentative for one invite where Kevin is an attendee | **To decide (§14.5).** Apple's EventKit can read invites but cannot reply to them. |
| **Simple email replies** | a short plain-text reply to one specific email | Apple Mail via AppleScript: `reply` to that exact message (found by its Mail id), sent from the account it arrived on. Reply to the sender only, unless Kevin says "reply all". |

Not in phase 2: new emails to arbitrary people, texts, creating events. `kevin_mail_send.py` is not usable here: it only sends from Jarvis's iCloud to Kevin.

### 14.2 How Jarvis proposes (spike result)

- **Spike (2026-11-17):** Hermes's API server accepts a `tools` field in `/v1/responses`, but **does not pass client-defined tools to the model**; it reports only its own tool calls. So proposal *tools* are out.
- **Instead, a hidden block,** exactly like cards: Jarvis ends his spoken answer with a fenced `intercom-action` JSON block, never spoken. Examples:
  `{"kind":"todo.add","title":"Send Brent the Mississippi deck","due_date":"2026-11-20"}`,
  `{"kind":"todo.complete","id":"…"}`,
  `{"kind":"invite.respond","event_uid":"…","response":"accept"}`,
  `{"kind":"email.reply","message_id":"…","body":"…","reply_all":false}`.
- The Hermes channel stays tool-less, so nothing Jarvis says can act by itself. The voice instructions tell Jarvis the block format only when actions are on.
- To make proposals possible, the read-only context gains what Jarvis needs to name things exactly: open to-dos with their ids (Slotherium `list_todos`), pending invites with their event ids and Kevin's response status, and Mail ids for the emails already listed.

### 14.3 Confirmation

- Intercom validates each block against a strict schema, then checks it against reality: the to-do id exists; the invite exists and Kevin is an attendee with a pending response; the email exists in Kevin's inbox, and the reply goes only to its sender (or, with reply-all, its existing recipients). A block that fails is dropped and logged, never shown.
- A valid block becomes a **pending action** held on the server (ID, expiry, exact payload). The page shows a confirmation card with exactly what will happen: the to-do text and date, "Accept: ISM prep, Wed 3:00–3:30", or the email's recipient, subject and full reply text. Kevin can edit the text and date before confirming.
- **Confirm requires a tap.** A spoken "yes" isn't enough, because a misheard "yes" from the TV or a passenger shouldn't send email. Jarvis says something like "It's ready for you to confirm, sir."
- On Confirm, the page sends only the pending action's ID (plus Kevin's edits). Intercom runs it once (idempotent), then speaks and shows the result ("Added to your list, due Friday", "Accepted", "Sent to Brent at 10:42").
- Pending actions expire after 10 minutes or when the conversation resets.
- **Siri Shortcut:** no actions; it says "Open Intercom to confirm, sir."
- **Audit:** each confirmed or failed action is appended to `Jarvis/Intercom actions.md` in the vault, with time, device, the spoken request, exactly what was done and the result.
- **Switch:** everything in phase 2 is behind `INTERCOM_ACTIONS=1`. With it off, Intercom behaves exactly as in phase 1.

### 14.4 Safety notes

- Email content stays data: a proposal is only accepted from Jarvis's reply to a question Kevin just asked, and the confirmation card always shows the exact effect. Nothing ever runs without the tap.
- The executor never takes recipients, ids or accounts from Jarvis that it hasn't checked against Mail, Calendar or Slotherium.
- Kevin's Preferences ("Never do", "Writing and communication") are given to Jarvis when he drafts a reply; both are empty today.

### 14.5 Open decision: how to answer invites

Kevin's events come from two accounts, **Healthy Together** (kbagley@twenty.co) and **Bagley Strategies** (kevin@bagleystrategies.com). Options:

1. **Google Calendar API** for each account (one-time sign-in per account). Updates the response everywhere, exactly as tapping Accept in Google Calendar does. **Recommended**, if both accounts are Google and twenty.co's admin allows it.
2. **Reply to the invitation email** (an iCalendar REPLY sent from Apple Mail). Needs no sign-in and the organizer sees the answer, but Kevin's own copy of the event may still show "no response".
3. **Clicking Accept in Calendar.app by UI automation.** Possible, but fragile; last resort.

First step: confirm which service hosts each account, then pick.

### 14.6 Recommendations for the rest (researched 2026-11-17; Kevin: to-dos are priority 1)

**To-dos (built, priority 1).** Add, complete, reschedule and rename, with "Confirm all" for several at once; Jarvis sees open and recently completed to-dos and remembers the conversation. Next, if Kevin wants them:
- *Voice confirm for to-dos only.* To-dos are low-risk and easy to undo, so "yes, add it" could confirm a to-do card by voice (email would still need a tap). Kevin's call.
- *Household lists and assignment* ("add milk to the household list", "give that one to Blair"): Slotherium supports `list` and `assigned_to`, but Intercom would need the household's list names and user ids.

**Calendar (recommended next).** Both of Kevin's accounts (Bagley Strategies, Healthy Together / twenty.co) are Google accounts in macOS.
1. *See invites and responses:* an Intercom calendar helper (its own small app, so Jarvis's helper and his briefing are untouched) reading EventKit with attendees and Kevin's response. Needs one Calendar-access approval on the Mac mini's screen.
2. *Create and move events:* EventKit can write to both Google calendars (changes sync up). Same confirmation card.
3. *Accept or decline invites:* EventKit and Calendar.app can't. Try first replying to the invitation email with an iCalendar REPLY from Apple Mail (no sign-in; the organizer is updated; check whether Kevin's own copy updates too). If it doesn't, use Google Calendar's API with a one-time sign-in per account; twenty.co's administrator may block third-party sign-in, which would leave Healthy Together invites on the email route.
4. *Jarvis in iMessage:* if this becomes a shared calendar service, give Jarvis's other channels read-only access at first, so an email can't talk him into changing the calendar.

**Email.** Replies to the sender (or reply-all on request) are built; a real send is still untested. Recommend stopping there for now: new emails to arbitrary people and forwards add risk (wrong recipient) for little voice value.

**Texts.** Not possible as Kevin: Messages on the Mac mini is signed in as Jarvis, so anything sent comes from Jarvis. "Text me a reminder at 3" can be a to-do with a due time, or a Jarvis cron reminder, instead.

**Siri Shortcut (read-only quick win).** `/api/ask` exists; the Shortcut needs building and a check that Tailscale identity reaches it.

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
7. ✅ Wake word in the browser, follow-up window, barge-in, wake lock (2026-11-17).
8. ✅ Fillers while Jarvis works (revised twice on 2026-11-17, §6).
9. ✅ Prefetch in place of the briefing cache (2026-11-17, §7).
10. ✅ Read to-dos: Slotherium `list_todos` as a read-only topic ("what's on my list?"), with ids (needed for phase 2).
10b. ✅ Other profiles and apps (2026-11-17, Kevin's request): Fangorn's research (Entmoot), Gandalf's LinkedIn plan (Rivendell), Mind Stone, and the household dashboard, as read-only topics (`scripts/vault_gather.py`, dashboard `/api/status`). Friday (a separate macOS user's agent) is deliberately left out.
11. Invites in the calendar context (waits on §14.5: Google's API would supply these): Kevin's response status and the organizer for each event (additive fields in the calendar helper's output).
12. Cards: check the email, agenda and headline cards on the phone and give them the brand look.
13. Siri Shortcut: build it on `/api/ask`, check that Tailscale identity reaches it, and fall back to a per-device key if it doesn't.

**Phase 1c — polish**
14. Custom "Hey J" wake word (deferred by Kevin).
15. Voice and speed presets.

**Phase 2 — actions with confirmation (§14), behind `INTERCOM_ACTIONS=1`**
16. ✅ `intercom-action` blocks: parsing, validation, pending-action store, confirmation card with edit, Confirm/Cancel, expiry, audit log.
17. ✅ To-dos: add, complete, update via Slotherium.
18. ✅ Email replies via Apple Mail (`scripts/mail_find.py` finds the exact message read-only; `scripts/mail_reply.applescript` replies from its account). Tested end to end up to the confirmation card; a real send has not been tested.
19. Invites, once §14.5 is decided.

Phases 1b and 2 are planned together and can be built in one stretch, but released separately: 1b is read-only, and phase 2 goes live behind its switch so it can be turned off without affecting daily use.

## 17. Open questions

0. **(New)** How to answer calendar invites (§14.5).

1. How does Jarvis read Mail and Calendar today, and can it be done without `terminal`? (Blocks §8.)
2. Should Intercom share a conversation with iMessage, so "what did I just ask you on my phone?" works? Proposed: no, separate sessions, but both are searchable by Jarvis.
3. The default voice: British male (`bm_george`) or something else?
4. Wake-word phrase for phase 1: is "Hey Jarvis" fine until "Hey J" is trained?
5. Is the triage log enough for the "tier 1 today" fast path, or should that always ask Hermes live?

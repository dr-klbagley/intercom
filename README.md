# Intercom

Talk to Jarvis out loud from your iPhone or MacBook. Hold the button (or tap once), ask, and Jarvis answers in his own voice. It sits alongside Entmoot, Rivendell and Mind Stone on the Mac mini, and you reach it over Tailscale at:

**https://kevins-mac-mini.tail6c0069.ts.net/intercom/**

Design: [docs/specs/2026-11-16-intercom-design.md](docs/specs/2026-11-16-intercom-design.md).

## What works in this version (phase 1a)

- **Push-to-talk:** hold the button (or the space bar on a Mac) and release to send. A quick tap starts listening, and it sends by itself 3 seconds after you stop talking.
- **"Hey Jarvis" wake word:** turn on the "Hey Jarvis" pill in the header. Detection runs on the phone or Mac itself (openWakeWord's published model in onnxruntime-web), so no audio leaves the device until it hears the wake word. After he answers, the mic stays open briefly for a follow-up, and saying "Hey Jarvis" while he's talking interrupts him. It only works while the page is open and the screen is on (it keeps the screen awake). "Hey J" needs a custom-trained model and isn't in yet.
- **Mail and calendar questions** ("any emails from tier 1 today?", "what's on tomorrow?"), **headlines** and **the morning briefing**.
- **Follow-ups** keep the thread ("and Thursday?"). Replies and sign-offs ("let's go with the demo", "no, thanks") look nothing up; Jarvis answers from the conversation in a second or two.
- **Prefetch:** mail, calendar and the two digests are refreshed in the background every 5 minutes from 6 am to 11 pm, so most questions skip the 3-second fetch. "Check again" or "anything new?" always fetches live.
- **Fillers:** whenever nothing's been said 3 seconds after the question arrives, a short varied line ("One moment, sir."), and a second one past 13 seconds. They're recorded in advance, so they play instantly.
- **"Sir":** Jarvis addresses Kevin as "sir", sparingly, never by name.
- **Speech model kept warm:** the sidecar transcribes a second of silence every 3 minutes, so macOS doesn't page Whisper out between questions (that once cost 12 s).
- **Timings in the log:** each turn logs ms from arrival for stt, gather, firstToken, firstAudio and filler.
- **Spoken replies** sentence by sentence, with the text and cards (emails, agenda, headlines) on screen. Mute, replay, typed questions and new conversation.
- **Other apps and profiles:** open to-dos (Slotherium), Fangorn's research briefs and questions (Entmoot), Gandalf's LinkedIn plan (Rivendell), Mind Stone's proposals and corrections, and whether everything on the Mac mini is running (the household dashboard).
- **Actions with confirmation (phase 2, `INTERCOM_ACTIONS=1`, on):** "add a to-do…", "mark the doctor one done", "move that to Monday", "reply to LaQuetta and say…". Jarvis drafts it and a card shows exactly what will happen, editable. **To-dos:** answer "yes" or "no" out loud (or tap). **Email:** nothing is sent until you tap **Confirm**. To-dos go through Slotherium, replies through Apple Mail (to the real sender of the email Intercom found itself). Every confirm or cancel is logged in `Jarvis/Intercom actions.md` in the vault. Calendar actions aren't in yet (spec §14.5).
- **Siri Shortcut endpoint** (`POST api/ask`); the Shortcut itself comes in phase 1b.

If Hermes is down he says "My servers appear to be unreachable at the moment." (the browser says it itself if Intercom can't be reached at all). Times are spoken without the colon ("3 30"), which Kokoro otherwise pauses on.

Not yet: "Hey J", the Siri Shortcut itself, card polish, and calendar actions. See the spec's build order (§16).

## How it works

```
Phone/Mac browser ─ tailscale serve /intercom ─► Intercom server (Node, 127.0.0.1:4177)
                                                   ├─ speech sidecar (Python, 127.0.0.1:4178): Whisper in, Kokoro out
                                                   ├─ read-only gatherers: Jarvis's own Mail/Calendar scripts, digest emails
                                                   └─ Hermes API (127.0.0.1:8642): Jarvis himself, no tools on this channel
```

- **Read-only by design.** Intercom gathers the context (the same scripts the 07:30 briefing uses) and Jarvis only answers from it. Jarvis's API server channel has no tools (his iMessage, cron and other channels keep theirs), so nothing said in an email or a question can make him act. It's Jarvis's own profile, so Intercom always gets the current Jarvis and voice chats share his history.
- **Mail and Calendar access.** Intercom's service starts through `/usr/bin/osascript`, exactly like the Hermes gateway, so it uses the Full Disk Access and Calendar access already granted there; Node itself is granted nothing. The calendar comes from Jarvis's `Hermes Calendar Helper.app` via `scripts/calendar.sh` (which avoids `open -W`, flaky when the helper exits quickly).
- **Private.** Tailnet only (never Funnel), and only Kevin's Tailscale login gets in. Audio stays on the Mac mini and is discarded after transcription. Logs hold timings only.

## Model

Intercom uses Jarvis's default model (GPT-6 Sol). `INTERCOM_HERMES_MODEL` plus `INTERCOM_HERMES_PROVIDER` (a `custom_providers` name in Jarvis's config, e.g. `ollama-local`) switch Intercom alone to another model. Tested 2026-11-17: Gemma 4 12B on the Mac mini took 20–190 s per turn with thinking on (about 17 s at best with thinking off) and got facts wrong, against 1–7 s for GPT-6 Sol, so the default stays.

## Install

As `jarvis`, from this folder:

    scripts/install.sh

It builds the app, sets up the speech models (about 2 GB on first run), sets Jarvis's API server channel to no tools and turns that server on (backing up his config first), **restarts the Hermes gateway** (Jarvis is offline for a few seconds), installs two launch agents, and adds `/intercom` to `tailscale serve`. It stops if the API channel turns out to have any tools.

After a `git pull`: `scripts/install.sh --app-only`.

## Development

    npm install
    npm test
    npm run typecheck
    npx tsx scripts/check-gather.ts   # runs the real gatherers, prints only sizes and warnings
    npx tsx scripts/compare-models.ts  # same conversations on Jarvis's default model and a local one, with timings
    node scripts/check-wakeword.mjs clip.wav   # runs the browser wake-word code on 16-bit WAVs, prints the peak score
    npm run dev                       # http://127.0.0.1:4177 (trusts local requests; needs the sidecar and Hermes running)

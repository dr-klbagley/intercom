# Intercom

Talk to Jarvis out loud from your iPhone or MacBook. Hold the button (or tap once), ask, and Jarvis answers in his own voice. It sits alongside Entmoot, Rivendell and Mind Stone on the Mac mini, and you reach it over Tailscale at:

**https://kevins-mac-mini.tail6c0069.ts.net/intercom/**

Design: [docs/specs/2026-11-16-intercom-design.md](docs/specs/2026-11-16-intercom-design.md).

## What works in this version (phase 1a)

- **Push-to-talk:** hold the button (or the space bar on a Mac) and release to send. A quick tap starts listening, and it sends by itself about a second after you stop talking.
- **Mail and calendar questions** ("any emails from tier 1 today?", "what's on tomorrow?"), **headlines** and **the morning briefing**.
- **Follow-ups** keep the thread ("and Thursday?").
- **Spoken replies** sentence by sentence, with the text and cards (emails, agenda, headlines) on screen. Mute, replay, typed questions and new conversation.
- **Siri Shortcut endpoint** (`POST api/ask`); the Shortcut itself comes in phase 1b.

Not yet: the "Hey Jarvis" wake word, the briefing cache, the status line while he works on longer answers, and actions (phase 2). See the spec's build order (§16).

## How it works

```
Phone/Mac browser ─ tailscale serve /intercom ─► Intercom server (Node, 127.0.0.1:4177)
                                                   ├─ speech sidecar (Python, 127.0.0.1:4178): Whisper in, Kokoro out
                                                   ├─ read-only gatherers: Jarvis's own Mail/Calendar scripts, digest emails
                                                   └─ Hermes API (127.0.0.1:8642): Jarvis himself, no tools on this channel
```

- **Read-only by design.** Intercom gathers the context (the same scripts the 07:30 briefing uses) and Jarvis only answers from it. Jarvis's API server channel has no tools (his iMessage, cron and other channels keep theirs), so nothing said in an email or a question can make him act. It's Jarvis's own profile, so Intercom always gets the current Jarvis and voice chats share his history.
- **Private.** Tailnet only (never Funnel), and only Kevin's Tailscale login gets in. Audio stays on the Mac mini and is discarded after transcription. Logs hold timings only.

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
    npm run dev                       # http://127.0.0.1:4177 (trusts local requests; needs the sidecar and Hermes running)

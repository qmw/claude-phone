# claude-phone

A Claude Code plugin that lets Claude **phone you and talk with you in real time**. When you pick up, a natural voice says Claude's message. After that, everything you say reaches the session and Claude answers out loud, sentence by sentence, until one of you hangs up. Use it for "call me when the build finishes" or "call me if you're blocked."

It also works the other way: **you can call Claude.** Start a session with `claude-phone` (see [Calling Claude](#calling-claude)), dial your Twilio number and talk.

Each session or project can have **its own Twilio number**. Calls from it show that number, dialling it reaches that session, and you choose who it calls and who may call it.

Calls run on [Twilio ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay). Deepgram transcribes your speech, a text-to-speech voice reads Claude's lines (ElevenLabs by default, or Amazon, Google and others), and you can interrupt the voice by talking. Claude stays the brain: it gets your sentences as text and decides every answer.

The plugin contains an **MCP server** with three tools (`call_me`, `phone_reply`, `call_me_settings`) and **slash commands**: `/call-me:setup`, `/call-me:session` and `/call-me:test`. Claude uses the tools; you use the commands.

- No dependencies: one Node.js MCP server (Node ≥ 18).
- Twilio reaches the plugin through a free Cloudflare quick tunnel, and no account is needed. If `cloudflared` isn't on your PATH, the plugin downloads it to `~/.cache/claude-call-me/` on the first call. On a server you can use your own address instead (`CALL_ME_PUBLIC_URL`).
- Webhooks are checked against Twilio's `X-Twilio-Signature`, and each call's audio socket uses an unguessable single-use path.

## Install (once per machine; then available in every session)

```bash
claude plugin marketplace add qmw/claude-phone
claude plugin install call-me@claude-phone
```

Or in one step, from the terminal or inside Claude Code: `/plugin install call-me --marketplace qmw/claude-phone`. Use `claude plugin install …` from a shell.

Then create the `claude-phone` launcher ([Calling Claude](#calling-claude)) and, inside Claude Code:

```
/call-me:setup     # writes ~/.config/claude-call-me/config.env
/call-me:test      # places a test call
```

Or set up the config by hand: copy `plugins/call-me/config.example.env` to `~/.config/claude-call-me/config.env`, fill it in, and `chmod 600` it.

Update later with `claude plugin marketplace update claude-phone && claude plugin update call-me@claude-phone`, then restart Claude Code.

### Twilio prerequisites

1. Create a Twilio account and get a phone number with voice capability.
2. Copy the Account SID and Auth Token from the Twilio console.
3. Accept the *Predictive and Generative AI/ML Features Addendum* (Console → Voice → Settings → Privacy & Security). ConversationRelay doesn't work without it.
4. On a trial account, verify your own number under *Verified Caller IDs*. Trial calls start with a short Twilio announcement.
5. Allow calls to your country under *Voice → Settings → Geo permissions*.

ConversationRelay costs $0.07 a minute on top of the line.

## Usage

Just ask: *"run the full test suite and call me with the result"* or *"if you need a decision, call me."*

`call_me(message, wait_for_reply=true, language, retries, force, engine)` rings you. The voice says `message` as soon as you pick up, and the tool returns once you have answered, or once it's clear you won't. From then on:

- every sentence you say arrives in the session as a channel event (`live="true"`, `realtime="true"`), with the recent conversation attached;
- Claude answers with `phone_reply(call_sid, message)`, which the voice says right away. `end_call: true` says the line and hangs up;
- while Claude works the line stays quiet. After 25 seconds you hear "still working on it", and again every 25 seconds. For long jobs Claude says it will call back, hangs up, and calls you later;
- when you hang up, the session gets the transcript.

`wait_for_reply: false` is a one-way notice: the voice says the message and hangs up.

`language` is `en-US` or `pl-PL` and sets speech recognition, the voice and the fixed phrases for that one call. Leave it out to use `CALL_ME_LANGUAGE`. A voice configured for one language is never used for the other, so a Polish voice won't read an English call.

Conversations need the channel that carries your words into the session, so the session must be started with `claude-phone`. A session started with plain `claude` can still deliver one-way messages; when it asks for a reply, the message is delivered and Claude is told it couldn't listen.

## Call rules

Every session follows these rules, because the plugin enforces them rather than Claude:

| What happens | Twilio sees | Rule |
| --- | --- | --- |
| You answer | Answered by a human (answering machine detection) | The conversation starts. |
| You don't pick up, or you're on another call | `no-answer` after 30 s of ringing, or `busy` | Ring your backup phones (`CALL_ME_BACKUP_NUMBERS`) one after another. If nobody answers, try the whole list again every 90 s, up to 4 more times (`CALL_ME_RETRIES`, `CALL_ME_RETRY_DELAY`). If none succeed, save the message for your callback. |
| You **reject** the call | Your carrier sends rejected calls straight to voicemail, so Twilio sees a call answered by a machine | Hang up on the voicemail and **don't retry**. Nothing the voicemail said reaches the session. Save the message and start **do-not-disturb**: further `call_me` calls from any session only save their messages, until you call back or `CALL_ME_DND_MINUTES` (120) pass. |
| You pick up and hang up at once | `completed` before detection finished | Reported as "probably didn't hear it". |

**Calling back** ends do-not-disturb. The session you call gets every saved message with your first sentence, shows them on screen, and can pass them on to the right projects. They aren't read on the phone.

Saved messages and the do-not-disturb state live in `~/.local/state/claude-call-me/state.json`, shared by all sessions of a user. Claude can pass `force: true` to override do-not-disturb, but only when you explicitly ask to be called now. `retries: 0` turns off retries for a single call.

These rules were tested on a Polish mobile carrier. If your carrier reports a rejected call as `busy` instead of sending it to voicemail, rejections are treated like a busy line and retried.

## Calling Claude

This uses Claude Code [channels](https://code.claude.com/docs/en/channels), a research preview that lets an MCP server push messages into a running session. call-me isn't on Anthropic's approved channel list, so it has to be loaded as a development channel. Create a launcher at `~/.local/bin/claude-phone`, then `chmod +x` it:

```bash
#!/usr/bin/env bash
export CALL_ME_INBOUND=1
exec claude --dangerously-load-development-channels plugin:call-me@claude-phone "$@"
```

Use it like `claude`, e.g. `claude-phone --resume <session-id>`. Channels can only be enabled when a session starts, so a session already running under plain `claude` must be restarted this way.

A `claude-phone` session:

1. Points your Twilio number's voice webhook at itself. The most recently started `claude-phone` session wins.
2. Answers calls **only from `CALL_ME_TO_NUMBER`**, the backup numbers and `CALL_ME_ALLOWED_CALLERS`. Any other caller gets `<Reject/>`: a busy tone, at no cost.
3. Greets you ("Hi, this is Claude. I'm listening.", or `CALL_ME_GREETING`), and the conversation runs as described in [Usage](#usage), as long as you like.
4. On exit, points the number back to a short "Claude is offline" message, hosted on Twilio Twimlets. That message is also set as the fallback, so it plays even if a session crashes.

Requirements: a claude.ai login and an interactive session (not `-p`). Ordinary `claude` sessions never touch the number.

Each channel event carries `from` (your phone), `to` (the Twilio number you dialled) and `machine` (`CALL_ME_MACHINE`, or the hostname by default).

## Voice

| Key | Notes |
| --- | --- |
| `CALL_ME_RELAY_TTS`, `CALL_ME_RELAY_VOICE` | The text-to-speech provider and voice, e.g. `Amazon` + `Ola-Neural` (Polish), `Google` + `pl-PL-Chirp3-HD-Aoede`, `ElevenLabs` + a voice ID. Default: ConversationRelay's voice for the language (ElevenLabs). They apply to the language set in the same config file. ElevenLabs voices stop mid-sentence when you interrupt; Amazon voices finish the sentence first. |
| `CALL_ME_RELAY_INTERRUPT` | How easily you interrupt the voice: `high` (default), `medium` or `low` |
| `CALL_ME_RELAY_IGNORE_BACKCHANNEL` | `1` ignores short words like "mhm" while the voice talks. With `low` too, a Polish call needed several attempts before it stopped |
| `CALL_ME_RELAY_FILLER` | A short word said 2.5 s after you finish a sentence while Claude works, e.g. `Mhm.` Default: none |
| `CALL_ME_GREETING` | What Claude says when you call in |

Claude can also switch the voice mid-call: `phone_reply(..., voice: "Amazon:Ola-Neural")`.

**OpenAI voice (experimental).** With `engine: "openai"` (or `CALL_ME_REALTIME_ENGINE=openai`), OpenAI's realtime model `gpt-live-1` does the talking instead. It handles small talk itself and hands real requests to Claude. It needs `OPENAI_API_KEY`, costs $0.05 a minute plus Twilio's $0.0044 a minute for the audio stream, and speaks Polish with an English accent. `CALL_ME_REALTIME_VOICE` picks its voice (default `marin`), and `CALL_ME_OWNER_NAME` tells it whose assistant it is. One-way notices and incoming calls always use ConversationRelay.

## A number per session

Every session can have its own Twilio number, so you can call the session you want and know which one is calling you. Inside a session, run `/call-me:session`, or just tell Claude, for example *"use +17255550123 for this project, call my work phone, and let my private phone call you"*. Claude then sets these with the `call_me_settings` tool:

| Setting | Meaning |
| --- | --- |
| `from_number` | The session's own Twilio number. Its calls come from this number, and dialling it reaches this session. It must be on your Twilio account. |
| `to_number` | The phone the session calls. It is also allowed to call in. |
| `backup_numbers` | Phones called next, in order, when `to_number` doesn't pick up or is busy. They may call in too. |
| `allowed_callers` | Other phones allowed to call the session. |
| `language`, `answer_calls` | The session's default call language, and whether it answers its number. |

Settings are saved for the **project directory**, in `~/.config/claude-call-me/projects/<dir>.env`, so a resumed or new session in the same project keeps them. Pass `scope: "session"` for a change that lasts only until the session ends. Anything not set falls back to the machine config. A change takes effect immediately: the session releases its old number and takes over the new one.

To answer calls, the session must be started with the `claude-phone` launcher. `list_numbers` shows every number on the account and whether a session already answers it. If two sessions use the same number, the one that claimed it last answers.

Saved messages and do-not-disturb are shared by all sessions of a user on a machine. If you reject a call from one session, the others hold their calls too, until you call any of them back.

## Several machines

Install the plugin on each machine and copy `~/.config/claude-call-me/config.env` there (keep it `chmod 600`: it holds your Twilio token). Give each machine, or each project on it, its own `TWILIO_FROM_NUMBER`, and name it with `CALL_ME_MACHINE`. Don't copy the `projects/` folder: those settings belong to project directories on the original machine.

**On a server**, a permanent [Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is more reliable than quick tunnels, which Cloudflare sometimes rate-limits. Route a hostname to a local port and set `CALL_ME_PORT` and `CALL_ME_PUBLIC_URL=https://<hostname>`. Several Linux users on one server each need their own number, port and hostname; one tunnel can carry all of them. Run each session in `tmux` so it survives logging out.

**Cost tip:** Twilio numbers in your own country make calling Claude a domestic call, and Claude's calls to you cheaper. A Polish geographic number is about $3 a month. Polish numbers need a Twilio regulatory bundle: an ID, plus an address in the area of the number's prefix.

## Windows

The plugin runs on Windows with Node 18 or newer, in the Claude Code CLI or in the Code tab of the Claude Desktop app. Install it the same way. On the first call it downloads `cloudflared.exe` to `%USERPROFILE%\.cache\claude-call-me\`. Alternatively, install it yourself with `winget install Cloudflare.cloudflared`. The config file is `%USERPROFILE%\.config\claude-call-me\config.env`.

Conversations need the `--dangerously-load-development-channels` flag, so they work only in the CLI. The Desktop app can't pass the flag, but it can still deliver one-way messages. A PowerShell version of the launcher:

```powershell
$env:CALL_ME_INBOUND = "1"; claude --dangerously-load-development-channels plugin:call-me@claude-phone @args
```

## Config

| Key | Required | Notes |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | ✓ | |
| `TWILIO_AUTH_TOKEN` | ✓ | |
| `TWILIO_FROM_NUMBER` | ✓ | Your Twilio number, E.164 format |
| `CALL_ME_TO_NUMBER` | ✓ | Your phone, E.164 format. Claude calls it, and it may call in |
| `CALL_ME_BACKUP_NUMBERS` | | Backup phones, comma-separated E.164, called in this order when `CALL_ME_TO_NUMBER` doesn't pick up |
| `CALL_ME_ALLOWED_CALLERS` | | More phones that may call in, comma-separated E.164 |
| `CALL_ME_MACHINE` | | Name of this machine, reported with inbound calls (default: hostname) |
| `CALL_ME_LANGUAGE` | | Default language: `en-US` (default) or `pl-PL` |
| `CALL_ME_RELAY_*`, `CALL_ME_GREETING` | | The voice, see [Voice](#voice) |
| `CALL_ME_VOICE` | | Twilio `<Say>` voice of the "Claude is offline" message (built-in: `Polly.Joanna`, `Polly.Ewa`) |
| `CALL_ME_RETRIES` | | Extra attempts when you don't pick up (default 4) |
| `CALL_ME_RETRY_DELAY` | | Seconds between attempts (default 90) |
| `CALL_ME_DND_MINUTES` | | How long a rejected call holds further calls if you don't call back (default 120) |
| `CALL_ME_AMD` | | `0` turns off answering machine detection, which costs about $0.0075 per call. Rejections then can't be detected, and a voicemail greeting would reach the session as if you had said it |
| `CALL_ME_STATE_DIR` | | Where saved messages are kept (default `~/.local/state/claude-call-me`) |
| `CALL_ME_ANSWER` | | `0` = don't answer calls even when started with `claude-phone` (usually set per project with `call_me_settings`) |
| `CALL_ME_INBOUND` | | `1` = take over the number and hold conversations (set by the `claude-phone` launcher) |
| `CALL_ME_PUBLIC_URL` | | Use your own public URL instead of a quick tunnel |
| `CALL_ME_PORT` | | Local webhook port (default: random) |
| `CALL_ME_REALTIME_ENGINE`, `OPENAI_API_KEY`, `CALL_ME_REALTIME_VOICE`, `CALL_ME_OWNER_NAME` | | The optional OpenAI voice, see [Voice](#voice) |

Settings are applied in this order, later ones winning: the machine config file, the project file written by `call_me_settings`, environment variables with the same names, and changes made with `scope: "session"`. `CALL_ME_CONFIG` points to a different config file.

## Development

```bash
npm test
claude --plugin-dir plugins/call-me   # try local changes without installing
```

## License

MIT, see [LICENSE](LICENSE).

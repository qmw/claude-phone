# claude-phone

A Claude Code plugin that lets Claude **phone you**. Claude speaks a message aloud using Twilio text-to-speech, then listens for your spoken or keypad reply and returns it to the session. Use it for "call me when the build finishes" or "call me if you're blocked."

It also works the other way: **you can call Claude.** Start a session with `claude-phone` (see [Calling Claude](#calling-claude-inbound)), dial your Twilio number, and say what you want. Your words arrive in that session and Claude starts working.

Each session or project can have **its own Twilio number**. Calls from it show that number, dialling it reaches that session, and you choose who it calls and who may call it.

The plugin contains an **MCP server** with three tools (`call_me`, `phone_reply`, `call_me_settings`) and **slash commands**: `/call-me:setup`, `/call-me:session` and `/call-me:test`. Claude uses the tools; you use the commands.

- No dependencies: one Node.js MCP server (Node ≥ 18).
- Your reply comes back through a webhook. A free Cloudflare quick tunnel exposes it, and no account is needed. If `cloudflared` isn't on your PATH, the plugin downloads it to `~/.cache/claude-call-me/` on the first call that waits for a reply.
- Webhook requests are checked against Twilio's `X-Twilio-Signature` and an unguessable per-call path.

## Install (once per machine; then available in every session)

```bash
claude plugin marketplace add qmw/claude-phone
claude plugin install call-me@claude-phone
```

Or in one step, from the terminal or inside Claude Code: `/plugin install call-me --marketplace qmw/claude-phone`. Use `claude plugin install …` from a shell.

Then, inside Claude Code:

```
/call-me:setup     # writes ~/.config/claude-call-me/config.env
/call-me:test      # places a test call
```

Or set up the config by hand: copy `plugins/call-me/config.example.env` to `~/.config/claude-call-me/config.env`, fill it in, and `chmod 600` it.

Update later with `claude plugin marketplace update claude-phone && claude plugin update call-me@claude-phone`, then restart Claude Code.

### Twilio prerequisites

1. Create a Twilio account and get a phone number with voice capability.
2. Copy the Account SID and Auth Token from the Twilio console.
3. On a trial account, verify your own number under *Verified Caller IDs*. Trial calls start with a short Twilio announcement.
4. Allow calls to your country under *Voice → Settings → Geo permissions*.

## Usage

Just ask: *"run the full test suite and call me with the result"* or *"if you need a decision, call me."*

The tool is `call_me(message, wait_for_reply=true, timeout_seconds=180, language, stay_on_line)`. A second tool, `phone_reply`, continues a [live conversation](#live-conversation). `language` is `en-US` or `pl-PL` and sets the voice, the fixed phrases and speech recognition for that one call. Leave it out to use `CALL_ME_LANGUAGE`. A session can tell Claude "call me in English" and it will pass `language: "en-US"`.

It returns one of:

- your transcribed reply
- the keys you pressed
- a status: no answer, busy, or no reply

## Call rules

Every session follows these rules, because the plugin enforces them rather than Claude:

| What happens | Twilio sees | Rule |
| --- | --- | --- |
| You answer | `completed`, answered by a human | Deliver the message and return your reply. |
| You don't pick up, or you're on another call | `no-answer` after 30 s of ringing, or `busy` | Retry every 90 s, up to 4 more times (`CALL_ME_RETRIES`, `CALL_ME_RETRY_DELAY`). If none succeed, save the message for your callback. |
| You **reject** the call | Your carrier sends rejected calls straight to voicemail, so Twilio sees a call answered by a machine (answering machine detection) | Hang up without leaving a voicemail and **don't retry**. Save the message and start **do-not-disturb**: further `call_me` calls from any session only save their messages, until you call back or `CALL_ME_DND_MINUTES` (120) pass. |
| You pick up and hang up at once (detection off) | `completed`, under 3 s | Reported as "probably didn't hear it". |

**Calling back** ends do-not-disturb. The `claude-phone` session first reads you every saved message, each in its own language and prefixed with its project, then listens as usual. The session receives what you said plus the list of messages you heard, so it can route your answer to the right project.

Saved messages and the do-not-disturb state live in `~/.local/state/claude-call-me/state.json`, shared by all sessions. Claude can pass `force: true` to override do-not-disturb, but only when you explicitly ask to be called now. `retries: 0` turns off retries for a single call.

These rules were tested on a Polish mobile carrier. If your carrier reports a rejected call as `busy` instead of sending it to voicemail, rejections are treated like a busy line and retried.

## Calling Claude (inbound)

This uses Claude Code [channels](https://code.claude.com/docs/en/channels), a research preview that lets an MCP server push messages into a running session. call-me isn't on Anthropic's approved channel list, so it has to be loaded as a development channel. Create a launcher at `~/.local/bin/claude-phone`, then `chmod +x` it:

```bash
#!/usr/bin/env bash
export CALL_ME_INBOUND=1
exec claude --dangerously-load-development-channels plugin:call-me@claude-phone "$@"
```

Use it like `claude`, e.g. `claude-phone --resume <session-id>`. Channels can only be enabled when a session starts, so a session already running under plain `claude` must be restarted this way.

A `claude-phone` session:

1. Points your Twilio number's voice webhook at itself. The most recently started `claude-phone` session wins.
2. Answers calls **only from `CALL_ME_TO_NUMBER`** and the numbers in `CALL_ME_ALLOWED_CALLERS`. Any other caller is rejected.
3. Greets you, transcribes what you say in `CALL_ME_LANGUAGE`, and pushes it into the session. Claude treats it as your request and calls you back with `call_me` when it's done or needs a decision.
4. On exit, points the number back to a short "Claude is offline" message, hosted on Twilio Twimlets. That message is also set as the fallback, so it plays even if a session crashes.

Requirements: a claude.ai login and an interactive session (not `-p`). Ordinary `claude` sessions never touch the number.

Each channel event carries `from` (your phone), `to` (the Twilio number you dialled) and `machine` (`CALL_ME_MACHINE`, or the hostname by default).

## Live conversation

A call can stay open, so you and Claude talk back and forth in real time:

- **When you call in**, you stay on the line after you speak. Claude answers with `phone_reply`, which speaks its line, listens and returns your next sentence. This repeats until Claude ends the call with `end_call: true`. Set `CALL_ME_LIVE=0` to go back to "got it, passing it on" and hang up.
- **When Claude calls you**, it passes `stay_on_line: true` to `call_me` when you may want to talk it through. After your reply, the call goes on the same way. This works in any session; channels aren't needed.

While Claude thinks, you hear silence. After 4 seconds you hear "one moment", and every 25 seconds "still working on it". Each turn takes a few seconds, because Claude reads your words as text and the answer is spoken by text-to-speech. If Claude doesn't answer within `CALL_ME_LIVE_HOLD` seconds (default 120), it says it will call back and hangs up. For longer jobs, such as handing a task to another session, Claude says it will call back, ends the call, and later uses `call_me`.

Claude always finishes its line, and it starts listening when the line ends, so anything you say during the line isn't heard. Set `CALL_ME_BARGE_IN=1` to be able to interrupt by talking, but then any sound on your side, including background noise, can cut the line off. If you stay silent twice after a line, the call ends.

## A number per session

Every session can have its own Twilio number, so you can call the session you want and know which one is calling you. Inside a session, run `/call-me:session`, or just tell Claude, for example *"use +17255550123 for this project, call my work phone, and let my private phone call you"*. Claude then sets these with the `call_me_settings` tool:

| Setting | Meaning |
| --- | --- |
| `from_number` | The session's own Twilio number. Its calls come from this number, and dialling it reaches this session. It must be on your Twilio account. |
| `to_number` | The phone the session calls. It is also allowed to call in. |
| `allowed_callers` | Other phones allowed to call the session. |
| `language`, `answer_calls` | The session's default call language, and whether it answers its number. |

Settings are saved for the **project directory**, in `~/.config/claude-call-me/projects/<dir>.env`, so a resumed or new session in the same project keeps them. Pass `scope: "session"` for a change that lasts only until the session ends. Anything not set falls back to the machine config. A change takes effect immediately: the session releases its old number and takes over the new one.

To answer calls, the session must be started with the `claude-phone` launcher. `list_numbers` shows every number on the account and whether a session already answers it. If two sessions use the same number, the one that claimed it last answers.

Saved messages and do-not-disturb are shared by all sessions on a machine. If you reject a call from one session, the others hold their calls too, until you call any of them back.

## Several machines

The same works across machines. Install the plugin on each machine, run `/call-me:setup` with the same Twilio account, and give each machine, or each project on it, its own number. `CALL_ME_MACHINE` names the machine in inbound call events. The default is the hostname.

**Cost tip:** Twilio numbers in your own country make calling Claude a domestic call. A Polish geographic number is about $3 a month, and calls to it fall under unlimited domestic minutes. Calling a US number from Poland is billed as international. Polish numbers need a Twilio regulatory bundle: an ID, plus an address in the area of the number's prefix.

## Windows

The plugin runs on Windows with Node 18 or newer, in the Claude Code CLI or in the Code tab of the Claude Desktop app. Install it the same way. On the first call that waits for a reply it downloads `cloudflared.exe` to `%USERPROFILE%\.cache\claude-call-me\`. Alternatively, install it yourself with `winget install Cloudflare.cloudflared`. The config file is `%USERPROFILE%\.config\claude-call-me\config.env`.

Calling Claude needs the `--dangerously-load-development-channels` flag, so it works only in the CLI. The Desktop app can't pass the flag, but it can still call you. A PowerShell version of the launcher:

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
| `CALL_ME_ALLOWED_CALLERS` | | More phones that may call in, comma-separated E.164 |
| `CALL_ME_MACHINE` | | Name of this machine, reported with inbound calls (default: hostname) |
| `CALL_ME_LANGUAGE` | | Default language: `en-US` (default) or `pl-PL`. Sets the voice, phrases and speech recognition |
| `CALL_ME_VOICE` | | Voice for the default language. Built-in voices: `Polly.Joanna` (en-US), `Polly.Ewa` (pl-PL) |
| `CALL_ME_INTRO`, `CALL_ME_REPLY_PROMPT`, `CALL_ME_ACK` | | Override phrases for the default language |
| `CALL_ME_SPEECH_TIMEOUT` | | Seconds of silence that end your turn when speaking (default 3) |
| `CALL_ME_BARGE_IN` | | `1` lets you interrupt Claude's line in live calls by talking, but noise can also cut it off (default off) |
| `CALL_ME_RETRIES` | | Extra attempts when you don't pick up (default 4) |
| `CALL_ME_RETRY_DELAY` | | Seconds between attempts (default 90) |
| `CALL_ME_DND_MINUTES` | | How long a rejected call holds further calls if you don't call back (default 120) |
| `CALL_ME_AMD` | | `0` turns off answering machine detection, which costs about $0.0075 per call. Rejections then can't be detected. When Claude waits for your reply, detection runs while the message plays, so it starts as soon as you pick up |
| `CALL_ME_STATE_DIR` | | Where saved messages are kept (default `~/.local/state/claude-call-me`) |
| `CALL_ME_LIVE` | | `0` = inbound calls hang up after you speak instead of staying open (default on) |
| `CALL_ME_LIVE_HOLD` | | Seconds you are kept on hold waiting for Claude's next line (default 120) |
| `CALL_ME_ANSWER` | | `0` = don't answer calls even when started with `claude-phone` (usually set per project with `call_me_settings`) |
| `CALL_ME_INBOUND` | | `1` = take over the number and answer calls (set by the `claude-phone` launcher) |
| `CALL_ME_PUBLIC_URL` | | Use your own public URL instead of cloudflared |
| `CALL_ME_PORT` | | Local webhook port (default: random) |

Settings are applied in this order, later ones winning: the machine config file, the project file written by `call_me_settings`, environment variables with the same names, and changes made with `scope: "session"`. `CALL_ME_CONFIG` points to a different config file.

## Development

```bash
npm test
claude --plugin-dir plugins/call-me   # try local changes without installing
```

## License

MIT, see [LICENSE](LICENSE).

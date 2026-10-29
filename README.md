# claude-call-me

A Claude Code plugin that lets Claude **phone you**. Claude speaks a message aloud using Twilio text-to-speech, then listens for your spoken or keypad reply and returns it to the session. Use it for "call me when the build finishes" or "call me if you're blocked."

It also works the other way: **you can call Claude.** Start a session with `claude-phone` (see [Calling Claude](#calling-claude-inbound)), dial your Twilio number, and say what you want. Your words arrive in that session and Claude starts working.

- No dependencies: one Node.js MCP server (Node ≥ 18).
- Your reply comes back through a webhook. A free Cloudflare quick tunnel exposes it, and no account is needed. If `cloudflared` isn't on your PATH, the plugin downloads it to `~/.cache/claude-call-me/` on the first call that waits for a reply.
- Webhook requests are checked against Twilio's `X-Twilio-Signature` and an unguessable per-call path.

## Install (once per machine; then available in every session)

```bash
claude plugin marketplace add git@github-qmw:qmw/claude-call-me.git
claude plugin install call-me@claude-call-me
```

Then, inside Claude Code:

```
/call-me:setup     # writes ~/.config/claude-call-me/config.env
/call-me:test      # places a test call
```

Or set up the config by hand: copy `plugins/call-me/config.example.env` to `~/.config/claude-call-me/config.env`, fill it in, and `chmod 600` it.

Update later with `claude plugin marketplace update claude-call-me`.

### Twilio prerequisites

1. Create a Twilio account and get a phone number with voice capability.
2. Copy the Account SID and Auth Token from the Twilio console.
3. On a trial account, verify your own number under *Verified Caller IDs*. Trial calls start with a short Twilio announcement.
4. Allow calls to your country under *Voice → Settings → Geo permissions*.

## Usage

Just ask: *"run the full test suite and call me with the result"* or *"if you need a decision, call me."*

The tool is `call_me(message, wait_for_reply=true, timeout_seconds=180, language)`. `language` is `en-US` or `pl-PL` and sets the voice, the fixed phrases and speech recognition for that one call. Leave it out to use `CALL_ME_LANGUAGE`. A session can tell Claude "call me in English" and it will pass `language: "en-US"`.

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
exec claude --dangerously-load-development-channels plugin:call-me@claude-call-me "$@"
```

Use it like `claude`, e.g. `claude-phone --resume <session-id>`. Channels can only be enabled when a session starts, so a session already running under plain `claude` must be restarted this way.

A `claude-phone` session:

1. Points your Twilio number's voice webhook at itself. The most recently started `claude-phone` session wins.
2. Answers calls **only from `CALL_ME_TO_NUMBER`**. Any other caller is rejected.
3. Greets you, transcribes what you say in `CALL_ME_LANGUAGE`, and pushes it into the session. Claude treats it as your request and calls you back with `call_me` when it's done or needs a decision.
4. On exit, points the number back to a short "Claude is offline" message, hosted on Twilio Twimlets. That message is also set as the fallback, so it plays even if a session crashes.

Requirements: a claude.ai login and an interactive session (not `-p`). Ordinary `claude` sessions never touch the number.

## Config

| Key | Required | Notes |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | ✓ | |
| `TWILIO_AUTH_TOKEN` | ✓ | |
| `TWILIO_FROM_NUMBER` | ✓ | Your Twilio number, E.164 format |
| `CALL_ME_TO_NUMBER` | ✓ | Your phone, E.164 format |
| `CALL_ME_LANGUAGE` | | Default language: `en-US` (default) or `pl-PL`. Sets the voice, phrases and speech recognition |
| `CALL_ME_VOICE` | | Voice for the default language. Built-in voices: `Polly.Joanna` (en-US), `Polly.Ewa` (pl-PL) |
| `CALL_ME_INTRO`, `CALL_ME_REPLY_PROMPT`, `CALL_ME_ACK` | | Override phrases for the default language |
| `CALL_ME_RETRIES` | | Extra attempts when you don't pick up (default 4) |
| `CALL_ME_RETRY_DELAY` | | Seconds between attempts (default 90) |
| `CALL_ME_DND_MINUTES` | | How long a rejected call holds further calls if you don't call back (default 120) |
| `CALL_ME_AMD` | | `0` turns off answering machine detection, which costs about $0.0075 per call. Rejections then can't be detected. |
| `CALL_ME_STATE_DIR` | | Where saved messages are kept (default `~/.local/state/claude-call-me`) |
| `CALL_ME_INBOUND` | | `1` = take over the number and answer calls (set by the `claude-phone` launcher) |
| `CALL_ME_PUBLIC_URL` | | Use your own public URL instead of cloudflared |
| `CALL_ME_PORT` | | Local webhook port (default: random) |

Environment variables with the same names override the file. `CALL_ME_CONFIG` points to a different config file.

## Development

```bash
npm test
claude --plugin-dir plugins/call-me   # try local changes without installing
```

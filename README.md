# claude-call-me

A Claude Code plugin that lets Claude **phone you**. Claude speaks a message aloud using Twilio text-to-speech, then listens for your spoken or keypad reply and returns it to the session. Use it for "call me when the build finishes" or "call me if you're blocked."

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

The tool is `call_me(message, wait_for_reply=true, timeout_seconds=180)`. It returns one of:

- your transcribed reply
- the keys you pressed
- a status: no answer, busy, or no reply

## Config

| Key | Required | Notes |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | ✓ | |
| `TWILIO_AUTH_TOKEN` | ✓ | |
| `TWILIO_FROM_NUMBER` | ✓ | Your Twilio number, E.164 format |
| `CALL_ME_TO_NUMBER` | ✓ | Your phone, E.164 format |
| `CALL_ME_LANGUAGE` | | e.g. `pl-PL`. Used for both TTS and speech recognition |
| `CALL_ME_VOICE` | | e.g. `Polly.Ewa`, `Polly.Joanna` |
| `CALL_ME_INTRO`, `CALL_ME_REPLY_PROMPT`, `CALL_ME_ACK` | | Override the spoken phrases |
| `CALL_ME_PUBLIC_URL` | | Use your own public URL instead of cloudflared |
| `CALL_ME_PORT` | | Local webhook port (default: random) |

Environment variables with the same names override the file. `CALL_ME_CONFIG` points to a different config file.

## Development

```bash
npm test
claude --plugin-dir plugins/call-me   # try local changes without installing
```

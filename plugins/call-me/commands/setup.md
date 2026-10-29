---
description: Configure call-me (Twilio credentials and your phone number)
---
Help the user configure the call-me plugin.

1. Read the config file at `${XDG_CONFIG_HOME:-~/.config}/claude-call-me/config.env` if it exists, and the template at `${CLAUDE_PLUGIN_ROOT}/config.example.env`.
2. Ask the user for any missing required values: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (their Twilio number), CALL_ME_TO_NUMBER (their own phone). All numbers in E.164 format (+countrycode...). Ask whether they want a non-English language/voice (e.g. CALL_ME_LANGUAGE=pl-PL, CALL_ME_VOICE=Polly.Ewa).
3. Write the file (create the directory if needed) and `chmod 600` it. Never echo the auth token back in full.
4. Remind the user that on a Twilio trial account the destination number must be verified in the Twilio console.
5. Offer to place a test call with the `call_me` tool.

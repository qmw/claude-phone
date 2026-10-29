---
description: Configure call-me (Twilio credentials and your phone number)
---
Help the user configure the call-me plugin.

1. Read the config file at `${XDG_CONFIG_HOME:-~/.config}/claude-call-me/config.env` if it exists, and the template at `${CLAUDE_PLUGIN_ROOT}/config.example.env`.
2. Ask the user for any missing required values: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (their Twilio number), CALL_ME_TO_NUMBER (their own phone). All numbers in E.164 format (+countrycode...). Ask which default language they want: en-US or pl-PL (CALL_ME_LANGUAGE). Individual calls can still override it. If they use several machines, remind them that each machine needs its own TWILIO_FROM_NUMBER, and offer to set CALL_ME_MACHINE (a short name for this machine) and CALL_ME_ALLOWED_CALLERS (other phones that may call in).
3. Write the file (create the directory if needed) and `chmod 600` it. Never echo the auth token back in full.
4. Remind the user that on a Twilio trial account the destination number must be verified in the Twilio console.
5. Offer to place a test call with the `call_me` tool.
6. Mention that they can also call Claude: see the "Calling Claude (inbound)" section of the plugin README (the `claude-phone` alias).

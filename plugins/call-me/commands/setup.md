---
description: Configure call-me (Twilio credentials and your phone number)
---
Help the user configure the call-me plugin.

1. Read the config file at `${XDG_CONFIG_HOME:-~/.config}/claude-call-me/config.env` if it exists, and the template at `${CLAUDE_PLUGIN_ROOT}/config.example.env`.
2. Ask the user for any missing required values: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (their Twilio number), CALL_ME_TO_NUMBER (their own phone). All numbers in E.164 format (+countrycode...). Ask which default language they want: en-US or pl-PL (CALL_ME_LANGUAGE). Individual calls can still override it. This writes the machine-wide defaults; each project can then pick its own numbers with /call-me:session. If they use several machines, remind them that each machine needs its own TWILIO_FROM_NUMBER, and offer to set CALL_ME_MACHINE (a short name for this machine) and CALL_ME_ALLOWED_CALLERS (other phones that may call in).
3. Write the file (create the directory if needed) and `chmod 600` it. Never echo the auth token back in full.
4. Remind the user to accept the *Predictive and Generative AI/ML Features Addendum* in the Twilio console (Voice → Settings → Privacy & Security): calls use ConversationRelay and fail without it. On a trial account the destination number must also be verified. For Polish, suggest CALL_ME_RELAY_TTS=Amazon and CALL_ME_RELAY_VOICE=Ola-Neural.
5. Offer to place a test call with the `call_me` tool.
6. Make sure the `claude-phone` launcher exists (see "Calling Claude" in the plugin README): conversations and incoming calls need the session to be started with it. Tell the user the restart command (`claude-phone --resume <session-id>`).

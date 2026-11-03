---
description: Show or change this session's phone numbers (its own Twilio number, who it calls, who may call it)
argument-hint: "[what to change, e.g. 'use +17255550123 and let +48600000001 call']"
---

Configure call-me for this session with the `call_me_settings` tool.

1. Call `call_me_settings` with `list_numbers: true` and show the user the current settings and the Twilio numbers on the account, including which ones other sessions already answer.
2. If the user said what to change ($ARGUMENTS), apply exactly that. Otherwise ask what they want:
   - `from_number`: this session's own Twilio number. Calls come from it, and the user dials it to reach this session. Pick a number no other session is answering.
   - `to_number`: the phone this session calls.
   - `allowed_callers`: other phones allowed to call this session (to_number always is).
   - `language`, `answer_calls`.
   Settings are saved for this project directory by default. Use `scope: "session"` only if the user wants a temporary change.
3. Show the result. If it says the session can't receive calls, tell the user to restart it with the `claude-phone` launcher (`claude-phone --resume <session-id>`).

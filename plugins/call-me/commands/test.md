---
description: Place a test call with call-me
---
Use the `call_me` tool to call the user with the message "This is a test call from Claude Code. Say something so I know you can hear me." Then hold the conversation: answer what they say with `phone_reply`, and end the call with `end_call: true` when they say goodbye. Report what happened. If the session wasn't started with `claude-phone`, the tool can only deliver the message: tell the user to restart with the launcher for a conversation.

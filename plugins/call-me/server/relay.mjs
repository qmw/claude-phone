// Calls through Twilio ConversationRelay: Twilio does the speech recognition (Deepgram) and the voice (ElevenLabs by
// default, or the configured one), with smart interruptions. Claude in the session is the brain: each finished
// sentence of the caller arrives as a channel event and phone_reply sends the answer, which Twilio speaks.
// While Claude works the caller hears a short filler ("Chwileczkę.") after 2.5 s, then "still on it" every 25 s.
import { xmlEscape } from "./lib.mjs";

/** TwiML that connects the call to our WebSocket through ConversationRelay. */
export function relayTwiml({ url, profile, greeting, cfg }) {
  const { language } = profile;
  const attrs = {
    url,
    language,
    welcomeGreeting: greeting,
    welcomeGreetingInterruptible: "speech",
    interruptible: "speech",
    // Tested 2026-11-12: "low" plus ignoreBackchannel let the caller say several things before the voice stopped.
    interruptSensitivity: cfg.CALL_ME_RELAY_INTERRUPT || "high",
    ignoreBackchannel: cfg.CALL_ME_RELAY_IGNORE_BACKCHANNEL === "1" ? "true" : "false",
    transcriptionProvider: "Deepgram",
    speechModel: "nova-3-general",
    hints: "Claude, AnyDesk, Twilio, GitHub, plugin",
  };
  if (profile.relayTts) attrs.ttsProvider = profile.relayTts;
  if (profile.relayVoice) attrs.voice = profile.relayVoice;
  const a = Object.entries(attrs)
    .map(([k, v]) => `${k}="${xmlEscape(v)}"`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay ${a}/></Connect></Response>`;
}

export class RelayCall {
  constructor({ cfg, profile, opening, notify, log, twilio, onEnd, inbound = null, quiet = false }) {
    Object.assign(this, { cfg, profile, language: profile.language, opening, notify, log, twilio, onEnd, inbound, quiet });
    this.callSid = null;
    this.ready = false;
    this.ended = null;
    this.transcript = [{ who: "voice", text: opening }];
    this.waiting = null; // { since, filled, stillAt } while the caller waits for Claude
  }

  attach(ws) {
    this.ws = ws;
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === "setup") {
        this.callSid = m.callSid;
        this.onCallSid?.(m.callSid);
        this.ready = true;
        this.readyAt = Date.now();
        this.log(`relay call ${m.callSid} connected`);
      } else if (m.type === "prompt" && m.last !== false && m.voicePrompt?.trim()) this.heard(m.voicePrompt.trim());
      else if (m.type === "interrupt") {
        const last = this.transcript.at(-1);
        if (last?.who === "voice") last.text = `${m.utteranceUntilInterrupt || ""}… (interrupted)`;
      } else if (m.type === "error") this.log(`relay error: ${m.description}`);
    });
    ws.on("close", () => this.end("the caller hung up"));
    this.timer = setInterval(() => this.tick(), 500);
  }

  heard(text) {
    this.transcript.push({ who: "caller", text });
    if (this.quiet) return; // one-way message: nobody is listening for an answer
    if (!this.waiting) this.waiting = { since: Date.now(), filled: false, stillAt: Date.now() + 25000 };
    const recent = this.transcript
      .slice(-8)
      .map((t) => `${t.who === "caller" ? "Caller" : "You"}: ${t.text}`)
      .join("\n");
    let content = `${text}\n\nRecent conversation on this realtime call:\n${recent}`;
    const saved = this.inbound?.saved || [];
    if (saved.length && !this.savedSent) {
      this.savedSent = true;
      content +=
        "\n\nSaved messages from earlier unanswered calls. The user has NOT heard them: do not read them out on the call " +
        "unless asked; list them on screen (project and gist) and pass them to the sessions working in those projects:\n" +
        saved.map((m) => `- [${m.project}, ${m.cwd}, ${m.at}] ${m.message}`).join("\n");
    }
    this.notify("notifications/claude/channel", {
      content,
      meta: {
        live: "true",
        realtime: "true",
        call_sid: this.callSid,
        language: this.language,
        ...(this.inbound
          ? { direction: "inbound", from: this.inbound.from, to: this.inbound.to, machine: this.inbound.machine, saved_messages: String(saved.length) }
          : {}),
      },
    });
  }

  /**
   * Keep the caller company while Claude works: the language's filler after 2.5 s (CALL_ME_RELAY_FILLER changes it,
   * "" turns it off), then "still on it" after 25 s and every 25 s after that.
   */
  tick() {
    const w = this.waiting;
    if (!w || this.ended) return;
    const now = Date.now();
    const filler = String(this.profile.filler || "").trim();
    if (!w.filled && filler && now - w.since > 2500) {
      w.filled = true;
      this.speak(filler, false);
    } else if (now > w.stillAt) {
      w.stillAt = now + 25000;
      this.speak(this.profile.stillWorking, false);
    }
  }

  speak(text, record = true) {
    this.ws.send({ type: "text", token: text, last: true, lang: this.language });
    if (record) this.transcript.push({ who: "voice", text });
  }

  /** Claude's line. Returns at once: the caller's next sentence comes as a new channel event. */
  say(message, { endCall = false, voice } = {}) {
    if (this.ended) return `The call has already ended (${this.ended}); nothing was said.`;
    this.waiting = null;
    if (voice) {
      // "Provider:VoiceId", e.g. "Google:pl-PL-Chirp3-HD-Charon", "Amazon:Ola-Neural", "ElevenLabs:<voice id>".
      const [ttsProvider, id] = String(voice).includes(":") ? String(voice).split(/:(.*)/s) : [null, String(voice)];
      this.ws.send({ type: "language", ttsLanguage: this.language, ...(ttsProvider ? { ttsProvider } : {}), voice: id });
    }
    this.speak(message);
    if (endCall) {
      // Let the line play out (about 14 characters a second), then end the session and the call.
      const ms = 1500 + (message.length / 14) * 1000;
      setTimeout(() => this.hangup(), ms);
      return "Sent; it is said, then the call hangs up.";
    }
    return 'Said. The caller\'s next sentence will arrive as a new channel event (realtime="true"). For longer work, send short progress updates with phone_reply.';
  }

  /** End the call. With the default reason the session gets no transcript (it ended the call itself). */
  async hangup(reason = "Claude ended the call") {
    if (this.ended) return;
    this.ws.send({ type: "end", handoffData: JSON.stringify({ reason: "claude-ended" }) });
    const sid = this.callSid;
    this.end(reason, { silent: true }); // before the socket closes, so it isn't reported as the caller hanging up
    if (sid) await this.twilio(this.cfg, "POST", `Calls/${sid}.json`, { Status: "completed" }).catch(() => {});
  }

  end(reason, { silent = false } = {}) {
    if (this.ended) return;
    this.ended = reason;
    clearInterval(this.timer);
    this.ws?.close();
    this.log(`relay call ${this.callSid} ended: ${reason}`);
    const transcript = this.transcript.map((t) => `${t.who === "caller" ? "Caller" : "You"}: ${t.text}`).join("\n");
    const unsent = !this.savedSent && this.inbound?.saved?.length ? this.inbound.saved : [];
    if (!silent && !this.quiet)
      this.notify("notifications/claude/channel", {
        content:
          `The realtime call has ended (${reason}). Transcript:\n${transcript}` +
          (unsent.length
            ? "\n\nSaved messages from earlier unanswered calls (not heard by the user; show them on screen and pass them on):\n" +
              unsent.map((m) => `- [${m.project}, ${m.cwd}, ${m.at}] ${m.message}`).join("\n")
            : ""),
        meta: { live: "false", realtime: "true", call_sid: this.callSid || "", language: this.language },
      });
    this.onEnd?.(this);
  }
}

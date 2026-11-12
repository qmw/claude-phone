// Realtime calls through Twilio ConversationRelay (experimental): Twilio does the speech recognition (Deepgram) and
// the voice (ElevenLabs by default, natural Polish), with smart interruptions. Claude in the session is the brain:
// each finished sentence of the caller arrives as a channel event and phone_reply sends the answer, which Twilio
// speaks. While Claude works, the caller hears a short filler at once and "still on it" now and then.
import { xmlEscape } from "./lib.mjs";

const FILLERS = {
  "pl-PL": { first: ["Jasne, chwileczkę.", "Już sprawdzam.", "Moment, sprawdzam."], still: "Nadal nad tym pracuję." },
  "en-US": { first: ["Sure, one moment.", "Checking now.", "Give me a second."], still: "Still working on it." },
};

/** TwiML that connects the call to our WebSocket through ConversationRelay. */
export function relayTwiml({ url, language, greeting, cfg }) {
  const attrs = {
    url,
    language,
    welcomeGreeting: greeting,
    welcomeGreetingInterruptible: "speech",
    interruptible: "speech",
    interruptSensitivity: cfg.CALL_ME_RELAY_INTERRUPT || "low",
    ignoreBackchannel: "true",
    transcriptionProvider: "Deepgram",
    speechModel: "nova-3-general",
    hints: "Claude, AnyDesk, Twilio, GitHub, plugin",
  };
  if (cfg.CALL_ME_RELAY_TTS) attrs.ttsProvider = cfg.CALL_ME_RELAY_TTS;
  if (cfg.CALL_ME_RELAY_VOICE) attrs.voice = cfg.CALL_ME_RELAY_VOICE;
  const a = Object.entries(attrs)
    .map(([k, v]) => `${k}="${xmlEscape(v)}"`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay ${a}/></Connect></Response>`;
}

export class RelayCall {
  constructor({ cfg, language, opening, notify, log, twilio, onEnd }) {
    Object.assign(this, { cfg, language, opening, notify, log, twilio, onEnd });
    this.fillers = FILLERS[language] || FILLERS["en-US"];
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
        this.ready = true;
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
    if (!this.waiting) this.waiting = { since: Date.now(), filled: false, stillAt: Date.now() + 25000 };
    const recent = this.transcript
      .slice(-8)
      .map((t) => `${t.who === "caller" ? "Caller" : "You"}: ${t.text}`)
      .join("\n");
    this.notify("notifications/claude/channel", {
      content: `${text}\n\nRecent conversation on this realtime call:\n${recent}`,
      meta: { live: "true", realtime: "true", call_sid: this.callSid, language: this.language },
    });
  }

  /** Keep the caller company while Claude works: a filler after 1.5 s, then "still on it" every 25 s. */
  tick() {
    const w = this.waiting;
    if (!w || this.ended) return;
    const now = Date.now();
    if (!w.filled && now - w.since > 1500) {
      w.filled = true;
      this.speak(this.fillers.first[Math.floor(Math.random() * this.fillers.first.length)], false);
    } else if (now > w.stillAt) {
      w.stillAt = now + 25000;
      this.speak(this.fillers.still, false);
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

  async hangup() {
    if (this.ended) return;
    this.ws.send({ type: "end", handoffData: JSON.stringify({ reason: "claude-ended" }) });
    const sid = this.callSid;
    this.end("Claude ended the call"); // before the socket closes, so it isn't reported as the caller hanging up
    if (sid) await this.twilio(this.cfg, "POST", `Calls/${sid}.json`, { Status: "completed" }).catch(() => {});
  }

  end(reason) {
    if (this.ended) return;
    this.ended = reason;
    clearInterval(this.timer);
    this.ws?.close();
    this.log(`relay call ${this.callSid} ended: ${reason}`);
    const transcript = this.transcript.map((t) => `${t.who === "caller" ? "Caller" : "You"}: ${t.text}`).join("\n");
    if (reason !== "Claude ended the call")
      this.notify("notifications/claude/channel", {
        content: `The realtime call has ended (${reason}). Transcript:\n${transcript}`,
        meta: { live: "false", realtime: "true", call_sid: this.callSid || "", language: this.language },
      });
    this.onEnd?.(this);
  }
}

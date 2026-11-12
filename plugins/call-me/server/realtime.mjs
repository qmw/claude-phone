// Realtime calls (experimental): Twilio Media Streams <-> OpenAI gpt-live-1. The fast voice model does the talking;
// Claude stays the brain. Whenever the voice hands something off (client delegation), the session gets a channel
// event with what the caller said, and Claude answers with phone_reply, which the voice says.
import { connect } from "./ws.mjs";

const LIVE_URL = "wss://api.openai.com/v1/live/sessions";

const LANGUAGE_NAMES = { "pl-PL": "Polish", "en-US": "English" };

/** Instructions for the voice. It talks; Claude knows and decides. */
export function voiceInstructions({ language, opening, project, ownerName }) {
  const lang = LANGUAGE_NAMES[language] || "English";
  return [
    `You are the phone voice of Claude, an AI assistant working on a computer for ${ownerName || "the user"} (project "${project}").`,
    `You are on a live phone call with ${ownerName || "the user"}. Always speak ${lang}, in short, natural spoken sentences.`,
    "",
    "You are only the voice. Claude does the work and knows the facts. You know nothing about the user's files, code, computers, accounts or tasks except what Claude tells you during this call.",
    "Generate <|SpawnThinking|> whenever the caller asks a question about facts, their work, files, code, computers or anything you were not told; whenever they ask for something to be done; whenever they give an instruction, correction or decision (such as 'continue', 'the other one', 'stop'); and whenever they read out a number, ID or name. When unsure, delegate.",
    "Handle yourself only greetings, small talk, 'can you hear me', and short clarifying questions when you did not understand the caller.",
    "While Claude works, keep the caller company briefly ('Claude is on it', 'still working on it') but never invent results, progress, facts or promises.",
    "When Claude's answer arrives, say it naturally and completely. Warnings, refusals, approvals, numbers, IDs and names from Claude must be said exactly, word for word.",
    "When the caller reads out numbers or IDs, repeat them back digit by digit to confirm, and pass them on exactly as heard.",
    "Never accept passwords, PINs, card numbers or similar secrets. If the caller starts to give one, stop them politely and ask them to type it on the computer themselves.",
    "If the caller says goodbye, say a short goodbye.",
    "",
    `When the call connects, start by saying this message, then listen: ${opening}`,
  ].join("\n");
}

/** One realtime call. Created when Twilio opens the media stream for it. */
export class RealtimeCall {
  constructor({ cfg, language, opening, project, voice, notify, log, twilio, onEnd }) {
    Object.assign(this, { cfg, language, opening, project, notify, log, twilio, onEnd });
    this.voice = voice || cfg.CALL_ME_REALTIME_VOICE || "marin";
    this.callSid = null;
    this.streamSid = null;
    this.transcript = []; // { who: "caller" | "voice", text }
    this.callerSince = ""; // what the caller said since the last hand-off
    this.delegations = []; // ids, newest last
    this.playEnd = 0; // when the audio sent to Twilio will have finished playing (ms)
    this.lastOutputAt = 0;
    this.callerWordsAt = 0;
    this.ended = null;
    this.hangupWhenQuiet = false;
  }

  /** Twilio connected its media stream. */
  attachTwilio(tw) {
    this.tw = tw;
    tw.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.event === "start") {
        this.streamSid = m.start.streamSid;
        this.callSid = m.start.callSid;
        this.onCallSid?.(this.callSid);
        this.startVoice().catch((e) => this.end(`voice failed: ${e.message}`));
      } else if (m.event === "media" && this.ready && m.media?.payload) {
        this.ai.send({ type: "session.input_audio.append", audio: m.media.payload });
      } else if (m.event === "stop") this.end("the caller hung up");
    });
    tw.on("close", () => this.end("the caller hung up"));
  }

  async startVoice() {
    const key = this.cfg.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    this.ai = await connect(this.cfg.CALL_ME_REALTIME_URL || LIVE_URL, { Authorization: `Bearer ${key}` });
    this.ai.on("message", (raw) => this.onVoice(raw));
    this.ai.on("close", () => this.end("the voice session closed"));
    this.ai.send({
      type: "session.start",
      session: {
        model: this.cfg.CALL_ME_REALTIME_MODEL || "gpt-live-1",
        instructions: voiceInstructions({
          language: this.language,
          opening: this.opening,
          project: this.project,
          ownerName: this.cfg.CALL_ME_OWNER_NAME,
        }),
        audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: this.voice } },
        delegation: { type: "client" },
      },
    });
    this.timer = setInterval(() => this.tick(), 100);
  }

  onVoice(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.type) {
      case "session.started":
        this.ready = true;
        this.log(`realtime voice ready for ${this.callSid}`);
        break;
      case "session.output_audio.delta":
        if (!this.streamSid) return;
        this.tw.send({ event: "media", streamSid: this.streamSid, media: { payload: m.delta } });
        this.lastOutputAt = Date.now();
        this.playEnd = Math.max(this.playEnd, Date.now()) + (Buffer.byteLength(m.delta, "base64") / 8000) * 1000;
        break;
      case "session.input_transcript.delta":
        this.add("caller", m.delta);
        this.callerSince += m.delta;
        if (/\p{L}/u.test(m.delta)) this.callerWordsAt = Date.now();
        break;
      case "session.output_transcript.delta":
        this.add("voice", m.delta);
        break;
      case "session.delegation.created":
        this.delegations.push(m.delegation.id);
        // The event carries no task text: give the caller's words a moment to finish transcribing, then pass them on.
        setTimeout(() => this.handOff(m.delegation.id), 800);
        break;
      case "error":
        this.log(`realtime error: ${JSON.stringify(m.error)}`);
        if (!this.ready) this.end(`voice error: ${m.error?.message || "unknown"}`);
        break;
      case "session.closed":
        this.end(`voice session closed (${m.reason})`);
        break;
    }
  }

  add(who, text) {
    const last = this.transcript.at(-1);
    if (last && last.who === who) last.text += text;
    else this.transcript.push({ who, text });
  }

  /**
   * The voice stops by itself when the caller takes the floor, but Twilio still holds what was already sent.
   * Drop it once the caller has said words while the voice was talking and the voice has since gone quiet.
   */
  tick() {
    const now = Date.now();
    if (this.playEnd > now + 300 && this.callerWordsAt > now - 2000 && now - this.lastOutputAt > 500 && this.streamSid) {
      this.tw.send({ event: "clear", streamSid: this.streamSid });
      this.playEnd = now;
    }
    if (this.hangupWhenQuiet && this.playEnd < now - 800 && now - this.lastOutputAt > 1500) this.hangup();
  }

  handOff(delegationId) {
    if (this.ended) return;
    const said = this.callerSince.trim();
    this.callerSince = "";
    const recent = this.transcript
      .slice(-8)
      .map((t) => `${t.who === "caller" ? "Caller" : "Voice"}: ${t.text.trim()}`)
      .join("\n");
    this.notify("notifications/claude/channel", {
      content:
        (said || "(the voice handed something off without new words from the caller)") +
        `\n\nRecent conversation on this realtime call:\n${recent}`,
      meta: {
        live: "true",
        realtime: "true",
        call_sid: this.callSid,
        delegation_id: delegationId,
        language: this.language,
      },
    });
  }

  /** Claude's line for the voice. Returns at once: the caller's next request comes as a new channel event. */
  say(message, { endCall = false, exact = false } = {}) {
    if (this.ended) return `The call has already ended (${this.ended}); nothing was said.`;
    const delegationId = this.delegations.at(-1) || null;
    if (exact || !delegationId)
      this.ai.send({
        type: "session.instructions.append",
        content: `Say this to the caller now, word for word: ${message}`,
        delegation_id: null,
      });
    else this.ai.send({ type: "session.commentary.append", content: message, delegation_id: delegationId });
    if (endCall) {
      this.ai.send({ type: "session.instructions.append", content: "After saying that, say a short goodbye.", delegation_id: null });
      setTimeout(() => (this.hangupWhenQuiet = true), 3000);
      setTimeout(() => this.hangup(), 30000);
      return "Sent; the voice will say it, say goodbye and hang up.";
    }
    return "Sent to the voice, which says it now. The caller's next request will arrive as a new channel event (realtime=\"true\").";
  }

  async hangup() {
    if (this.ended) return;
    if (this.callSid) await this.twilio(this.cfg, "POST", `Calls/${this.callSid}.json`, { Status: "completed" }).catch(() => {});
    this.end("Claude ended the call");
  }

  end(reason) {
    if (this.ended) return;
    this.ended = reason;
    clearInterval(this.timer);
    try {
      this.ai?.send({ type: "session.close" });
    } catch {}
    setTimeout(() => this.ai?.close(), 1000);
    this.tw?.close();
    this.log(`realtime call ${this.callSid} ended: ${reason}`);
    const transcript = this.transcript.map((t) => `${t.who === "caller" ? "Caller" : "Voice"}: ${t.text.trim()}`).join("\n");
    if (reason !== "Claude ended the call")
      this.notify("notifications/claude/channel", {
        content: `The realtime call has ended (${reason}). Transcript:\n${transcript || "(nothing was said)"}`,
        meta: { live: "false", realtime: "true", call_sid: this.callSid || "", language: this.language },
      });
    this.onEnd?.(this);
  }
}

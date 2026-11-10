// Pure helpers (no I/O side effects) — kept separate so they can be unit-tested.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_PATH =
  process.env.CALL_ME_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "claude-call-me", "config.env");

export const STATE_DIR =
  process.env.CALL_ME_STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "claude-call-me");

export const REQUIRED_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "CALL_ME_TO_NUMBER"];

/** Parse KEY=VALUE lines (with optional quotes and # comments). */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Per-project settings (numbers, language) live next to the main config, one file per project directory. */
export function projectConfigPath(cwd = process.cwd(), configPath = CONFIG_PATH) {
  return path.join(path.dirname(configPath), "projects", cwd.replace(/[^A-Za-z0-9._]+/g, "-").replace(/^-+/, "") + ".env");
}

const readEnvFile = (file) => {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

/** Config = config file < project file < process env < this session's overrides. */
const PHRASE_KEYS = ["CALL_ME_VOICE", "CALL_ME_INTRO", "CALL_ME_REPLY_PROMPT", "CALL_ME_ACK"];

export function loadConfig(env = process.env, file = CONFIG_PATH, projectFile = null, overrides = {}) {
  const fromEnv = Object.fromEntries(
    Object.entries(env).filter(([k, v]) => (k.startsWith("TWILIO_") || k.startsWith("CALL_ME_")) && v),
  );
  const cfg = {};
  // A voice or phrase belongs to the language that was in effect where it was set: a Polish voice in the
  // machine config must not be used when a project switches to English.
  const phraseLanguage = {};
  for (const layer of [readEnvFile(file), projectFile ? readEnvFile(projectFile) : {}, fromEnv, overrides]) {
    Object.assign(cfg, layer);
    const lang = normalizeLanguage(cfg.CALL_ME_LANGUAGE) || "en-US";
    for (const k of PHRASE_KEYS) if (k in layer) phraseLanguage[k] = lang;
  }
  Object.defineProperty(cfg, "phraseLanguage", { value: phraseLanguage, enumerable: false });
  const missing = REQUIRED_KEYS.filter((k) => !cfg[k]);
  return { cfg, missing };
}

/** Merge `values` into a KEY=VALUE file (empty string removes a key); written with mode 600. */
export function updateEnvFile(file, values) {
  const cur = readEnvFile(file);
  for (const [k, v] of Object.entries(values)) v === "" ? delete cur[k] : (cur[k] = v);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = Object.entries(cur).map(([k, v]) => `${k}="${String(v).replace(/"/g, "")}"`).join("\n") + "\n";
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** "+48 600-000-001" -> "+48600000001"; throws unless it looks like E.164. */
export function e164(n) {
  const s = String(n).replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(s)) throw new Error(`"${n}" is not a phone number in E.164 format (+countrycode…)`);
  return s;
}

export function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}

// Spoken phrases per supported language. Claude speaks of itself in the masculine in Polish.
export const LANGUAGES = {
  "en-US": {
    voice: "Polly.Joanna",
    intro: "Hi, this is Claude.",
    prompt: "", // no "say your reply now": the message ends with a question, and people just answer
    retry: "I didn't catch that.",
    noReply: "No reply received. Goodbye.",
    ack: "Got it, thanks. Goodbye.",
    inboundGreeting: "Hi, this is Claude. I'm listening.",
    inboundAck: "Got it, passing it on. Goodbye.",
    inboundEmpty: "I didn't hear anything. Goodbye.",
    offline: "Claude is offline right now. Goodbye.",
    hold: "One moment.",
    stillWorking: "Still working on it.",
    holdTimeout: "This will take longer. I'll call you back when I'm done. Goodbye.",
    bye: "Goodbye.",
    savedIntro: (n) => (n === 1 ? "You have one saved message." : `You have ${n} saved messages.`),
    savedFrom: (project) => `From ${project}:`,
  },
  "pl-PL": {
    voice: "Polly.Ewa",
    intro: "Cześć, tu Claude.",
    prompt: "",
    retry: "Nie dosłyszałem.",
    noReply: "Nie otrzymałem odpowiedzi. Do usłyszenia.",
    ack: "Dzięki, przyjąłem. Do usłyszenia.",
    inboundGreeting: "Cześć, tu Claude. Słucham.",
    inboundAck: "Przyjąłem, przekazuję. Do usłyszenia.",
    inboundEmpty: "Nic nie usłyszałem. Do usłyszenia.",
    offline: "Claude jest teraz offline. Do usłyszenia.",
    hold: "Chwileczkę.",
    stillWorking: "Jeszcze chwila.",
    holdTimeout: "To potrwa dłużej. Zadzwonię, jak skończę. Do usłyszenia.",
    bye: "Do usłyszenia.",
    savedIntro: (n) => (n === 1 ? "Masz jedną zapisaną wiadomość." : `Zapisane wiadomości: ${n}.`),
    savedFrom: (project) => `Z projektu ${project}:`,
  },
};

const ALIASES = { en: "en-US", english: "en-US", pl: "pl-PL", polish: "pl-PL", polski: "pl-PL" };

/** "pl", "PL-pl", "polish" -> "pl-PL"; null for empty; throws for unsupported. */
export function normalizeLanguage(x) {
  if (!x) return null;
  const k = String(x).trim().toLowerCase();
  const lang = ALIASES[k] || Object.keys(LANGUAGES).find((l) => l.toLowerCase() === k);
  if (!lang) throw new Error(`Unsupported language "${x}". Supported: ${Object.keys(LANGUAGES).join(", ")}`);
  return lang;
}

/**
 * Voice + phrases for a call. `requested` (per-call) wins over CALL_ME_LANGUAGE (default, en-US if unset).
 * CALL_ME_VOICE and the CALL_ME_INTRO/REPLY_PROMPT/ACK overrides apply only to the default language.
 */
export function speechProfile(cfg, requested) {
  const def = normalizeLanguage(cfg.CALL_ME_LANGUAGE) || "en-US";
  const language = normalizeLanguage(requested) || def;
  // Seconds of silence that end the user's turn. Twilio's "auto" cut people off at their first pause.
  const p = { ...LANGUAGES[language], language, speechTimeout: xmlEscape(cfg.CALL_ME_SPEECH_TIMEOUT || "3"), bargeIn: cfg.CALL_ME_BARGE_IN === "1" };
  // Overrides apply only to calls in the language they were set for (see loadConfig).
  const mine = (k) => cfg[k] !== undefined && (cfg.phraseLanguage?.[k] ?? def) === language;
  if (mine("CALL_ME_VOICE") && cfg.CALL_ME_VOICE) p.voice = cfg.CALL_ME_VOICE;
  if (mine("CALL_ME_INTRO")) p.intro = cfg.CALL_ME_INTRO;
  if (mine("CALL_ME_REPLY_PROMPT")) p.prompt = cfg.CALL_ME_REPLY_PROMPT;
  if (mine("CALL_ME_ACK")) p.ack = cfg.CALL_ME_ACK;
  return p;
}

const XML = `<?xml version="1.0" encoding="UTF-8"?>`;
const say = (p, text) =>
  !String(text ?? "").trim()
    ? ""
    : `<Say voice="${xmlEscape(p.voice)}" language="${p.language}">${xmlEscape(text)}</Say>`;
const gather = (p, url, inner, input = "speech dtmf", onEmpty = false) =>
  `<Gather input="${input}" action="${xmlEscape(url)}" method="POST" timeout="10" speechTimeout="${p.speechTimeout}" ` +
  `actionOnEmptyResult="${onEmpty}" language="${p.language}">${inner}</Gather>`;

/** TwiML for the outbound call. If gatherUrl is set, listen for a spoken / keypad reply. */
export function buildCallTwiml(message, p, gatherUrl) {
  let x = `${XML}<Response><Pause length="1"/>`;
  if (p.intro) x += say(p, p.intro);
  x += say(p, message);
  if (gatherUrl) {
    x += gather(p, gatherUrl, say(p, p.prompt));
    x += gather(p, gatherUrl, say(p, `${p.retry} ${message} ${p.prompt}`.trim()));
    x += say(p, p.noReply);
  }
  return x + `</Response>`;
}

/** Say something and hang up. */
export function buildSayHangupTwiml(p, text) {
  return `${XML}<Response>${say(p, text)}<Hangup/></Response>`;
}

/**
 * Answer an inbound call from the user: first read any saved messages (each in its own language),
 * then record what they say. With saved messages, an empty reply is still posted so the session learns
 * they were heard.
 */
export function buildInboundTwiml(p, gatherUrl, saved = [], postEmpty = saved.length > 0) {
  let x = `${XML}<Response>`;
  if (saved.length) {
    x += say(p, p.savedIntro(saved.length));
    for (const m of saved) {
      const mp = { ...LANGUAGES[m.language], language: m.language, voice: m.language === p.language ? p.voice : LANGUAGES[m.language].voice };
      x += say(mp, `${mp.savedFrom(m.project)} ${m.message}`) + `<Pause length="1"/>`;
    }
  }
  x += gather(p, gatherUrl, say(p, p.inboundGreeting), "speech", postEmpty);
  return x + say(p, p.inboundEmpty) + `</Response>`;
}

/** Live call: keep the user on hold (optionally saying something) and poll waitUrl for Claude's next line. */
export function buildHoldTwiml(p, waitUrl, text) {
  return `${XML}<Response>${text ? say(p, text) : ""}<Pause length="2"/><Redirect method="POST">${xmlEscape(waitUrl)}</Redirect></Response>`;
}

/**
 * Live call: say Claude's line and listen; silence twice posts an empty result.
 * Twilio stops a <Say> inside <Gather> at any sound, including noise, so the line stays outside it
 * and always plays in full unless CALL_ME_BARGE_IN=1.
 */
export function buildLiveTurnTwiml(p, message, gatherUrl) {
  const line = p.bargeIn ? gather(p, gatherUrl, say(p, message)) : say(p, message) + gather(p, gatherUrl, "");
  return `${XML}<Response>${line}${gather(p, gatherUrl, say(p, p.retry), "speech dtmf", true)}</Response>`;
}

export const REJECT_TWIML = `${XML}<Response><Reject/></Response>`;

/** Hosted (Twilio Twimlets) URL that speaks the offline message — used when no session owns the number. */
export function offlineUrl(p) {
  return "https://twimlets.com/echo?Twiml=" + encodeURIComponent(buildSayHangupTwiml(p, p.offline));
}

/** E.164 comparison tolerant of spaces/dashes. */
export const samePhone = (a, b) => !!a && !!b && a.replace(/[^\d+]/g, "") === b.replace(/[^\d+]/g, "");

const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

/** The phones Claude calls, in order: CALL_ME_TO_NUMBER, then CALL_ME_BACKUP_NUMBERS when it isn't answered. */
export const callTargets = (cfg) => [...new Set([cfg.CALL_ME_TO_NUMBER, ...list(cfg.CALL_ME_BACKUP_NUMBERS)].filter(Boolean))];

/** Inbound callers allowed to talk to the session: the phones it calls plus CALL_ME_ALLOWED_CALLERS (comma-separated). */
export function allowedCaller(cfg, from) {
  return [...callTargets(cfg), ...list(cfg.CALL_ME_ALLOWED_CALLERS)].some((n) => samePhone(from, n));
}

/** Name of this machine, reported with inbound calls so the session knows which number was dialled. */
export const machineName = (cfg) => cfg.CALL_ME_MACHINE || os.hostname();

/** https://www.twilio.com/docs/usage/webhooks/webhooks-security */
export function twilioSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validSignature(authToken, url, params, header) {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(header);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

export const TERMINAL_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/**
 * What happened on an outbound call, from Twilio's final status + answering-machine detection.
 * On the user's carrier a rejected call goes straight to voicemail, which Twilio sees as answered by a machine;
 * a call that just rings out ends as "no-answer" (our 30 s ring timeout is shorter than the voicemail delay).
 * Returns: answered | short | rejected | no-answer | busy | failed | canceled
 */
export function classifyOutcome({ status, answeredBy, duration }) {
  if (status !== "completed") return status;
  if (answeredBy && /^(machine|fax)/.test(answeredBy)) return "rejected";
  // Without AMD a sub-3-second call means they picked up and hung up before hearing anything.
  if (!answeredBy && Number(duration) < 3) return "short";
  return "answered";
}

export const RETRYABLE = new Set(["no-answer", "busy"]);

// ---- shared state across sessions: saved messages + do-not-disturb after a rejected call

const stateFile = (dir) => path.join(dir, "state.json");

export function readState(dir = STATE_DIR) {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(dir), "utf8"));
    return { saved: st.saved || [], dndUntil: st.dndUntil || 0 };
  } catch {
    return { saved: [], dndUntil: 0 };
  }
}

export function writeState(st, dir = STATE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = stateFile(dir) + "." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile(dir));
}

/** Save a message to be read when the user calls back; optionally start do-not-disturb. */
export function saveForCallback(entry, { dndMinutes = 0, now = Date.now(), dir = STATE_DIR } = {}) {
  const st = readState(dir);
  st.saved.push({ ...entry, at: new Date(now).toISOString() });
  if (dndMinutes > 0) st.dndUntil = Math.max(st.dndUntil, now + dndMinutes * 60000);
  writeState(st, dir);
  return st;
}

/** The user called in: hand over saved messages and end do-not-disturb. */
export function takeSaved(dir = STATE_DIR) {
  const { saved } = readState(dir);
  writeState({ saved: [], dndUntil: 0 }, dir);
  return saved;
}

export const dndActive = (now = Date.now(), dir = STATE_DIR) => readState(dir).dndUntil > now;

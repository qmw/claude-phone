// Pure helpers (no I/O side effects) — kept separate so they can be unit-tested.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_PATH =
  process.env.CALL_ME_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "claude-call-me", "config.env");

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

/** Config = config file, overridden by process env. */
export function loadConfig(env = process.env, file = CONFIG_PATH) {
  let fromFile = {};
  try {
    fromFile = parseEnv(fs.readFileSync(file, "utf8"));
  } catch {}
  const cfg = { ...fromFile };
  for (const [k, v] of Object.entries(env)) if ((k.startsWith("TWILIO_") || k.startsWith("CALL_ME_")) && v) cfg[k] = v;
  const missing = REQUIRED_KEYS.filter((k) => !cfg[k]);
  return { cfg, missing };
}

export function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}

// Spoken phrases per supported language. Claude speaks of itself in the masculine in Polish.
export const LANGUAGES = {
  "en-US": {
    voice: "Polly.Joanna",
    intro: "Hi, this is Claude.",
    prompt: "Please say your reply now, or press a key.",
    retry: "I didn't catch that.",
    noReply: "No reply received. Goodbye.",
    ack: "Got it, thanks. Goodbye.",
    inboundGreeting: "Hi, this is Claude. I'm listening.",
    inboundAck: "Got it, passing it on. Goodbye.",
    inboundEmpty: "I didn't hear anything. Goodbye.",
    offline: "Claude is offline right now. Goodbye.",
  },
  "pl-PL": {
    voice: "Polly.Ewa",
    intro: "Cześć, tu Claude.",
    prompt: "Powiedz swoją odpowiedź teraz albo naciśnij klawisz.",
    retry: "Nie dosłyszałem.",
    noReply: "Nie otrzymałem odpowiedzi. Do usłyszenia.",
    ack: "Dzięki, przyjąłem. Do usłyszenia.",
    inboundGreeting: "Cześć, tu Claude. Słucham.",
    inboundAck: "Przyjąłem, przekazuję. Do usłyszenia.",
    inboundEmpty: "Nic nie usłyszałem. Do usłyszenia.",
    offline: "Claude jest teraz offline. Do usłyszenia.",
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
  const p = { ...LANGUAGES[language], language };
  if (language === def) {
    if (cfg.CALL_ME_VOICE) p.voice = cfg.CALL_ME_VOICE;
    if (cfg.CALL_ME_INTRO !== undefined) p.intro = cfg.CALL_ME_INTRO;
    if (cfg.CALL_ME_REPLY_PROMPT !== undefined) p.prompt = cfg.CALL_ME_REPLY_PROMPT;
    if (cfg.CALL_ME_ACK !== undefined) p.ack = cfg.CALL_ME_ACK;
  }
  return p;
}

const XML = `<?xml version="1.0" encoding="UTF-8"?>`;
const say = (p, text) => `<Say voice="${xmlEscape(p.voice)}" language="${p.language}">${xmlEscape(text)}</Say>`;
const gather = (p, url, inner, input = "speech dtmf") =>
  `<Gather input="${input}" action="${xmlEscape(url)}" method="POST" timeout="10" speechTimeout="auto" ` +
  `actionOnEmptyResult="false" language="${p.language}">${inner}</Gather>`;

/** TwiML for the outbound call. If gatherUrl is set, listen for a spoken / keypad reply. */
export function buildCallTwiml(message, p, gatherUrl) {
  let x = `${XML}<Response><Pause length="1"/>`;
  if (p.intro) x += say(p, p.intro);
  x += say(p, message);
  if (gatherUrl) {
    x += gather(p, gatherUrl, say(p, p.prompt));
    x += gather(p, gatherUrl, say(p, `${p.retry} ${message} ${p.prompt}`));
    x += say(p, p.noReply);
  }
  return x + `</Response>`;
}

/** Say something and hang up. */
export function buildSayHangupTwiml(p, text) {
  return `${XML}<Response>${say(p, text)}<Hangup/></Response>`;
}

/** Answer an inbound call from the user and record what they say. */
export function buildInboundTwiml(p, gatherUrl) {
  return `${XML}<Response>${gather(p, gatherUrl, say(p, p.inboundGreeting), "speech")}${say(p, p.inboundEmpty)}</Response>`;
}

export const REJECT_TWIML = `${XML}<Response><Reject/></Response>`;

/** Hosted (Twilio Twimlets) URL that speaks the offline message — used when no session owns the number. */
export function offlineUrl(p) {
  return "https://twimlets.com/echo?Twiml=" + encodeURIComponent(buildSayHangupTwiml(p, p.offline));
}

/** E.164 comparison tolerant of spaces/dashes. */
export const samePhone = (a, b) => !!a && !!b && a.replace(/[^\d+]/g, "") === b.replace(/[^\d+]/g, "");

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

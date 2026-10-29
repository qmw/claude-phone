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

function sayAttrs(cfg) {
  let a = "";
  if (cfg.CALL_ME_VOICE) a += ` voice="${xmlEscape(cfg.CALL_ME_VOICE)}"`;
  if (cfg.CALL_ME_LANGUAGE) a += ` language="${xmlEscape(cfg.CALL_ME_LANGUAGE)}"`;
  return a;
}

/** TwiML for the outbound call. If gatherUrl is set, listen for a spoken / keypad reply. */
export function buildCallTwiml(message, cfg, gatherUrl) {
  const say = sayAttrs(cfg);
  const intro = cfg.CALL_ME_INTRO ?? "Hi, this is Claude.";
  let x = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/>`;
  if (intro) x += `<Say${say}>${xmlEscape(intro)}</Say>`;
  x += `<Say${say}>${xmlEscape(message)}</Say>`;
  if (gatherUrl) {
    const lang = cfg.CALL_ME_LANGUAGE ? ` language="${xmlEscape(cfg.CALL_ME_LANGUAGE)}"` : "";
    const prompt = cfg.CALL_ME_REPLY_PROMPT ?? "Please say your reply now, or press a key.";
    for (let i = 0; i < 2; i++) {
      x +=
        `<Gather input="speech dtmf" action="${xmlEscape(gatherUrl)}" method="POST" timeout="10" ` +
        `speechTimeout="auto" actionOnEmptyResult="false"${lang}>` +
        `<Say${say}>${xmlEscape(i === 0 ? prompt : "I didn't catch that. " + message + " " + prompt)}</Say>` +
        `</Gather>`;
    }
    x += `<Say${say}>No reply received. Goodbye.</Say>`;
  }
  x += `</Response>`;
  return x;
}

export function buildAckTwiml(cfg) {
  const ack = cfg.CALL_ME_ACK ?? "Got it, thanks. Goodbye.";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say${sayAttrs(cfg)}>${xmlEscape(ack)}</Say><Hangup/></Response>`;
}

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

#!/usr/bin/env node
// call-me MCP server: lets Claude phone you via Twilio and talk with you in real time (Twilio ConversationRelay:
// Deepgram hears you, a natural voice speaks Claude's lines). With CALL_ME_INBOUND=1 (the claude-phone launcher)
// it also takes over the Twilio number so you can call Claude; everything you say on a call is pushed into the
// session as a channel event (Claude Code "channels") and Claude answers with phone_reply.
// Zero dependencies — speaks MCP (JSON-RPC over stdio) directly.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import readline from "node:readline";
import {
  CONFIG_PATH,
  loadConfig,
  projectConfigPath,
  updateEnvFile,
  e164,
  normalizeLanguage,
  speechProfile,
  offlineUrl,
  allowedCaller,
  callTargets,
  machineName,
  REJECT_TWIML,
  validSignature,
  TERMINAL_STATUSES,
  classifyOutcome,
  RETRYABLE,
  saveForCallback,
  takeSaved,
  dndActive,
  XML,
} from "./lib.mjs";
import { acceptUpgrade } from "./ws.mjs";
import { RealtimeCall } from "./realtime.mjs";
import { RelayCall, relayTwiml } from "./relay.mjs";

const VERSION = "0.11.0";
const INBOUND = /^(1|true|yes)$/i.test(process.env.CALL_ME_INBOUND || "");
const NO = /^(0|false|no)$/i;
const log = (...a) => process.stderr.write(`[call-me] ${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Settings: machine config file < this project's file < env < changes made in this session (call_me_settings).
const PROJECT_FILE = projectConfigPath();
const sessionOverrides = {};
const config = () => loadConfig(process.env, CONFIG_PATH, PROJECT_FILE, sessionOverrides);
/** Whether this session should own its Twilio number and answer calls to it. */
const answering = (cfg) => INBOUND && !NO.test(cfg.CALL_ME_ANSWER || "");

// ---------------------------------------------------------------- Twilio REST

async function twilio(cfg, method, resource, form) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/${resource}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString("base64"),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${body.message || JSON.stringify(body)}`);
  return body;
}

// ---------------------------------------------------- webhook server + tunnel

let webhook = null; // { port, publicUrl }
const realtimePending = new Map(); // single-use socket token -> options for the call object
const realtimeCalls = new Map(); // CallSid -> RelayCall | RealtimeCall
const amdPending = new Map(); // token -> outbound attempt waiting for answering-machine detection

const wsBase = () => webhook.publicUrl.replace(/^http/, "ws");

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

async function startServer(initial) {
  const server = http.createServer(async (req, res) => {
    const { cfg } = config();
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/health") return res.end("ok");
    const amdRoute = url.pathname.match(/^\/amd\/([a-f0-9]{32})$/);
    const known = (amdRoute && amdPending.has(amdRoute[1])) || (INBOUND && url.pathname === "/incoming");
    if (req.method !== "POST" || !known) {
      res.statusCode = 404;
      return res.end();
    }
    const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const fullUrl = webhook.publicUrl + url.pathname;
    if (!validSignature(cfg.TWILIO_AUTH_TOKEN, fullUrl, params, req.headers["x-twilio-signature"])) {
      log("rejected webhook with bad signature");
      res.statusCode = 403;
      return res.end();
    }
    res.setHeader("Content-Type", "text/xml");

    if (amdRoute) {
      // Answering-machine detection runs in the background while the call already talks; the dialer acts on it.
      amdPending.get(amdRoute[1]).answeredBy = params.AnsweredBy || "unknown";
      return res.end();
    }

    // Inbound: only the user's own phones may talk to the session.
    const profile = speechProfile(cfg);
    if (!allowedCaller(cfg, params.From)) {
      log(`rejected inbound call from ${params.From}`);
      return res.end(REJECT_TWIML);
    }
    // The user calling in is also "calling back": it ends do-not-disturb and hands the saved messages to this
    // session with the first sentence (they aren't read aloud).
    const saved = takeSaved();
    const token = crypto.randomBytes(16).toString("hex");
    realtimePending.set(token, {
      engine: "relay",
      cfg,
      profile,
      opening: profile.inboundGreeting,
      inbound: { from: params.From, to: params.To || cfg.TWILIO_FROM_NUMBER, machine: machineName(cfg), saved },
    });
    setTimeout(() => realtimePending.delete(token), 60000);
    log(`inbound call from ${params.From}`);
    res.end(relayTwiml({ url: `${wsBase()}/relay/${token}`, profile, greeting: profile.inboundGreeting, cfg }));
  });
  // Realtime calls: Twilio opens the call's media stream here, at a single-use random path.
  server.on("upgrade", (req, socket, head) => {
    const token = new URL(req.url, "http://x").pathname.match(/^\/(?:media|relay)\/([a-f0-9]{32})$/)?.[1];
    const p = token && realtimePending.get(token);
    if (!p) return socket.destroy();
    realtimePending.delete(token);
    const tw = acceptUpgrade(req, socket, head);
    if (!tw) return;
    const onEnd = (c) => setTimeout(() => realtimeCalls.delete(c.callSid), 60000);
    let rt;
    if (p.engine === "relay") {
      rt = new RelayCall({ ...p, notify: p.notify || notify, log, twilio, onEnd });
      rt.attach(tw);
    } else {
      rt = new RealtimeCall({ ...p, notify: p.notify || notify, log, twilio, onEnd });
      rt.attachTwilio(tw);
    }
    rt.onCallSid = (sid) => realtimeCalls.set(sid, rt);
    p.attached?.(rt);
  });
  const port = Number(initial.CALL_ME_PORT || 0);
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return server.address().port;
}

const CLOUDFLARED_FILE = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";

function cloudflaredBinary() {
  try {
    execFileSync("cloudflared", ["--version"], { stdio: "ignore" });
    return "cloudflared";
  } catch {}
  const dir = path.join(os.homedir(), ".cache", "claude-call-me");
  const bin = path.join(dir, CLOUDFLARED_FILE);
  return fs.existsSync(bin) ? bin : null;
}

async function downloadCloudflared() {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  const dir = path.join(os.homedir(), ".cache", "claude-call-me");
  const bin = path.join(dir, CLOUDFLARED_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download/";
  if (process.platform === "linux" && arch) {
    log("downloading cloudflared…");
    const res = await fetch(base + `cloudflared-linux-${arch}`);
    if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
    fs.writeFileSync(bin, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  } else if (process.platform === "win32" && arch === "amd64") {
    log("downloading cloudflared…");
    const res = await fetch(base + "cloudflared-windows-amd64.exe");
    if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
    fs.writeFileSync(bin, Buffer.from(await res.arrayBuffer()));
  } else if (process.platform === "darwin" && arch) {
    log("downloading cloudflared…");
    const res = await fetch(base + `cloudflared-darwin-${arch}.tgz`);
    if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
    const tgz = path.join(dir, "cloudflared.tgz");
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    execFileSync("tar", ["-xzf", tgz, "-C", dir]);
    fs.rmSync(tgz);
  } else {
    throw new Error("Install cloudflared (https://github.com/cloudflare/cloudflared) or set CALL_ME_PUBLIC_URL.");
  }
  return bin;
}

let tunnelProc = null;
async function startTunnel(port) {
  const bin = cloudflaredBinary() || (await downloadCloudflared());
  tunnelProc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const publicUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("cloudflared did not report a tunnel URL within 30s")), 30000);
    let buf = "";
    tunnelProc.stderr.on("data", (c) => {
      buf += c;
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    });
    tunnelProc.on("exit", (code) => reject(new Error(`cloudflared exited (${code}): ${buf.slice(-500)}`)));
  });
  tunnelProc.stderr.resume();
  // Quick tunnels take a few seconds to become reachable.
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(publicUrl + "/health")).ok) return publicUrl;
    } catch {}
    await sleep(1000);
  }
  log("warning: tunnel health check never succeeded; trying anyway");
  return publicUrl;
}

let webhookStarting = null;

/** One server and one tunnel per session, even when two callers ask at the same moment (startup claims the number while a call starts). */
function ensureWebhook(cfg) {
  if (webhook) return Promise.resolve(webhook);
  webhookStarting ??= (async () => {
    const port = await startServer(cfg);
    const publicUrl = cfg.CALL_ME_PUBLIC_URL ? cfg.CALL_ME_PUBLIC_URL.replace(/\/$/, "") : await startTunnel(port);
    webhook = { port, publicUrl };
    log(`webhook ready at ${publicUrl} -> 127.0.0.1:${port}`);
    return webhook;
  })().finally(() => (webhookStarting = null));
  return webhookStarting;
}

// --------------------------------------------- inbound: own the Twilio number

let ownedNumber = null; // { sid, phone, voiceUrl } while this session answers calls

async function claimNumber(cfg) {
  const { publicUrl } = await ensureWebhook(cfg);
  const list = await twilio(cfg, "GET", `IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(cfg.TWILIO_FROM_NUMBER)}`);
  const num = list.incoming_phone_numbers?.[0];
  if (!num) throw new Error(`${cfg.TWILIO_FROM_NUMBER} is not a number on this Twilio account`);
  const voiceUrl = `${publicUrl}/incoming`;
  const offline = offlineUrl(speechProfile(cfg));
  // The fallback URL covers a session that dies without releasing the number.
  await twilio(cfg, "POST", `IncomingPhoneNumbers/${num.sid}.json`, {
    VoiceUrl: voiceUrl,
    VoiceMethod: "POST",
    VoiceFallbackUrl: offline,
    VoiceFallbackMethod: "GET",
  });
  ownedNumber = { sid: num.sid, phone: num.phone_number, voiceUrl };
  log(`answering calls to ${cfg.TWILIO_FROM_NUMBER}`);
}

/** Point the number back at the offline message — unless a newer session has taken it over. */
async function releaseNumber() {
  if (!ownedNumber) return;
  const { cfg } = config();
  const { sid, voiceUrl } = ownedNumber;
  ownedNumber = null;
  const num = await twilio(cfg, "GET", `IncomingPhoneNumbers/${sid}.json`);
  if (num.voice_url !== voiceUrl) return;
  await twilio(cfg, "POST", `IncomingPhoneNumbers/${sid}.json`, { VoiceUrl: offlineUrl(speechProfile(cfg)), VoiceMethod: "GET" });
  log("released number");
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.race([releaseNumber().catch((e) => log(`release failed: ${e.message}`)), sleep(5000)]);
  tunnelProc?.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => tunnelProc?.kill());

// ------------------------------------------------------------------ the tool

const RESULT = {
  rejected:
    "The user REJECTED the call (it went to their voicemail; nothing was left there). Do NOT call again. " +
    "The message was saved and is passed on when the user calls back; until then further call_me calls only save messages. " +
    "Carry on without their answer if you can, otherwise wait for them.",
  exhausted: (n, phones = 1) =>
    `The user did not pick up after ${n} attempt(s)${phones > 1 ? ` on each of their ${phones} phones` : ""} (probably busy or away). The message was saved and is passed on when they call back. ` +
    "Do not keep calling; carry on without their answer if you can.",
  dnd: "Not called: the user rejected an earlier call and has not called back yet. The message was saved and is passed on when they call back.",
  short: "The user picked up and hung up immediately; they probably did not hear the message.",
  failed: "Call failed.",
  canceled: "Call was canceled.",
};

/** Seconds Twilio takes to say a line (about 14 characters a second), plus a margin. */
const speakingMs = (text) => 1500 + (String(text).length / 14) * 1000;

/**
 * One outbound call attempt. The call talks from the moment it is picked up (ConversationRelay says `message`
 * first); answering-machine detection runs in the background. Until it says "human", whatever the call hears is
 * held back from the session, so a voicemail greeting never reaches Claude as if the user had said it.
 * Returns { outcome, sid, rt }.
 */
async function placeCall(cfg, to, profile, message, { conversation, engine }) {
  const { publicUrl } = await ensureWebhook(cfg);
  const token = crypto.randomBytes(16).toString("hex");
  const amd = cfg.CALL_ME_AMD !== "0";
  const attempt = { answeredBy: null, rt: null };
  const gate = { open: !amd, queue: [] };
  const gatedNotify = (method, params) => (gate.open ? notify(method, params) : gate.queue.push([method, params]));
  amdPending.set(token, attempt);
  realtimePending.set(token, {
    engine,
    cfg,
    profile,
    opening: message,
    project: path.basename(process.cwd()),
    quiet: !conversation,
    notify: gatedNotify,
    attached: (c) => (attempt.rt = c),
  });
  const call = await twilio(cfg, "POST", "Calls.json", {
    To: to,
    From: cfg.TWILIO_FROM_NUMBER,
    Twiml:
      engine === "relay"
        ? relayTwiml({ url: `${wsBase()}/relay/${token}`, profile, greeting: message, cfg })
        : `${XML}<Response><Connect><Stream url="${wsBase()}/media/${token}"/></Connect></Response>`,
    Timeout: "30",
    ...(amd
      ? {
          MachineDetection: "Enable",
          MachineDetectionTimeout: "8",
          AsyncAmd: "true",
          AsyncAmdStatusCallback: `${publicUrl}/amd/${token}`,
          AsyncAmdStatusCallbackMethod: "POST",
        }
      : {}),
  });
  log(`placed call ${call.sid} to ${to}`);
  const open = () => {
    gate.open = true;
    for (const [m, p] of gate.queue.splice(0)) notify(m, p);
  };

  try {
    const deadline = Date.now() + 90000;
    let c = call;
    let readyAt = 0;
    while (Date.now() < deadline) {
      await sleep(500);
      const { rt } = attempt;
      const by = attempt.answeredBy || "";
      // Voicemail picked up (= the user rejected the call): hang up before it records much.
      if (/^(machine|fax)/.test(by)) {
        gate.queue.length = 0;
        if (rt) await rt.hangup("voicemail");
        else await twilio(cfg, "POST", `Calls/${call.sid}.json`, { Status: "completed" }).catch(() => {});
        return { outcome: "rejected", sid: call.sid };
      }
      if (rt?.ready && !rt.ended) {
        readyAt ||= Date.now();
        // A person: detection says so, or it can't tell, or it is off, or it takes too long.
        if (!amd || /^(human|unknown)/.test(by) || Date.now() - readyAt > 10000) {
          open();
          return { outcome: "answered", sid: call.sid, rt };
        }
        continue;
      }
      if (!rt?.ready || rt?.ended) {
        c = await twilio(cfg, "GET", `Calls/${call.sid}.json`).catch(() => c);
        if (TERMINAL_STATUSES.has(c.status)) break;
      }
    }
    if (!TERMINAL_STATUSES.has(c.status)) {
      await twilio(cfg, "POST", `Calls/${call.sid}.json`, { Status: "completed" }).catch(() => {});
      return { outcome: attempt.rt?.ended ? `failed (${attempt.rt.ended})` : "timed-out", sid: call.sid };
    }
    const outcome = classifyOutcome({ status: c.status, answeredBy: amd ? attempt.answeredBy || c.answered_by || "unknown" : null, duration: c.duration });
    // Picked up but gone before we knew it was a person: they most likely didn't hear the message.
    return { outcome: outcome === "answered" ? "short" : outcome, sid: call.sid };
  } finally {
    amdPending.delete(token);
    realtimePending.delete(token);
  }
}

async function callMe({ message, wait_for_reply = true, language, retries, force = false, engine }) {
  const { cfg, missing } = config();
  if (missing.length)
    throw new Error(`call-me is not configured. Missing ${missing.join(", ")} in ${CONFIG_PATH} (run /call-me:setup).`);
  if (!message || !String(message).trim()) throw new Error("message is required");
  // A conversation needs the channel that carries the user's words into the session (the claude-phone launcher).
  const conversation = wait_for_reply !== false && INBOUND;
  engine = conversation ? engine || cfg.CALL_ME_REALTIME_ENGINE || "relay" : "relay";
  if (!["openai", "relay"].includes(engine)) throw new Error('engine must be "openai" or "relay"');
  if (engine === "openai" && !(cfg.OPENAI_API_KEY || process.env.OPENAI_API_KEY))
    throw new Error(`The OpenAI voice needs OPENAI_API_KEY in ${CONFIG_PATH}; use engine "relay".`);
  const profile = speechProfile(cfg, language);
  const entry = { message, language: profile.language, project: path.basename(process.cwd()), cwd: process.cwd() };
  const dndMinutes = Number(cfg.CALL_ME_DND_MINUTES ?? 120);

  if (!force && dndActive()) {
    saveForCallback(entry);
    return RESULT.dnd;
  }

  const maxRetries = Math.max(0, Number(retries ?? cfg.CALL_ME_RETRIES ?? 4));
  const delay = Number(cfg.CALL_ME_RETRY_DELAY ?? 90) * 1000;
  // Each round rings the main phone, then each backup right away while nobody picks up; a rejection stops it all.
  const targets = callTargets(cfg);
  let r, to;
  rounds: for (let attempt = 0; ; attempt++) {
    for (to of targets) {
      r = await placeCall(cfg, to, profile, message, { conversation, engine });
      log(`round ${attempt + 1}, ${to}: ${r.outcome}`);
      if (!RETRYABLE.has(r.outcome)) break rounds;
    }
    if (attempt >= maxRetries) break;
    await sleep(delay);
    if (dndActive()) break; // rejected another session's call meanwhile
  }

  const tag = ` (call ${r.sid}` + (targets.length > 1 ? `, to ${to}${to === targets[0] ? "" : ", a backup phone"})` : ")");
  switch (r.outcome) {
    case "answered": {
      if (!conversation) {
        // One-way: let the message play out, then hang up.
        const left = speakingMs(message) - (Date.now() - (r.rt.readyAt || Date.now()));
        await sleep(Math.max(0, left));
        await r.rt.hangup();
        return (
          "Call answered; message was delivered." +
          tag +
          (wait_for_reply !== false ? " The user's answer could not be heard: this session wasn't started with the claude-phone launcher." : "")
        );
      }
      realtimeCalls.set(r.sid, r.rt);
      return (
        `The user picked up and is hearing your message${tag}. Everything they say arrives as channel events ` +
        '(realtime="true"): answer each with phone_reply(call_sid, message) within seconds, send short progress updates ' +
        "during longer work, and end the call with end_call: true."
      );
    }
    case "rejected":
      saveForCallback(entry, { dndMinutes });
      return RESULT.rejected + tag;
    case "no-answer":
    case "busy":
      saveForCallback(entry);
      return RESULT.exhausted(maxRetries + 1, targets.length) + tag;
    default:
      return (RESULT[r.outcome] || `Call ended with status ${r.outcome}.`) + tag;
  }
}

/** Claude's next line on a call. Returns at once: the user's next sentence comes as a new channel event. */
async function phoneReply({ call_sid, message, end_call = false, exact = false, voice }) {
  const rt = realtimeCalls.get(call_sid);
  if (!rt) throw new Error(`No call ${call_sid} on this session. Use call_me to call the user.`);
  if (!message || !String(message).trim()) throw new Error("message is required");
  if (voice && !(rt instanceof RelayCall)) throw new Error("voice can only change on ConversationRelay calls");
  return rt.say(message, { endCall: end_call, exact, voice });
}

/** Where a Twilio number's calls currently go, judged from its voice URL. */
function numberOwner(n) {
  const url = n.voice_url || "";
  if (ownedNumber && url === ownedNumber.voiceUrl) return "answered by THIS session";
  // Any call-me session points the number at <its public URL>/incoming (quick tunnel or a permanent address).
  if (/^https:\/\/[^/]+\/incoming$/.test(url)) return "answered by another call-me session";
  if (/twimlets\.com\/echo/.test(url)) return "free (plays the offline message)";
  return url ? "used by another app" : "free (no voice URL)";
}

const SETTING_KEYS = {
  from_number: "TWILIO_FROM_NUMBER",
  to_number: "CALL_ME_TO_NUMBER",
  backup_numbers: "CALL_ME_BACKUP_NUMBERS",
  allowed_callers: "CALL_ME_ALLOWED_CALLERS",
  language: "CALL_ME_LANGUAGE",
  answer_calls: "CALL_ME_ANSWER",
};

/** Show or change this session's numbers (call_me_settings tool). */
async function settings({ scope = "project", list_numbers = false, ...args }) {
  if (!["project", "session"].includes(scope)) throw new Error('scope must be "project" or "session"');
  const values = {};
  for (const [arg, key] of Object.entries(SETTING_KEYS)) {
    const v = args[arg];
    if (v === undefined || v === null) continue;
    if (v === "") values[key] = "";
    else if (arg === "allowed_callers" || arg === "backup_numbers")
      values[key] = (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean).map(e164).join(",");
    else if (arg === "language") values[key] = normalizeLanguage(v);
    else if (arg === "answer_calls") values[key] = v === true || /^(1|true|yes)$/i.test(String(v)) ? "1" : "0";
    else values[key] = e164(v);
  }

  let { cfg } = config();
  if (values.TWILIO_FROM_NUMBER) {
    const list = await twilio(cfg, "GET", `IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(values.TWILIO_FROM_NUMBER)}`);
    if (!list.incoming_phone_numbers?.length)
      throw new Error(`${values.TWILIO_FROM_NUMBER} is not a number on this Twilio account. Buy it in the Twilio console first.`);
  }
  if (Object.keys(values).length) {
    if (scope === "project") {
      updateEnvFile(PROJECT_FILE, values);
      for (const k of Object.keys(values)) delete sessionOverrides[k];
    } else {
      for (const [k, v] of Object.entries(values)) v === "" ? delete sessionOverrides[k] : (sessionOverrides[k] = v);
    }
  }

  // Follow the new settings: hand back a number this session should no longer answer, take over the new one.
  const notes = [];
  ({ cfg } = config());
  const want = answering(cfg) && !!cfg.TWILIO_FROM_NUMBER;
  if (ownedNumber && (!want || ownedNumber.phone !== cfg.TWILIO_FROM_NUMBER)) {
    const old = ownedNumber.phone;
    await releaseNumber();
    notes.push(`Stopped answering ${old}.`);
  }
  if (want && !ownedNumber) {
    await claimNumber(cfg);
    notes.push(`Now answering calls to ${cfg.TWILIO_FROM_NUMBER}.`);
  }
  if (!INBOUND && !NO.test(cfg.CALL_ME_ANSWER || "1"))
    notes.push("This session can't receive calls because it wasn't started with the claude-phone launcher. Restart it that way to answer calls to its number.");
  for (const k of Object.keys(values))
    if (process.env[k] && scope === "project") notes.push(`${k} is also set in the environment, which overrides the project setting.`);

  const shown = (k) => cfg[k] || "(not set)";
  let out =
    `call-me settings for this session (${scope === "project" ? `saved for this project in ${PROJECT_FILE}` : "this session only"}):\n` +
    `- from_number (this session's Twilio number; calls come from it and you dial it to reach this session): ${shown("TWILIO_FROM_NUMBER")}\n` +
    `- to_number (the phone this session calls): ${shown("CALL_ME_TO_NUMBER")}\n` +
    `- backup_numbers (called in this order when to_number doesn't pick up): ${cfg.CALL_ME_BACKUP_NUMBERS || "(none)"}\n` +
    `- allowed_callers (may call this session, besides the phones above): ${cfg.CALL_ME_ALLOWED_CALLERS || "(none)"}\n` +
    `- language: ${cfg.CALL_ME_LANGUAGE || "en-US"}\n` +
    `- answer_calls: ${ownedNumber ? `yes, answering ${ownedNumber.phone}` : answering(cfg) ? "yes, but not answering yet" : "no"}`;
  if (notes.length) out += "\n\n" + notes.join("\n");

  if (list_numbers) {
    const nums = (await twilio(cfg, "GET", "IncomingPhoneNumbers.json?PageSize=100")).incoming_phone_numbers || [];
    out += "\n\nTwilio numbers on the account:\n" + nums.map((n) => `- ${n.phone_number}: ${numberOwner(n)}`).join("\n");
  }
  return out;
}

const TOOLS = [
  {
    name: "call_me",
    description:
      "Phone the user for a live conversation: a natural voice says your message the moment they pick up, then everything they say " +
      "reaches you as channel events (realtime=\"true\") and you answer each with phone_reply. " +
      "Use when the user asked to be called, when a long-running task finishes or fails and they asked to be notified, " +
      "or when you are blocked on a decision and the user said they may be away from the screen. " +
      "Keep the message short and speakable (no code, URLs, or markdown); end with a question if you need a decision. " +
      "Write the message in the call's language. The tool returns once the user picks up (or doesn't). " +
      "Rules (enforced by the tool): an unanswered or busy call is retried automatically (default 4 more times, 90 s apart), " +
      "ringing the backup phones too; if the user rejects the call, it is not retried and later calls are held until the user calls back; " +
      "undelivered messages are saved and passed on when the user calls in. Never loop on this tool yourself.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to say first on the call. Plain spoken sentences, ideally under ~60 words." },
        wait_for_reply: {
          type: "boolean",
          description: "false for a one-way notification: the message is said and the call hangs up (default true: a conversation).",
          default: true,
        },
        retries: { type: "number", description: "Extra attempts if the user doesn't pick up (default 4, 90 s apart). Use 0 for anything not worth repeating." },
        force: { type: "boolean", description: "Call even though the user rejected an earlier call. Only when the user explicitly asked to be called now." },
        engine: {
          type: "string",
          enum: ["relay", "openai"],
          description:
            'The voice: "relay" (Twilio ConversationRelay, natural voice, every sentence goes to you; the default unless CALL_ME_REALTIME_ENGINE says otherwise) ' +
            'or "openai" (OpenAI gpt-live-1 talks and hands requests to you; needs OPENAI_API_KEY; English accent in Polish).',
        },
        language: {
          type: "string",
          enum: ["en-US", "pl-PL"],
          description: "Language of the call: voice, fixed phrases and speech recognition. Omit to use the user's configured default.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "phone_reply",
    description:
      "Say your next line on a call (call_sid from call_me or from a channel event). Returns at once; the user's next sentence " +
      "arrives as a new channel event. Reply within seconds; for longer work first say you're on it, then send progress updates and the result. " +
      "Keep lines short and speakable, in the call's language. End the call with end_call: true. " +
      "If a task will take more than a few minutes, say you'll call back, end the call, and call_me them when done.",
    inputSchema: {
      type: "object",
      properties: {
        call_sid: { type: "string", description: "The call's CallSid." },
        message: { type: "string", description: "What to say. Plain spoken sentences." },
        end_call: { type: "boolean", description: "Say the message, then hang up (default false).", default: false },
        exact: {
          type: "boolean",
          description: "OpenAI voice: say the message word for word (warnings, refusals, numbers). The relay voice always says it word for word.",
        },
        voice: {
          type: "string",
          description:
            'ConversationRelay calls: switch the voice from this line on, as "Provider:VoiceId", e.g. "Amazon:Ola-Neural", ' +
            '"Google:pl-PL-Chirp3-HD-Aoede", "ElevenLabs:W0sqKm1Sfw1EzlCH14FQ" (the Polish default).',
        },
      },
      required: ["call_sid", "message"],
    },
  },
  {
    name: "call_me_settings",
    description:
      "Show or change this session's phone numbers: which Twilio number it calls from and answers (from_number), which phone it calls (to_number) and which backup phones it tries next (backup_numbers), " +
      "which other phones may call it (allowed_callers), its language, and whether it answers calls (answer_calls). " +
      "With no arguments it just shows the current settings. Changes are saved for this project directory (scope project, the default) " +
      "or kept for this session only (scope session). Pass an empty string to reset a value to the machine default. " +
      "list_numbers shows the Twilio numbers on the account and which are already in use. Only change settings the user asked to change.",
    inputSchema: {
      type: "object",
      properties: {
        from_number: { type: "string", description: "This session's Twilio number (E.164). Must be on the Twilio account." },
        to_number: { type: "string", description: "The phone this session calls (E.164)." },
        backup_numbers: {
          type: "array",
          items: { type: "string" },
          description: "Phones to try, in this order, when to_number doesn't pick up (E.164). They may also call in. [] clears the list.",
        },
        allowed_callers: {
          type: "array",
          items: { type: "string" },
          description: "Other phones allowed to call this session (E.164). to_number and backup_numbers are always allowed. [] clears the list.",
        },
        language: { type: "string", enum: ["en-US", "pl-PL", ""], description: "Default language for this session's calls." },
        answer_calls: { type: "boolean", description: "Answer calls to from_number (needs a session started with claude-phone)." },
        scope: { type: "string", enum: ["project", "session"], default: "project", description: "Save for this project (default) or this session only." },
        list_numbers: { type: "boolean", description: "Also list the Twilio numbers on the account and who uses each." },
      },
    },
  },
];

// ------------------------------------------------------------- MCP over stdio

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const CHANNEL_INSTRUCTIONS =
  'Events in <channel source="call-me"> tags are the user talking to you over the phone (speech-to-text, so expect ' +
  "transcription errors). Treat them as a request typed by the user. When meta live=\"true\" the user is on the line: " +
  "answer right away with phone_reply(call_sid, ...), which returns at once; their next sentence comes as a new event. " +
  "Answer within seconds; for longer work first say you're on it, then send progress updates and the result, each with phone_reply. " +
  "A sentence may arrive cut in half when the user pauses: if it looks unfinished, wait for the next event instead of answering. " +
  "End the call with end_call: true when the user says goodbye. For work that takes more than a few minutes, say you will call back, " +
  "end the call, then use call_me. When live=\"false\" the call has ended and the event carries its transcript. " +
  "Reply in the language the user spoke (meta language).";

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) {
    if (method === "notifications/initialized" && INBOUND) {
      const { cfg, missing } = config();
      if (missing.length) log("CALL_ME_INBOUND set but call-me is not configured");
      else if (answering(cfg)) claimNumber(cfg).catch((e) => log(`could not take over the number: ${e.message}`));
    }
    return;
  }
  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {}, ...(INBOUND ? { experimental: { "claude/channel": {} } } : {}) },
          serverInfo: { name: "call-me", version: VERSION },
          ...(INBOUND ? { instructions: CHANNEL_INSTRUCTIONS } : {}),
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const tool = { call_me: callMe, phone_reply: phoneReply, call_me_settings: settings }[params?.name];
        if (!tool) throw Object.assign(new Error(`Unknown tool ${params?.name}`), { code: -32602 });
        try {
          result = { content: [{ type: "text", text: await tool(params.arguments || {}) }] };
        } catch (e) {
          result = { content: [{ type: "text", text: `${params.name} failed: ${e.message}` }], isError: true };
        }
        break;
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: e.code || -32603, message: e.message } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(msg);
});
process.stdin.on("end", shutdown);

const { missing } = config();
log(missing.length ? `not configured yet (missing ${missing.join(", ")}; see ${CONFIG_PATH})` : "ready");

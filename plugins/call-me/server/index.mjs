#!/usr/bin/env node
// call-me MCP server: lets Claude phone you via Twilio and hear your spoken reply.
// With CALL_ME_INBOUND=1 it also takes over the Twilio number so you can call Claude:
// what you say is pushed into the session as a channel event (Claude Code "channels").
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
  buildCallTwiml,
  buildSayHangupTwiml,
  buildInboundTwiml,
  buildHoldTwiml,
  buildLiveTurnTwiml,
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
} from "./lib.mjs";
import { acceptUpgrade } from "./ws.mjs";
import { RealtimeCall } from "./realtime.mjs";
import { RelayCall, relayTwiml } from "./relay.mjs";

const VERSION = "0.9.1";
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

const pending = new Map(); // callId -> { resolve, profile }
const heardSaved = new Map(); // inbound CallSid -> saved messages handed to the session after that call
let webhook = null; // { port, publicUrl }
const realtimePending = new Map(); // media-stream token -> options for the RealtimeCall
const realtimeCalls = new Map(); // CallSid -> RealtimeCall

// Live calls: the user stays on the line while Claude works out its next line (phone_reply).
// CallSid -> { profile, lines: [{message, end}], heard: [], wake, turnStart, saidHold, lastNudge, lastSeen, ended }
const live = new Map();

function startLive(sid, profile) {
  const now = Date.now();
  live.set(sid, { profile, lines: [], heard: [], wake: null, turnStart: now, saidHold: false, lastNudge: now, lastSeen: now, ended: null });
}

function endLive(e, reason) {
  e.ended = e.ended || reason;
  e.wake?.();
}

/** Twilio polls this while the user is on hold. */
function liveWait(cfg, e) {
  const p = e.profile;
  const { publicUrl } = webhook;
  e.lastSeen = Date.now();
  const line = e.lines.shift();
  if (line) {
    e.wake?.();
    if (line.end) {
      endLive(e, "ended by Claude");
      return buildSayHangupTwiml(p, line.message);
    }
    return buildLiveTurnTwiml(p, line.message, `${publicUrl}/live/gather`);
  }
  const waited = Date.now() - e.turnStart;
  if (waited > Number(cfg.CALL_ME_LIVE_HOLD || 120) * 1000) {
    endLive(e, "hold-timeout");
    return buildSayHangupTwiml(p, p.holdTimeout);
  }
  let text = null;
  if (!e.saidHold && waited > 4000) {
    e.saidHold = true;
    e.lastNudge = Date.now();
    text = p.hold;
  } else if (e.saidHold && Date.now() - e.lastNudge > 25000) {
    e.lastNudge = Date.now();
    text = p.stillWorking;
  }
  return buildHoldTwiml(p, `${publicUrl}/live/wait`, text);
}

/** The user spoke (or stayed silent) after Claude's line. */
function liveHeard(e, params) {
  e.lastSeen = Date.now();
  const said = params.SpeechResult || (params.Digits ? `(pressed keys ${params.Digits})` : null);
  if (!said) {
    endLive(e, "no-reply");
    return buildSayHangupTwiml(e.profile, e.profile.noReply);
  }
  e.heard.push(said);
  e.turnStart = Date.now();
  e.saidHold = false;
  e.wake?.();
  return buildHoldTwiml(e.profile, `${webhook.publicUrl}/live/wait`, null);
}

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
    const outbound = url.pathname.match(/^\/gather\/([a-f0-9]{32})$/);
    const amdRoute = url.pathname.match(/^\/amd\/([a-f0-9]{32})$/);
    const liveRoute = url.pathname.match(/^\/live\/(wait|gather)$/);
    const known =
      (outbound && pending.has(outbound[1])) ||
      (amdRoute && pending.has(amdRoute[1])) || liveRoute || (INBOUND && /^\/incoming(\/gather)?$/.test(url.pathname));
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
      // Async answering machine detection: the message is already playing; the call loop hangs up on a machine.
      pending.get(amdRoute[1]).answeredBy = params.AnsweredBy || "unknown";
      return res.end();
    }

    if (liveRoute) {
      const e = live.get(params.CallSid);
      if (!e || e.ended) return res.end(buildSayHangupTwiml(speechProfile(cfg), speechProfile(cfg).bye));
      return res.end(liveRoute[1] === "wait" ? liveWait(cfg, e) : liveHeard(e, params));
    }

    if (outbound) {
      const { resolve, profile, stayOnLine } = pending.get(outbound[1]);
      resolve({
        speech: params.SpeechResult || null,
        confidence: params.Confidence ? Number(params.Confidence) : null,
        digits: params.Digits || null,
      });
      if (stayOnLine && (params.SpeechResult || params.Digits)) {
        startLive(params.CallSid, profile);
        return res.end(buildHoldTwiml(profile, `${webhook.publicUrl}/live/wait`, null));
      }
      return res.end(buildSayHangupTwiml(profile, profile.ack));
    }

    // Inbound: only the user's own phones may talk to the session.
    const profile = speechProfile(cfg);
    if (!allowedCaller(cfg, params.From)) {
      log(`rejected inbound call from ${params.From}`);
      return res.end(REJECT_TWIML);
    }
    if (url.pathname === "/incoming") {
      // The user calling in is also "calling back": it ends do-not-disturb and hands the saved messages to this
      // session. They are read aloud first only with CALL_ME_READ_SAVED=1.
      const saved = takeSaved();
      if (saved.length) heardSaved.set(params.CallSid, saved);
      const readAloud = cfg.CALL_ME_READ_SAVED === "1";
      return res.end(
        buildInboundTwiml(profile, `${webhook.publicUrl}/incoming/gather`, readAloud ? saved : [], saved.length > 0),
      );
    }
    const saved = heardSaved.get(params.CallSid) || [];
    heardSaved.delete(params.CallSid);
    if (params.SpeechResult || saved.length) {
      log(`inbound message from ${params.From}`);
      const readAloud = cfg.CALL_ME_READ_SAVED === "1";
      let content = params.SpeechResult || "(the user said nothing)";
      if (saved.length)
        content +=
          (readAloud
            ? "\n\nBefore speaking, the user heard these saved messages from earlier unanswered calls " +
              "(route any answer to the session working in that project):\n"
            : "\n\nSaved messages from earlier unanswered calls. The user has NOT heard them: do not read them out on the call " +
              "unless asked; list them on screen (project and gist) and pass them to the sessions working in those projects:\n") +
          saved.map((m) => `- [${m.project}, ${m.cwd}, ${m.at}] ${m.message}`).join("\n");
      const liveCall = !NO.test(cfg.CALL_ME_LIVE || "") && !!params.SpeechResult;
      if (liveCall) startLive(params.CallSid, profile);
      notify("notifications/claude/channel", {
        content,
        meta: {
          live: String(liveCall),
          from: params.From,
          to: params.To || cfg.TWILIO_FROM_NUMBER,
          machine: machineName(cfg),
          language: profile.language,
          confidence: params.Confidence ? Number(params.Confidence).toFixed(2) : "unknown",
          call_sid: params.CallSid,
          saved_messages: String(saved.length),
          saved_messages_heard: String(readAloud ? saved.length : 0),
        },
      });
      if (liveCall) return res.end(buildHoldTwiml(profile, `${webhook.publicUrl}/live/wait`, null));
      return res.end(buildSayHangupTwiml(profile, params.SpeechResult ? profile.inboundAck : profile.inboundEmpty));
    }
    res.end(buildSayHangupTwiml(profile, profile.inboundEmpty));
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
      rt = new RelayCall({ ...p, notify, log, twilio, onEnd });
      rt.attach(tw);
    } else {
      rt = new RealtimeCall({ ...p, notify, log, twilio, onEnd });
      rt.attachTwilio(tw);
    }
    tw.once("message", () => setTimeout(() => rt.callSid && realtimeCalls.set(rt.callSid, rt), 0));
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

async function ensureWebhook(cfg) {
  if (webhook) return webhook;
  const port = await startServer(cfg);
  const publicUrl = cfg.CALL_ME_PUBLIC_URL ? cfg.CALL_ME_PUBLIC_URL.replace(/\/$/, "") : await startTunnel(port);
  webhook = { port, publicUrl };
  log(`webhook ready at ${publicUrl} -> 127.0.0.1:${port}`);
  return webhook;
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

/** One outbound call attempt. Returns { outcome, reply, sid }. */
async function placeCall(cfg, to, profile, message, wait_for_reply, timeout_seconds, stayOnLine = false) {
  const callId = crypto.randomBytes(16).toString("hex");
  let gatherUrl = null;
  let replyPromise = new Promise(() => {});
  let entry = null;
  if (wait_for_reply) {
    const { publicUrl } = await ensureWebhook(cfg);
    gatherUrl = `${publicUrl}/gather/${callId}`;
    replyPromise = new Promise((resolve) => {
      entry = { resolve, profile, stayOnLine, answeredBy: null };
      pending.set(callId, entry);
    });
  }

  const amd = cfg.CALL_ME_AMD !== "0";
  // With a webhook, detection runs in the background (AsyncAmd) so the message starts as soon as the user
  // picks up; synchronous detection made them wait in silence for a few seconds first.
  const amdParams = !amd
    ? {}
    : entry
      ? {
          MachineDetection: "Enable",
          MachineDetectionTimeout: "8",
          AsyncAmd: "true",
          AsyncAmdStatusCallback: `${webhook.publicUrl}/amd/${callId}`,
          AsyncAmdStatusCallbackMethod: "POST",
        }
      : { MachineDetection: "Enable", MachineDetectionTimeout: "8" };
  const call = await twilio(cfg, "POST", "Calls.json", {
    To: to,
    From: cfg.TWILIO_FROM_NUMBER,
    Twiml: buildCallTwiml(message, profile, gatherUrl),
    Timeout: "30",
    ...amdParams,
  });
  log(`placed call ${call.sid}`);

  const deadline = Date.now() + timeout_seconds * 1000;
  let reply = null;
  let c = call;
  replyPromise.then((r) => (reply = r));
  try {
    while (Date.now() < deadline) {
      await Promise.race([replyPromise, sleep(1000)]);
      if (reply) break;
      c = await twilio(cfg, "GET", `Calls/${call.sid}.json`);
      // Voicemail picked up (= the user rejected the call): hang up before leaving a message.
      if (/^(machine|fax)/.test(entry?.answeredBy || c.answered_by || "") && !TERMINAL_STATUSES.has(c.status)) {
        await twilio(cfg, "POST", `Calls/${call.sid}.json`, { Status: "completed" }).catch(() => {});
        c = { ...c, status: "completed" };
        break;
      }
      if (TERMINAL_STATUSES.has(c.status)) break;
    }
  } finally {
    pending.delete(callId);
  }
  if (reply) return { outcome: "answered", reply, sid: call.sid };
  if (!TERMINAL_STATUSES.has(c.status)) {
    await twilio(cfg, "POST", `Calls/${call.sid}.json`, { Status: "completed" }).catch(() => {});
    return { outcome: "timed-out", sid: call.sid };
  }
  const outcome = classifyOutcome({ status: c.status, answeredBy: amd ? entry?.answeredBy || c.answered_by || "unknown" : null, duration: c.duration });
  return { outcome, sid: call.sid };
}

async function callMe({ message, wait_for_reply = true, timeout_seconds = 180, language, retries, force = false, stay_on_line = false, realtime = false, engine }) {
  const { cfg, missing } = config();
  if (missing.length)
    throw new Error(`call-me is not configured. Missing ${missing.join(", ")} in ${CONFIG_PATH} (run /call-me:setup).`);
  if (!message || !String(message).trim()) throw new Error("message is required");
  if (realtime) return callMeRealtime(cfg, { message, language, force, engine });
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
      r = await placeCall(cfg, to, profile, message, wait_for_reply || stay_on_line, timeout_seconds, stay_on_line);
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
      const onLine = live.has(r.sid)
        ? ` The user is still on the line: answer with phone_reply (call_sid "${r.sid}") right away; end with end_call: true.`
        : "";
      if (r.reply?.speech)
        return `User replied by voice: "${r.reply.speech}"` + (r.reply.confidence != null ? ` (confidence ${r.reply.confidence.toFixed(2)})` : "") + tag + onLine;
      if (r.reply?.digits) return `User pressed keys: ${r.reply.digits}${tag}${onLine}`;
      return (wait_for_reply ? "Call was answered but the user gave no reply." : "Call answered; message was delivered.") + tag;
    }
    case "rejected":
      saveForCallback(entry, { dndMinutes });
      return RESULT.rejected + tag;
    case "no-answer":
    case "busy":
      saveForCallback(entry);
      return RESULT.exhausted(maxRetries + 1, targets.length) + tag;
    case "timed-out":
      return `No reply within ${timeout_seconds}s; call was ended.${tag}`;
    default:
      return (RESULT[r.outcome] || `Call ended with status ${r.outcome}.`) + tag;
  }
}

/** Say the next line on a live call and return what the user says back. */
/**
 * Experimental: a live call where OpenAI's gpt-live-1 does the talking and Claude answers hand-offs with phone_reply.
 * Returns once the call is connected (or failed); everything after that arrives as channel events.
 */
async function callMeRealtime(cfg, { message, language, force, engine }) {
  engine = engine || cfg.CALL_ME_REALTIME_ENGINE || "openai";
  if (!["openai", "relay"].includes(engine)) throw new Error('engine must be "openai" or "relay"');
  if (!INBOUND) throw new Error("Realtime calls need a session started with the claude-phone launcher (channels).");
  if (engine === "openai" && !(cfg.OPENAI_API_KEY || process.env.OPENAI_API_KEY))
    throw new Error(`Realtime calls with the OpenAI voice need OPENAI_API_KEY in ${CONFIG_PATH}.`);
  if (!force && dndActive()) return RESULT.dnd;
  const profile = speechProfile(cfg, language);
  const { publicUrl } = await ensureWebhook(cfg);
  const token = crypto.randomBytes(16).toString("hex");
  let rt = null;
  realtimePending.set(token, {
    engine,
    cfg,
    language: profile.language,
    opening: message,
    project: path.basename(process.cwd()),
    attached: (c) => (rt = c),
  });
  const wsBase = publicUrl.replace(/^http/, "ws");
  const call = await twilio(cfg, "POST", "Calls.json", {
    To: callTargets(cfg)[0],
    From: cfg.TWILIO_FROM_NUMBER,
    Twiml:
      engine === "relay"
        ? relayTwiml({ url: `${wsBase}/relay/${token}`, language: profile.language, greeting: message, cfg })
        : `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${wsBase}/media/${token}"/></Connect></Response>`,
    Timeout: "30",
  });
  log(`placed realtime call ${call.sid}`);
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (rt?.ready) {
      realtimeCalls.set(call.sid, rt);
      return (
        `Realtime call connected (call ${call.sid}, ${engine === "relay" ? "Twilio ConversationRelay voice" : "OpenAI gpt-live-1 voice"}). ` +
        'Whenever it hands something to you, a channel event with realtime="true" arrives: answer with phone_reply(call_sid, message). ' +
        "Answer quickly, send short progress updates during long work, and end with end_call: true."
      );
    }
    if (rt?.ended) break;
    const c = await twilio(cfg, "GET", `Calls/${call.sid}.json`).catch(() => null);
    if (c && TERMINAL_STATUSES.has(c.status)) {
      realtimePending.delete(token);
      return `Realtime call did not connect: ${c.status}.`;
    }
  }
  realtimePending.delete(token);
  if (!rt?.ended) await twilio(cfg, "POST", `Calls/${call.sid}.json`, { Status: "completed" }).catch(() => {});
  return `Realtime call failed: ${rt?.ended || "the voice did not start within 75 s"}.`;
}

async function phoneReply({ call_sid, message, end_call = false, timeout_seconds = 120, exact = false, voice }) {
  const rt = realtimeCalls.get(call_sid);
  if (rt) {
    if (!message || !String(message).trim()) throw new Error("message is required");
    if (voice && !(rt instanceof RelayCall)) throw new Error("voice can only change on ConversationRelay calls");
    return rt.say(message, { endCall: end_call, exact, voice });
  }
  const { cfg } = config();
  const e = live.get(call_sid);
  if (!e) throw new Error(`No live call ${call_sid}. Use call_me to call the user.`);
  if (e.ended) {
    live.delete(call_sid);
    return `The call has already ended (${e.ended}); nothing was said. Use call_me if the user still needs to hear it.`;
  }
  if (!message || !String(message).trim()) throw new Error("message is required");
  e.heard.length = 0; // anything said before this line has already been answered or is stale
  e.lines.push({ message, end: end_call });
  const deadline = Date.now() + (end_call ? 15 : timeout_seconds) * 1000;
  let lastCheck = Date.now();
  while (Date.now() < deadline) {
    if (end_call ? !e.lines.length : e.heard.length || e.ended) break;
    await new Promise((r) => {
      e.wake = r;
      setTimeout(r, 1000);
    });
    e.wake = null;
    // Twilio polls at least every few seconds while the call is up; long silence means the user may have hung up.
    if (Date.now() - e.lastSeen > 20000 && Date.now() - lastCheck > 5000) {
      lastCheck = Date.now();
      const c = await twilio(cfg, "GET", `Calls/${call_sid}.json`).catch(() => null);
      if (c && TERMINAL_STATUSES.has(c.status)) endLive(e, "the user hung up");
    }
  }
  if (end_call) {
    live.delete(call_sid);
    return e.lines.length ? "The call ended before the line could be said." : "Said it and hung up.";
  }
  if (e.heard.length) return `User said: "${e.heard.splice(0).join(" ")}" (still on the line; answer with phone_reply)`;
  if (e.ended) {
    live.delete(call_sid);
    return e.ended === "no-reply"
      ? "The user said nothing after your line; the call was ended."
      : `The call has ended (${e.ended}).` + (e.lines.length ? " Your line was not said." : "");
  }
  return `No reply within ${timeout_seconds}s; the user is still on hold. Call phone_reply again or end the call with end_call: true.`;
}

/** Where a Twilio number's calls currently go, judged from its voice URL. */
function numberOwner(n) {
  const url = n.voice_url || "";
  if (ownedNumber && url === ownedNumber.voiceUrl) return "answered by THIS session";
  if (/trycloudflare\.com\/incoming$/.test(url)) return "answered by another call-me session";
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
      "Phone the user and speak a message aloud (text-to-speech), then optionally listen for their spoken or keypad reply and return it. " +
      "Use when the user asked to be called, when a long-running task finishes or fails and they asked to be notified, " +
      "or when you are blocked on a decision and the user said they may be away from the screen. " +
      "Keep the message short and speakable (no code, URLs, or markdown). If you need a decision, phrase it as a question with simple options. " +
      "Write the message in the call's language. " +
      "Rules (enforced by the tool): an unanswered or busy call is retried automatically (default 4 more times, 90 s apart); " +
      "if the user rejects the call, it is not retried and later calls are held until the user calls back; " +
      "undelivered messages are saved and passed on when the user calls in. Never loop on this tool yourself.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to say on the call. Plain spoken sentences, ideally under ~60 words." },
        wait_for_reply: { type: "boolean", description: "Listen for and return the user's reply (default true). Set false for a one-way notification.", default: true },
        timeout_seconds: { type: "number", description: "Max seconds to wait for the call to finish (default 180).", default: 180 },
        retries: { type: "number", description: "Extra attempts if the user doesn't pick up (default 4, 90 s apart). Use 0 for anything not worth repeating." },
        force: { type: "boolean", description: "Call even though the user rejected an earlier call. Only when the user explicitly asked to be called now." },
        stay_on_line: {
          type: "boolean",
          description: "Keep the call open after the user's reply for a live conversation: answer with phone_reply. Use when the user may want to talk it through.",
        },
        realtime: {
          type: "boolean",
          description:
            "Experimental: a fast realtime voice (OpenAI gpt-live-1) talks with the user and hands their requests to you as channel events; " +
            "answer each with phone_reply. Needs OPENAI_API_KEY and a claude-phone session. Use only when the user asks for a realtime call.",
        },
        engine: {
          type: "string",
          enum: ["openai", "relay"],
          description:
            'Realtime voice: "openai" (gpt-live-1, instant small talk, English accent in Polish) or "relay" (Twilio ConversationRelay: ' +
            "natural Polish voice, every sentence goes to you). Default: CALL_ME_REALTIME_ENGINE or openai.",
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
      "Live phone conversation: say your next line to a user who is still on the line (call_sid from a live channel event or from call_me with stay_on_line) " +
      "and return what they say back. The user hears 'one moment' while you work, and the call ends after about 2 minutes on hold, " +
      "so reply quickly. Keep lines short and speakable, in the call's language. Finish with end_call: true. " +
      "If a task will take longer than a minute, say so, end the call, and call_me them when done.",
    inputSchema: {
      type: "object",
      properties: {
        call_sid: { type: "string", description: "The live call's CallSid." },
        message: { type: "string", description: "What to say. Plain spoken sentences." },
        end_call: { type: "boolean", description: "Say the message, then hang up (default false).", default: false },
        timeout_seconds: { type: "number", description: "Max seconds to wait for the user's answer (default 120).", default: 120 },
        exact: {
          type: "boolean",
          description: "Realtime calls: have the voice say the message word for word (warnings, refusals, numbers). Default: it may phrase it naturally.",
        },
        voice: {
          type: "string",
          description:
            'ConversationRelay calls: switch the voice from this line on, as "Provider:VoiceId", e.g. "Google:pl-PL-Chirp3-HD-Charon", ' +
            '"Google:pl-PL-Chirp3-HD-Aoede", "Amazon:Ola-Neural", "ElevenLabs:W0sqKm1Sfw1EzlCH14FQ" (the Polish default).',
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
  "transcription errors). Treat them as a request typed by the user. The user is away from the screen: when you finish, " +
  "or if you need a decision, phone them back with the call_me tool, in the language they spoke (meta language). " +
  'When meta live="true" the user is still on the line, on hold: answer right away with phone_reply(call_sid, ...), ' +
  "which returns their next sentence, and keep the conversation going; end it with end_call: true. For work that takes more " +
  "than about a minute (such as handing a task to another session), say you will call back, end the call, then use call_me. " +
  'When meta realtime="true", a separate fast voice is talking with the user and handed you this request: phone_reply returns at once, ' +
  "and the next request comes as a new event. Answer within seconds; for longer work first send a short status (\"on it\"), " +
  "then progress updates and the result, each with phone_reply. Use exact: true for warnings, refusals and numbers.";

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

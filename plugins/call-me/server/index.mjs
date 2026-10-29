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
  speechProfile,
  buildCallTwiml,
  buildSayHangupTwiml,
  buildInboundTwiml,
  offlineUrl,
  samePhone,
  REJECT_TWIML,
  validSignature,
  TERMINAL_STATUSES,
  classifyOutcome,
  RETRYABLE,
  saveForCallback,
  takeSaved,
  dndActive,
} from "./lib.mjs";

const VERSION = "0.3.0";
const INBOUND = /^(1|true|yes)$/i.test(process.env.CALL_ME_INBOUND || "");
const log = (...a) => process.stderr.write(`[call-me] ${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const heardSaved = new Map(); // inbound CallSid -> saved messages read to the user on that call
let webhook = null; // { port, publicUrl }

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

async function startServer(cfg) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/health") return res.end("ok");
    const outbound = url.pathname.match(/^\/gather\/([a-f0-9]{32})$/);
    const known = (outbound && pending.has(outbound[1])) || (INBOUND && /^\/incoming(\/gather)?$/.test(url.pathname));
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

    if (outbound) {
      const { resolve, profile } = pending.get(outbound[1]);
      resolve({
        speech: params.SpeechResult || null,
        confidence: params.Confidence ? Number(params.Confidence) : null,
        digits: params.Digits || null,
      });
      return res.end(buildSayHangupTwiml(profile, profile.ack));
    }

    // Inbound: only the user's own phone may talk to the session.
    const profile = speechProfile(cfg);
    if (!samePhone(params.From, cfg.CALL_ME_TO_NUMBER)) {
      log(`rejected inbound call from ${params.From}`);
      return res.end(REJECT_TWIML);
    }
    if (url.pathname === "/incoming") {
      // The user calling in is also "calling back": read saved messages and end do-not-disturb.
      const saved = takeSaved();
      if (saved.length) heardSaved.set(params.CallSid, saved);
      return res.end(buildInboundTwiml(profile, `${webhook.publicUrl}/incoming/gather`, saved));
    }
    const saved = heardSaved.get(params.CallSid) || [];
    heardSaved.delete(params.CallSid);
    if (params.SpeechResult || saved.length) {
      log(`inbound message from ${params.From}`);
      let content = params.SpeechResult || "(the user said nothing after hearing the saved messages)";
      if (saved.length)
        content +=
          "\n\nBefore speaking, the user heard these saved messages from earlier unanswered calls " +
          "(route any answer to the session working in that project):\n" +
          saved.map((m) => `- [${m.project}, ${m.cwd}, ${m.at}] ${m.message}`).join("\n");
      notify("notifications/claude/channel", {
        content,
        meta: {
          from: params.From,
          language: profile.language,
          confidence: params.Confidence ? Number(params.Confidence).toFixed(2) : "unknown",
          call_sid: params.CallSid,
          saved_messages_heard: String(saved.length),
        },
      });
      return res.end(buildSayHangupTwiml(profile, params.SpeechResult ? profile.inboundAck : profile.inboundEmpty));
    }
    res.end(buildSayHangupTwiml(profile, profile.inboundEmpty));
  });
  const port = Number(cfg.CALL_ME_PORT || 0);
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return server.address().port;
}

function cloudflaredBinary() {
  try {
    execFileSync("cloudflared", ["--version"], { stdio: "ignore" });
    return "cloudflared";
  } catch {}
  const dir = path.join(os.homedir(), ".cache", "claude-call-me");
  const bin = path.join(dir, "cloudflared");
  return fs.existsSync(bin) ? bin : null;
}

async function downloadCloudflared() {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  const dir = path.join(os.homedir(), ".cache", "claude-call-me");
  const bin = path.join(dir, "cloudflared");
  fs.mkdirSync(dir, { recursive: true });
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download/";
  if (process.platform === "linux" && arch) {
    log("downloading cloudflared…");
    const res = await fetch(base + `cloudflared-linux-${arch}`);
    if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
    fs.writeFileSync(bin, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
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

let ownedNumber = null; // { sid, voiceUrl } while this session answers calls

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
  ownedNumber = { sid: num.sid, voiceUrl };
  log(`answering calls to ${cfg.TWILIO_FROM_NUMBER}`);
}

/** Point the number back at the offline message — unless a newer session has taken it over. */
async function releaseNumber() {
  if (!ownedNumber) return;
  const { cfg } = loadConfig();
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
    "The message was saved and will be read to the user when they call back; until then further call_me calls only save messages. " +
    "Carry on without their answer if you can, otherwise wait for them.",
  exhausted: (n) =>
    `The user did not pick up after ${n} attempt(s) (probably busy or away). The message was saved and will be read to them when they call back. ` +
    "Do not keep calling; carry on without their answer if you can.",
  dnd: "Not called: the user rejected an earlier call and has not called back yet. The message was saved and will be read to them when they call back.",
  short: "The user picked up and hung up immediately; they probably did not hear the message.",
  failed: "Call failed.",
  canceled: "Call was canceled.",
};

/** One outbound call attempt. Returns { outcome, reply, sid }. */
async function placeCall(cfg, profile, message, wait_for_reply, timeout_seconds) {
  const callId = crypto.randomBytes(16).toString("hex");
  let gatherUrl = null;
  let replyPromise = new Promise(() => {});
  if (wait_for_reply) {
    const { publicUrl } = await ensureWebhook(cfg);
    gatherUrl = `${publicUrl}/gather/${callId}`;
    replyPromise = new Promise((resolve) => pending.set(callId, { resolve, profile }));
  }

  const amd = cfg.CALL_ME_AMD !== "0";
  const call = await twilio(cfg, "POST", "Calls.json", {
    To: cfg.CALL_ME_TO_NUMBER,
    From: cfg.TWILIO_FROM_NUMBER,
    Twiml: buildCallTwiml(message, profile, gatherUrl),
    Timeout: "30",
    ...(amd ? { MachineDetection: "Enable", MachineDetectionTimeout: "8" } : {}),
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
      if (/^(machine|fax)/.test(c.answered_by || "") && !TERMINAL_STATUSES.has(c.status)) {
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
  const outcome = classifyOutcome({ status: c.status, answeredBy: amd ? c.answered_by || "unknown" : null, duration: c.duration });
  return { outcome, sid: call.sid };
}

async function callMe({ message, wait_for_reply = true, timeout_seconds = 180, language, retries, force = false }) {
  const { cfg, missing } = loadConfig();
  if (missing.length)
    throw new Error(`call-me is not configured. Missing ${missing.join(", ")} in ${CONFIG_PATH} (run /call-me:setup).`);
  if (!message || !String(message).trim()) throw new Error("message is required");
  const profile = speechProfile(cfg, language);
  const entry = { message, language: profile.language, project: path.basename(process.cwd()), cwd: process.cwd() };
  const dndMinutes = Number(cfg.CALL_ME_DND_MINUTES ?? 120);

  if (!force && dndActive()) {
    saveForCallback(entry);
    return RESULT.dnd;
  }

  const maxRetries = Math.max(0, Number(retries ?? cfg.CALL_ME_RETRIES ?? 4));
  const delay = Number(cfg.CALL_ME_RETRY_DELAY ?? 90) * 1000;
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await placeCall(cfg, profile, message, wait_for_reply, timeout_seconds);
    log(`attempt ${attempt + 1}: ${r.outcome}`);
    if (!RETRYABLE.has(r.outcome) || attempt >= maxRetries) break;
    await sleep(delay);
    if (dndActive()) break; // rejected another session's call meanwhile
  }

  const tag = ` (call ${r.sid})`;
  switch (r.outcome) {
    case "answered":
      if (r.reply?.speech)
        return `User replied by voice: "${r.reply.speech}"` + (r.reply.confidence != null ? ` (confidence ${r.reply.confidence.toFixed(2)})` : "") + tag;
      if (r.reply?.digits) return `User pressed keys: ${r.reply.digits}${tag}`;
      return (wait_for_reply ? "Call was answered but the user gave no reply." : "Call answered; message was delivered.") + tag;
    case "rejected":
      saveForCallback(entry, { dndMinutes });
      return RESULT.rejected + tag;
    case "no-answer":
    case "busy":
      saveForCallback(entry);
      return RESULT.exhausted(maxRetries + 1) + tag;
    case "timed-out":
      return `No reply within ${timeout_seconds}s; call was ended.${tag}`;
    default:
      return (RESULT[r.outcome] || `Call ended with status ${r.outcome}.`) + tag;
  }
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
      "undelivered messages are saved and read to the user when they call in. Never loop on this tool yourself.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to say on the call. Plain spoken sentences, ideally under ~60 words." },
        wait_for_reply: { type: "boolean", description: "Listen for and return the user's reply (default true). Set false for a one-way notification.", default: true },
        timeout_seconds: { type: "number", description: "Max seconds to wait for the call to finish (default 180).", default: 180 },
        retries: { type: "number", description: "Extra attempts if the user doesn't pick up (default 4, 90 s apart). Use 0 for anything not worth repeating." },
        force: { type: "boolean", description: "Call even though the user rejected an earlier call. Only when the user explicitly asked to be called now." },
        language: {
          type: "string",
          enum: ["en-US", "pl-PL"],
          description: "Language of the call: voice, fixed phrases and speech recognition. Omit to use the user's configured default.",
        },
      },
      required: ["message"],
    },
  },
];

// ------------------------------------------------------------- MCP over stdio

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const CHANNEL_INSTRUCTIONS =
  'Events in <channel source="call-me"> tags are the user talking to you over the phone (speech-to-text, so expect ' +
  "transcription errors). Treat them as a request typed by the user. The user is away from the screen: when you finish, " +
  "or if you need a decision, phone them back with the call_me tool, in the language they spoke (meta language).";

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) {
    if (method === "notifications/initialized" && INBOUND) {
      const { cfg, missing } = loadConfig();
      if (missing.length) log("CALL_ME_INBOUND set but call-me is not configured");
      else claimNumber(cfg).catch((e) => log(`could not take over the number: ${e.message}`));
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
        if (params?.name !== "call_me") throw Object.assign(new Error(`Unknown tool ${params?.name}`), { code: -32602 });
        try {
          result = { content: [{ type: "text", text: await callMe(params.arguments || {}) }] };
        } catch (e) {
          result = { content: [{ type: "text", text: `call_me failed: ${e.message}` }], isError: true };
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

const { missing } = loadConfig();
log(missing.length ? `not configured yet (missing ${missing.join(", ")}; see ${CONFIG_PATH})` : "ready");

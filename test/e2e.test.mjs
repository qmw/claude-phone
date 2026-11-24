// Drives the real MCP server over stdio with a fake Twilio API and signed webhooks on localhost.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { twilioSignature } from "../plugins/call-me/server/lib.mjs";
import { connect } from "../plugins/call-me/server/ws.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const TOKEN = "tok";
const ME = "+48500000001";
let PORT, BASE;

function startServer(extraEnv = {}) {
  PORT = 20000 + Math.floor(Math.random() * 20000);
  BASE = `http://127.0.0.1:${PORT}`;
  const proc = spawn(process.execPath, ["--import", here("./fake-twilio.mjs"), here("../plugins/call-me/server/index.mjs")], {
    env: {
      ...process.env,
      CALL_ME_CONFIG: "/nonexistent",
      TWILIO_ACCOUNT_SID: "ACtest",
      TWILIO_AUTH_TOKEN: TOKEN,
      TWILIO_FROM_NUMBER: "+17250000000",
      CALL_ME_TO_NUMBER: ME,
      CALL_ME_LANGUAGE: "pl-PL",
      CALL_ME_INBOUND: "1",
      CALL_ME_MACHINE: "laptop",
      CALL_ME_ALLOWED_CALLERS: "+48600000001",
      CALL_ME_PUBLIC_URL: BASE,
      CALL_ME_PORT: String(PORT),
      CALL_ME_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cm-state-")),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [], twilio = [], waiters = [];
  const check = () => waiters.splice(0).forEach((w) => (w.pred() ? w.resolve() : waiters.push(w)));
  readline.createInterface({ input: proc.stdout }).on("line", (l) => (stdout.push(JSON.parse(l)), check()));
  readline.createInterface({ input: proc.stderr }).on("line", (l) => {
    if (l.startsWith("TWILIO ")) twilio.push(JSON.parse(l.slice(7)));
    else if (process.env.E2E_DEBUG) console.error("SERVER", l);
    check();
  });
  const until = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      if (pred()) return resolve();
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error("timed out waiting")), ms);
    });
  const send = (m) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  return { proc, stdout, twilio, until, send };
}

async function webhook(path, params, { sign = true } = {}) {
  const url = BASE + path;
  const res = await fetch(url, {
    method: "POST",
    headers: sign ? { "x-twilio-signature": twilioSignature(TOKEN, url, params) } : {},
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await res.text() };
}


const INIT = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the server, take over the number, and return helpers. */
async function ready(extraEnv) {
  const s = startServer(extraEnv);
  s.send(INIT);
  await s.until(() => s.stdout.some((m) => m.id === 1));
  s.send({ method: "notifications/initialized" });
  if (extraEnv?.CALL_ME_INBOUND !== "") await s.until(() => s.twilio.some((r) => r.form.VoiceUrl));
  let id = 100;
  s.tool = (name, args) => {
    const n = ++id;
    s.send({ id: n, method: "tools/call", params: { name, arguments: args } });
    return async (ms = 15000) => {
      await s.until(() => s.stdout.some((m) => m.id === n), ms);
      const r = s.stdout.find((m) => m.id === n).result;
      return r.isError ? `ERROR ${r.content[0].text}` : r.content[0].text;
    };
  };
  s.created = () => s.twilio.filter((r) => r.method === "POST" && r.path.endsWith("/Calls.json"));
  s.events = () => s.stdout.filter((m) => m.method === "notifications/claude/channel").map((m) => m.params);
  return s;
}

/** Act as Twilio ConversationRelay for a TwiML document: open its socket and send setup. */
async function relay(twiml, callSid) {
  const ws = await connect(twiml.match(/<ConversationRelay url="([^"]+)"/)[1]);
  const said = [];
  ws.on("message", (m) => said.push(JSON.parse(m)));
  ws.send({ type: "setup", callSid });
  ws.said = said;
  ws.prompt = (text) => ws.send({ type: "prompt", voicePrompt: text, last: true });
  return ws;
}

/** The n-th outbound call (1-based) is picked up: ConversationRelay connects and detection reports `answeredBy`. */
async function pickUp(s, n, answeredBy = "human", before) {
  await s.until(() => s.created().length >= n, 10000);
  const form = s.created()[n - 1].form;
  const ws = await relay(form.Twiml, `CA${n}`);
  await before?.(ws);
  if (answeredBy) {
    await wait(100);
    const amdPath = form.AsyncAmdStatusCallback.slice(BASE.length);
    assert.equal((await webhook(amdPath, { CallSid: `CA${n}`, AnsweredBy: answeredBy })).status, 200);
  }
  return ws;
}

const until = async (pred, ms = 5000) => {
  for (const end = Date.now() + ms; !pred(); await wait(20)) if (Date.now() > end) throw new Error("timed out");
};

test("inbound: number taken over, strangers rejected, the caller talks with the session, number released on exit", async () => {
  const s = await ready({ CALL_ME_RELAY_TTS: "Amazon", CALL_ME_RELAY_VOICE: "Ola-Neural" });
  try {
    const init = s.stdout.find((m) => m.id === 1).result;
    assert.deepEqual(init.capabilities.experimental, { "claude/channel": {} });
    assert.match(init.instructions, /phone_reply/);
    s.send({ id: 9, method: "tools/list" });
    await s.until(() => s.stdout.some((m) => m.id === 9));
    const tools = s.stdout.find((m) => m.id === 9).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ["call_me", "phone_reply", "call_me_settings"]);
    assert.ok(!("realtime" in tools[0].inputSchema.properties) && !("stay_on_line" in tools[0].inputSchema.properties));

    const claim = s.twilio.find((r) => r.form.VoiceUrl);
    assert.equal(claim.form.VoiceUrl, `${BASE}/incoming`);
    assert.match(claim.form.VoiceFallbackUrl, /^https:\/\/twimlets\.com\/echo\?Twiml=/);

    // Security: unsigned → 403, strangers → <Reject/>.
    assert.equal((await webhook("/incoming", { From: ME }, { sign: false })).status, 403);
    assert.match((await webhook("/incoming", { From: "+15550001111", CallSid: "CAx" })).body, /<Reject\/>/);

    const twiml = (await webhook("/incoming", { From: ME, To: "+17250000000", CallSid: "CAin" })).body;
    assert.match(twiml, /<ConversationRelay url="ws:\/\/127\.0\.0\.1:\d+\/relay\/[a-f0-9]{32}" language="pl-PL" welcomeGreeting="Cześć, tu Claude\. Słucham\."/);
    assert.match(twiml, /ttsProvider="Amazon" voice="Ola-Neural"/);
    const ws = await relay(twiml, "CAin");
    ws.prompt("Odpal testy");
    await s.until(() => s.events().length === 1);
    const ev = s.events()[0];
    assert.match(ev.content, /^Odpal testy/);
    assert.deepEqual(
      [ev.meta.live, ev.meta.realtime, ev.meta.direction, ev.meta.from, ev.meta.machine, ev.meta.call_sid, ev.meta.saved_messages],
      ["true", "true", "inbound", ME, "laptop", "CAin", "0"],
    );

    // While Claude works: a filler ("Chwileczkę.", "Sekundka." …) after 2.5 s.
    await until(() => ws.said.length === 1, 4000);
    assert.match(ws.said[0].token, /Chwileczkę|Sekundka|Moment|Już patrzę|chwilka/);
    assert.match(await s.tool("phone_reply", { call_sid: "CAin", message: "Testy przeszły." })(), /^Said/);
    await until(() => ws.said.some((m) => m.token === "Testy przeszły."));
    assert.match(await s.tool("phone_reply", { call_sid: "CAin", message: "Pa!", end_call: true })(), /hangs up/);
    assert.match(await s.tool("phone_reply", { call_sid: "CAnone", message: "x" })(), /ERROR.*No call CAnone/);

    // A second phone on the allow-list gets through too.
    assert.match((await webhook("/incoming", { From: "+48600000001", CallSid: "CAin2" })).body, /<ConversationRelay/);

    // Unsupported language fails before dialing.
    assert.match(await s.tool("call_me", { message: "x", language: "de" })(), /ERROR/);

    // Closing the session hands the number back to the offline message.
    const exited = new Promise((r) => s.proc.on("exit", r));
    s.proc.stdin.end();
    await exited;
    const release = s.twilio.filter((r) => r.form.VoiceUrl).at(-1);
    assert.match(release.form.VoiceUrl, /twimlets\.com\/echo/);
    assert.equal(release.form.VoiceMethod, "GET");
  } finally {
    s.proc.kill();
  }
});

test("outbound conversation: the message is said on pick-up, the user's words reach the session, English uses no Polish voice", async () => {
  const s = await ready({ CALL_ME_RELAY_TTS: "Amazon", CALL_ME_RELAY_VOICE: "Ola-Neural" });
  try {
    const result = s.tool("call_me", { message: "Testy padły. Naprawić?", retries: 0 });
    const ws = await pickUp(s, 1);
    assert.match(await result(), /picked up and is hearing your message \(call CA1\)/);
    const form = s.created()[0].form;
    assert.match(form.Twiml, /welcomeGreeting="Testy padły\. Naprawić\?"[^>]*ttsProvider="Amazon" voice="Ola-Neural"/);
    assert.equal(form.AsyncAmd, "true");
    ws.prompt("Tak, napraw");
    await s.until(() => s.events().length === 1);
    assert.equal(s.events()[0].meta.call_sid, "CA1");
    s.tool("phone_reply", { call_sid: "CA1", message: "Naprawiam." });
    await until(() => ws.said.some((m) => m.token === "Naprawiam."));

    // The user hangs up: the session gets the transcript.
    ws.close();
    await s.until(() => s.events().length === 2);
    assert.match(s.events()[1].content, /has ended \(the caller hung up\)[\s\S]*Caller: Tak, napraw/);

    // English call: English recognition, no Polish voice.
    s.tool("call_me", { message: "Done.", language: "en-US", retries: 0 });
    await s.until(() => s.created().length === 2);
    const en = s.created()[1].form.Twiml;
    assert.match(en, /language="en-US"/);
    assert.doesNotMatch(en, /Ola-Neural/);
  } finally {
    s.proc.kill();
  }
});

test("retries unanswered calls, hangs up on voicemail without telling the session what it heard, holds calls until the user calls back", async () => {
  const s = await ready({ FAKE_CALLS: "no-answer;in-progress", CALL_ME_RETRY_DELAY: "0.1" });
  try {
    // 1st attempt rings out, 2nd reaches voicemail (= rejected): no 3rd attempt, voicemail hung up.
    const r1 = s.tool("call_me", { message: "Build failed." });
    await pickUp(s, 2, "machine_start", async (ws) => {
      ws.prompt("Leave a message after the tone");
      await wait(200);
    });
    assert.match(await r1(), /REJECTED/);
    assert.equal(s.created().length, 2);
    assert.ok(s.twilio.some((r) => r.path.endsWith("/Calls/CA2.json") && r.form.Status === "completed"));
    assert.equal(s.events().length, 0, "the voicemail greeting must not reach the session");

    // Do-not-disturb: the next call is only saved, unless forced.
    assert.match(await s.tool("call_me", { message: "Second thing.", language: "en-US" })(), /Not called/);
    assert.equal(s.created().length, 2);

    // The user calls back: the saved messages go to the session with the first sentence, not read aloud.
    const twiml = (await webhook("/incoming", { From: ME, CallSid: "CAin" })).body;
    assert.doesNotMatch(twiml, /Build failed/);
    const ws = await relay(twiml, "CAin");
    ws.prompt("Napraw build");
    await s.until(() => s.events().length === 1);
    const ev = s.events()[0];
    assert.match(ev.content, /^Napraw build[\s\S]*Saved messages[^\n]*NOT heard[\s\S]*Build failed\.[\s\S]*Second thing\./);
    assert.equal(ev.meta.saved_messages, "2");
    ws.close();

    // Calling back ended do-not-disturb: a one-way notice goes through, plays, and hangs up; the session hears nothing.
    const r2 = s.tool("call_me", { message: "Fixed.", wait_for_reply: false });
    const ws3 = await pickUp(s, 3);
    ws3.prompt("Dzięki");
    assert.match(await r2(), /message was delivered/);
    assert.match(s.created()[2].form.Twiml, /welcomeGreeting="Fixed\."/);
    assert.ok(s.twilio.some((r) => r.path.endsWith("/Calls/CA3.json") && r.form.Status === "completed"));
    await wait(200);
    assert.equal(s.events().length, 2); // the transcript of the callback only
  } finally {
    s.proc.kill();
  }
});

test("backup phones are tried in order when the main one doesn't pick up, and may call in", async () => {
  const s = await ready({ FAKE_CALLS: "no-answer;in-progress", CALL_ME_BACKUP_NUMBERS: "+48500000007,+48500000008", CALL_ME_ALLOWED_CALLERS: "" });
  try {
    const r = s.tool("call_me", { message: "Done.", wait_for_reply: false });
    await pickUp(s, 2);
    assert.match(await r(), /delivered\. \(call CA2, to \+48500000007, a backup phone\)/);
    assert.deepEqual(s.created().map((c) => c.form.To), [ME, "+48500000007"]);
    assert.match((await webhook("/incoming", { From: "+48500000008", CallSid: "CAb" })).body, /<ConversationRelay/);
    assert.match((await webhook("/incoming", { From: "+48500000009", CallSid: "CAx" })).body, /<Reject/);
  } finally {
    s.proc.kill();
  }
});

test("a session not started with claude-phone can still deliver a message, but says it couldn't listen", async () => {
  const s = await ready({ CALL_ME_INBOUND: "" });
  try {
    const r = s.tool("call_me", { message: "Gotowe.", retries: 0 });
    await pickUp(s, 1);
    assert.match(await r(), /delivered.*claude-phone/);
  } finally {
    s.proc.kill();
  }
});

test("call_me_settings: each session/project picks its own numbers and answers its own number", async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-cfg-"));
  // Numbers come from the machine config file here (environment variables would override project settings).
  fs.writeFileSync(path.join(cfgDir, "config.env"), `TWILIO_FROM_NUMBER=+17250000000\nCALL_ME_TO_NUMBER=${ME}\n`);
  const s = await ready({ CALL_ME_CONFIG: path.join(cfgDir, "config.env"), CALL_ME_ALLOWED_CALLERS: "", TWILIO_FROM_NUMBER: "", CALL_ME_TO_NUMBER: "" });
  const settings = async (args) => {
    const t = await s.tool("call_me_settings", args)();
    return { text: t, error: t.startsWith("ERROR") };
  };
  const voiceUrls = () => s.twilio.filter((r) => r.form.VoiceUrl);
  try {
    assert.match(voiceUrls()[0].path, /PN1\.json$/);
    assert.match((await settings({})).text, /from_number[^:]*: \+17250000000[\s\S]*answer_calls: yes, answering \+17250000000/);
    assert.match((await settings({ from_number: "+17259999999" })).text, /not a number on this Twilio account/);
    assert.ok((await settings({ to_number: "12345" })).error);

    const r = await settings({ from_number: "+1 725 000 0002", to_number: "+48600000009", allowed_callers: ["+48600000010"] });
    assert.match(r.text, /Stopped answering \+17250000000[\s\S]*Now answering calls to \+17250000002/);
    const [release, claim] = voiceUrls().slice(-2);
    assert.match(release.path, /PN1\.json$/);
    assert.match(release.form.VoiceUrl, /twimlets/);
    assert.match(claim.path, /PN2\.json$/);
    const projectFiles = fs.readdirSync(path.join(cfgDir, "projects"));
    assert.equal(projectFiles.length, 1);
    const saved = fs.readFileSync(path.join(cfgDir, "projects", projectFiles[0]), "utf8");
    assert.match(saved, /TWILIO_FROM_NUMBER="\+17250000002"/);
    assert.match(saved, /CALL_ME_TO_NUMBER="\+48600000009"/);
    assert.equal(fs.statSync(path.join(cfgDir, "projects", projectFiles[0])).mode & 0o777, 0o600);

    assert.match((await webhook("/incoming", { From: "+48600000010", CallSid: "CAa" })).body, /<ConversationRelay/);
    assert.match((await webhook("/incoming", { From: "+48600000009", CallSid: "CAb" })).body, /<ConversationRelay/);
    assert.match((await webhook("/incoming", { From: ME, CallSid: "CAc" })).body, /<Reject\/>/);

    s.tool("call_me", { message: "hi", wait_for_reply: false, retries: 0 });
    await s.until(() => s.created().length === 1);
    assert.equal(s.created()[0].form.From, "+17250000002");
    assert.equal(s.created()[0].form.To, "+48600000009");

    const off = await settings({ answer_calls: false, scope: "session", list_numbers: true });
    assert.match(off.text, /answer_calls: no[\s\S]*Stopped answering \+17250000002/);
    assert.match(off.text, /\+17250000002: free \(plays the offline message\)/);
  } finally {
    s.proc.kill();
  }
});

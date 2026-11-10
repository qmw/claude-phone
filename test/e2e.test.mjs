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

test("inbound calls reach the session as channel events; outbound honours per-call language", async () => {
  const s = startServer();
  try {
    s.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await s.until(() => s.stdout.some((m) => m.id === 1));
    const init = s.stdout.find((m) => m.id === 1).result;
    assert.deepEqual(init.capabilities.experimental, { "claude/channel": {} });
    assert.match(init.instructions, /call_me/);

    // Taking over the number.
    s.send({ method: "notifications/initialized" });
    await s.until(() => s.twilio.some((r) => r.form.VoiceUrl));
    const claim = s.twilio.find((r) => r.form.VoiceUrl);
    assert.equal(claim.form.VoiceUrl, `${BASE}/incoming`);
    assert.match(claim.form.VoiceFallbackUrl, /^https:\/\/twimlets\.com\/echo\?Twiml=/);

    // Security: unsigned → 403, strangers → <Reject/>.
    assert.equal((await webhook("/incoming", { From: ME }, { sign: false })).status, 403);
    assert.match((await webhook("/incoming", { From: "+15550001111", CallSid: "CAx" })).body, /<Reject\/>/);

    // The user calls and speaks.
    const answer = await webhook("/incoming", { From: ME, CallSid: "CAin" });
    assert.match(answer.body, /<Gather input="speech" action="http:\/\/127\.0\.0\.1:\d+\/incoming\/gather"[^>]*language="pl-PL"/);
    const done = await webhook("/incoming/gather", { From: ME, CallSid: "CAin", SpeechResult: "Odpal testy", Confidence: "0.93" });
    assert.match(done.body, /<Redirect method="POST">http:\/\/127\.0\.0\.1:\d+\/live\/wait<\/Redirect>/);
    await s.until(() => s.stdout.some((m) => m.method === "notifications/claude/channel"));
    const ev = s.stdout.find((m) => m.method === "notifications/claude/channel").params;
    assert.equal(ev.content, "Odpal testy");
    assert.deepEqual(ev.meta, {
      live: "true", from: ME, to: "+17250000000", machine: "laptop", language: "pl-PL", confidence: "0.93", call_sid: "CAin", saved_messages: "0", saved_messages_heard: "0",
    });

    // A second phone on the allow-list gets through too.
    assert.match((await webhook("/incoming", { From: "+48600000001", CallSid: "CAin2" })).body, /<Gather/);

    // Outbound call in English although the default is Polish.
    s.send({ id: 2, method: "tools/call", params: { name: "call_me", arguments: { message: "Tests passed.", language: "en-US" } } });
    await s.until(() => s.twilio.some((r) => r.form.Twiml));
    const twiml = s.twilio.find((r) => r.form.Twiml).form.Twiml;
    assert.match(twiml, /voice="Polly\.Joanna" language="en-US">Hi, this is Claude\./);
    const action = twiml.match(/action="([^"]+)"/)[1];
    const ack = await webhook(new URL(action).pathname, { SpeechResult: "great", Confidence: "0.9" });
    assert.match(ack.body, /Got it, thanks/);
    await s.until(() => s.stdout.some((m) => m.id === 2));
    assert.match(s.stdout.find((m) => m.id === 2).result.content[0].text, /User replied by voice: "great"/);

    // Unsupported language fails before dialing.
    s.send({ id: 3, method: "tools/call", params: { name: "call_me", arguments: { message: "x", language: "de" } } });
    await s.until(() => s.stdout.some((m) => m.id === 3));
    assert.equal(s.stdout.find((m) => m.id === 3).result.isError, true);

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

test("retries unanswered calls, stops on rejection, holds calls until the user calls back", async () => {
  const s = startServer({
    FAKE_CALLS: "no-answer;in-progress:machine_start;completed:human:12",
    CALL_ME_RETRY_DELAY: "0.1",
    CALL_ME_READ_SAVED: "1",
  });
  const result = async (id) => {
    await s.until(() => s.stdout.some((m) => m.id === id), 15000);
    return s.stdout.find((m) => m.id === id).result.content[0].text;
  };
  const created = () => s.twilio.filter((r) => r.method === "POST" && r.path.endsWith("/Calls.json"));
  try {
    s.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    s.send({ method: "notifications/initialized" });
    await s.until(() => s.twilio.some((r) => r.form.VoiceUrl));

    // 1st attempt rings out, 2nd hits voicemail (= rejected): no 3rd attempt, voicemail hung up.
    s.send({ id: 2, method: "tools/call", params: { name: "call_me", arguments: { message: "Build failed.", wait_for_reply: false } } });
    assert.match(await result(2), /REJECTED/);
    assert.equal(created().length, 2);
    assert.equal(created()[0].form.MachineDetection, "Enable");
    assert.ok(s.twilio.some((r) => r.path.endsWith("/Calls/CA2.json") && r.form.Status === "completed"));

    // Do-not-disturb: the next call is only saved, unless forced.
    s.send({ id: 3, method: "tools/call", params: { name: "call_me", arguments: { message: "Second thing.", language: "en-US" } } });
    assert.match(await result(3), /Not called/);
    assert.equal(created().length, 2);

    // The user calls back: both saved messages are read, each in its language, then the session is notified.
    const answer = await webhook("/incoming", { From: ME, CallSid: "CAin" });
    assert.match(answer.body, /Zapisane wiadomości: 2\./);
    assert.match(answer.body, /language="pl-PL">Z projektu [^<]+: Build failed\./);
    assert.match(answer.body, /voice="Polly\.Joanna" language="en-US">From [^<]+: Second thing\./);
    assert.match(answer.body, /actionOnEmptyResult="true"/);
    await webhook("/incoming/gather", { From: ME, CallSid: "CAin", SpeechResult: "Napraw build" });
    await s.until(() => s.stdout.some((m) => m.method === "notifications/claude/channel"));
    const ev = s.stdout.find((m) => m.method === "notifications/claude/channel").params;
    assert.match(ev.content, /^Napraw build\n\nBefore speaking, the user heard/);
    assert.match(ev.content, /Build failed\.[\s\S]*Second thing\./);
    assert.equal(ev.meta.saved_messages_heard, "2");

    // Calling back ended do-not-disturb: calls go through again.
    s.send({ id: 4, method: "tools/call", params: { name: "call_me", arguments: { message: "Fixed.", wait_for_reply: false } } });
    assert.match(await result(4), /message was delivered/);
    assert.equal(created().length, 3);

    // A second callback has nothing saved any more.
    assert.doesNotMatch((await webhook("/incoming", { From: ME, CallSid: "CAin2" })).body, /Zapisane/);
  } finally {
    s.proc.kill();
  }
});

test("live conversation: inbound and outbound calls stay open for phone_reply", async () => {
  const s = startServer({ CALL_ME_LIVE_HOLD: "60" });
  const result = async (id) => {
    await s.until(() => s.stdout.some((m) => m.id === id), 10000);
    return s.stdout.find((m) => m.id === id).result.content[0].text;
  };
  try {
    s.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await s.until(() => s.stdout.some((m) => m.id === 1));
    s.send({ id: 9, method: "tools/list" });
    await s.until(() => s.stdout.some((m) => m.id === 9));
    assert.deepEqual(s.stdout.find((m) => m.id === 9).result.tools.map((t) => t.name), ["call_me", "phone_reply", "call_me_settings"]);
    s.send({ method: "notifications/initialized" });
    await s.until(() => s.twilio.some((r) => r.form.VoiceUrl));

    // Inbound: the user speaks and is put on hold.
    await webhook("/incoming", { From: ME, CallSid: "CAlive" });
    const hold = await webhook("/incoming/gather", { From: ME, CallSid: "CAlive", SpeechResult: "Jaka pogoda?" });
    assert.match(hold.body, /<Pause length="2"\/><Redirect/);
    assert.doesNotMatch(hold.body, /<Say/);
    // Nothing to say yet: keep holding.
    assert.match((await webhook("/live/wait", { CallSid: "CAlive" })).body, /<Redirect/);

    // Claude answers; Twilio's next poll speaks it and listens.
    s.send({ id: 2, method: "tools/call", params: { name: "phone_reply", arguments: { call_sid: "CAlive", message: "Słonecznie. Coś jeszcze?" } } });
    let turn;
    for (let i = 0; i < 20 && !/Gather/.test((turn = (await webhook("/live/wait", { CallSid: "CAlive" })).body)); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(turn, /<Gather input="speech dtmf" action="http:\/\/127\.0\.0\.1:\d+\/live\/gather"[^>]*><\/Gather>/);
    assert.match(turn, /<Say[^>]*>Słonecznie\. Coś jeszcze\?<\/Say><Gather/);
    assert.match((await webhook("/live/gather", { CallSid: "CAlive", SpeechResult: "Nie, dzięki" })).body, /<Redirect/);
    assert.match(await result(2), /User said: "Nie, dzięki"/);

    // Claude ends the call.
    s.send({ id: 3, method: "tools/call", params: { name: "phone_reply", arguments: { call_sid: "CAlive", message: "Pa!", end_call: true } } });
    let bye;
    for (let i = 0; i < 20 && !/Hangup/.test((bye = (await webhook("/live/wait", { CallSid: "CAlive" })).body)); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(bye, /Pa!<\/Say><Hangup\/>/);
    assert.match(await result(3), /Said it and hung up/);
    s.send({ id: 4, method: "tools/call", params: { name: "phone_reply", arguments: { call_sid: "CAlive", message: "x" } } });
    assert.match(await result(4), /No live call/);

    // Outbound with stay_on_line: after the reply the call is held instead of hung up.
    s.send({ id: 5, method: "tools/call", params: { name: "call_me", arguments: { message: "Testy padły.", stay_on_line: true } } });
    await s.until(() => s.twilio.some((r) => r.form.Twiml));
    const action = s.twilio.find((r) => r.form.Twiml).form.Twiml.match(/action="([^"]+)"/)[1];
    assert.match((await webhook(new URL(action).pathname, { CallSid: "CA1", SpeechResult: "Które?" })).body, /<Redirect/);
    assert.match(await result(5), /User replied by voice: "Które\?".*still on the line.*phone_reply \(call_sid "CA1"\)/);

    // Silence after Claude's line ends the call.
    s.send({ id: 6, method: "tools/call", params: { name: "phone_reply", arguments: { call_sid: "CA1", message: "Dwa testy e2e." } } });
    for (let i = 0; i < 20 && !/Gather/.test((await webhook("/live/wait", { CallSid: "CA1" })).body); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match((await webhook("/live/gather", { CallSid: "CA1" })).body, /Nie otrzymałem odpowiedzi.*<Hangup\/>/);
    assert.match(await result(6), /said nothing/);
  } finally {
    s.proc.kill();
  }
});

test("call_me_settings: each session/project picks its own numbers and answers its own number", async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-cfg-"));
  // Numbers come from the machine config file here (environment variables would override project settings).
  fs.writeFileSync(path.join(cfgDir, "config.env"), `TWILIO_FROM_NUMBER=+17250000000\nCALL_ME_TO_NUMBER=${ME}\n`);
  const s = startServer({ CALL_ME_CONFIG: path.join(cfgDir, "config.env"), CALL_ME_ALLOWED_CALLERS: "", TWILIO_FROM_NUMBER: "", CALL_ME_TO_NUMBER: "" });
  let id = 10;
  const settings = async (args) => {
    const n = ++id;
    s.send({ id: n, method: "tools/call", params: { name: "call_me_settings", arguments: args } });
    await s.until(() => s.stdout.some((m) => m.id === n), 10000);
    const r = s.stdout.find((m) => m.id === n).result;
    return { text: r.content[0].text, error: !!r.isError };
  };
  const voiceUrls = () => s.twilio.filter((r) => r.form.VoiceUrl);
  try {
    s.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await s.until(() => s.stdout.some((m) => m.id === 1));
    s.send({ method: "notifications/initialized" });
    await s.until(() => voiceUrls().length === 1);
    assert.match(voiceUrls()[0].path, /PN1\.json$/);

    // Show current settings.
    assert.match((await settings({})).text, /from_number[^:]*: \+17250000000[\s\S]*answer_calls: yes, answering \+17250000000/);

    // Unknown Twilio number and malformed numbers are refused.
    assert.match((await settings({ from_number: "+17259999999" })).text, /not a number on this Twilio account/);
    assert.ok((await settings({ to_number: "12345" })).error);

    // Switch this project to the second number: release PN1, take over PN2; save to the project file.
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

    // The new caller list applies at once: the new to_number and allowed caller get through, the old phone does not.
    assert.match((await webhook("/incoming", { From: "+48600000010", CallSid: "CAa" })).body, /<Gather/);
    assert.match((await webhook("/incoming", { From: "+48600000009", CallSid: "CAb" })).body, /<Gather/);
    assert.match((await webhook("/incoming", { From: ME, CallSid: "CAc" })).body, /<Reject\/>/);

    // Outbound calls come from the session's number.
    s.send({ id: 99, method: "tools/call", params: { name: "call_me", arguments: { message: "hi", wait_for_reply: false, retries: 0 } } });
    await s.until(() => s.twilio.some((r) => r.form.Twiml));
    const call = s.twilio.find((r) => r.form.Twiml).form;
    assert.equal(call.From, "+17250000002");
    assert.equal(call.To, "+48600000009");

    // Session-only change to stop answering; list numbers.
    const off = await settings({ answer_calls: false, scope: "session", list_numbers: true });
    assert.match(off.text, /answer_calls: no[\s\S]*Stopped answering \+17250000002/);
    assert.match(off.text, /\+17250000002: free \(plays the offline message\)/);
  } finally {
    s.proc.kill();
  }
});

test("calls that wait for a reply detect voicemail in the background and hang up on it", async () => {
  const s = startServer();
  const created = () => s.twilio.filter((r) => r.method === "POST" && r.path.endsWith("/Calls.json"));
  try {
    s.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    s.send({ method: "notifications/initialized" });
    await s.until(() => s.twilio.some((r) => r.form.VoiceUrl));

    s.send({ id: 2, method: "tools/call", params: { name: "call_me", arguments: { message: "Hej.", retries: 0 } } });
    await s.until(() => created().length === 1);
    const form = created()[0].form;
    assert.equal(form.MachineDetection, "Enable");
    assert.equal(form.AsyncAmd, "true");
    const amdPath = form.AsyncAmdStatusCallback.slice(BASE.length);
    assert.match(amdPath, /^\/amd\/[a-f0-9]{32}$/);

    // Unsigned callbacks are refused; a signed "machine" verdict hangs up and counts as a rejection.
    assert.equal((await webhook(amdPath, { CallSid: "CA1", AnsweredBy: "machine_start" }, { sign: false })).status, 403);
    assert.equal((await webhook(amdPath, { CallSid: "CA1", AnsweredBy: "machine_start" })).status, 200);
    await s.until(() => s.stdout.some((m) => m.id === 2), 10000);
    assert.match(s.stdout.find((m) => m.id === 2).result.content[0].text, /REJECTED/);
    assert.ok(s.twilio.some((r) => r.path.endsWith("/Calls/CA1.json") && r.form.Status === "completed"));
  } finally {
    s.proc.kill();
  }
});

test("by default saved messages are not read on the phone, only handed to the session", async () => {
  const s = startServer({ FAKE_CALLS: "in-progress:machine_start" });
  try {
    s.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    s.send({ method: "notifications/initialized" });
    await s.until(() => s.twilio.some((r) => r.form.VoiceUrl));
    s.send({ id: 2, method: "tools/call", params: { name: "call_me", arguments: { message: "Build failed.", wait_for_reply: false } } });
    await s.until(() => s.stdout.some((m) => m.id === 2), 10000);
    assert.match(s.stdout.find((m) => m.id === 2).result.content[0].text, /REJECTED/);

    const answer = await webhook("/incoming", { From: ME, CallSid: "CAin" });
    assert.doesNotMatch(answer.body, /Zapisane|Build failed/);
    assert.match(answer.body, /actionOnEmptyResult="true"/);
    await webhook("/incoming/gather", { From: ME, CallSid: "CAin" });
    await s.until(() => s.stdout.some((m) => m.method === "notifications/claude/channel"));
    const ev = s.stdout.find((m) => m.method === "notifications/claude/channel").params;
    assert.match(ev.content, /^\(the user said nothing\)\n\nSaved messages [^\n]*NOT heard[\s\S]*Build failed\./);
    assert.equal(ev.meta.saved_messages, "1");
    assert.equal(ev.meta.saved_messages_heard, "0");
  } finally {
    s.proc.kill();
  }
});

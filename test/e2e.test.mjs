// Drives the real MCP server over stdio with a fake Twilio API and signed webhooks on localhost.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { twilioSignature } from "../plugins/call-me/server/lib.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const TOKEN = "tok";
const ME = "+48500000001";
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

function startServer() {
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
      CALL_ME_PUBLIC_URL: BASE,
      CALL_ME_PORT: String(PORT),
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
    assert.match(done.body, /Przyjąłem, przekazuję/);
    await s.until(() => s.stdout.some((m) => m.method === "notifications/claude/channel"));
    const ev = s.stdout.find((m) => m.method === "notifications/claude/channel").params;
    assert.equal(ev.content, "Odpal testy");
    assert.deepEqual(ev.meta, { from: ME, language: "pl-PL", confidence: "0.93", call_sid: "CAin" });

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

// The realtime bridge against a fake OpenAI Live server and a fake Twilio media stream.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { acceptUpgrade, connect } from "../plugins/call-me/server/ws.mjs";
import { RealtimeCall, voiceInstructions } from "../plugins/call-me/server/realtime.mjs";

const until = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("ws: text round trip, large and masked frames", async () => {
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    const c = acceptUpgrade(req, socket, head);
    c.on("message", (m) => c.send(`echo:${m}`));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = await connect(`ws://127.0.0.1:${server.address().port}/x`);
  const got = [];
  c.on("message", (m) => got.push(m));
  const big = "x".repeat(70000);
  c.send("hi");
  c.send(big);
  await until(() => got.length === 2);
  assert.equal(got[0], "echo:hi");
  assert.equal(got[1], `echo:${big}`);
  c.close();
  server.close();
});

test("realtime call: audio both ways, hand-off to Claude, answer spoken, hang-up", async () => {
  const fromClient = [];
  let voice;
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.headers.authorization, "Bearer sk-test");
    voice = acceptUpgrade(req, socket, head);
    voice.on("message", (m) => {
      const ev = JSON.parse(m);
      fromClient.push(ev);
      if (ev.type === "session.start") voice.send({ type: "session.started", session: { id: "s1" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const twilioOut = [];
  const tw = Object.assign(new EventEmitter(), { send: (m) => twilioOut.push(m), close() {} });
  const events = [];
  const rest = [];
  const rt = new RealtimeCall({
    cfg: { OPENAI_API_KEY: "sk-test", CALL_ME_REALTIME_URL: `ws://127.0.0.1:${server.address().port}` },
    language: "pl-PL",
    opening: "Cześć, test.",
    project: "demo",
    notify: (method, params) => events.push(params),
    log: () => {},
    twilio: async (...a) => rest.push(a),
  });
  rt.attachTwilio(tw);
  tw.emit("message", JSON.stringify({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } }));
  await until(() => rt.ready);

  const start = fromClient.find((e) => e.type === "session.start").session;
  assert.equal(start.model, "gpt-live-1");
  assert.deepEqual(start.audio.format, { type: "audio/pcmu", rate: 8000 });
  assert.deepEqual(start.delegation, { type: "client" });
  assert.match(start.instructions, /Always speak Polish/);
  assert.match(start.instructions, /Cześć, test\./);

  // Caller audio goes to the voice unchanged; the voice's audio goes to Twilio.
  tw.emit("message", JSON.stringify({ event: "media", media: { payload: "AAAA" } }));
  await until(() => fromClient.some((e) => e.type === "session.input_audio.append"));
  assert.equal(fromClient.find((e) => e.type === "session.input_audio.append").audio, "AAAA");
  voice.send({ type: "session.output_audio.delta", delta: "/w==" });
  await until(() => twilioOut.length);
  assert.deepEqual(twilioOut[0], { event: "media", streamSid: "MZ1", media: { payload: "/w==" } });

  // The caller asks something; the voice hands it off; the session gets the caller's words.
  voice.send({ type: "session.input_transcript.delta", delta: "Jaki jest status builda?" });
  voice.send({ type: "session.delegation.created", delegation: { id: "d1" } });
  await until(() => events.length, 3000);
  assert.match(events[0].content, /^Jaki jest status builda\?/);
  assert.equal(events[0].meta.realtime, "true");
  assert.equal(events[0].meta.call_sid, "CA1");

  // Claude answers: the voice gets it as commentary for that delegation; exact lines as instructions.
  assert.match(rt.say("Build przeszedł."), /Sent to the voice/);
  rt.say("Nie podawaj PIN-u.", { exact: true });
  await until(() => fromClient.filter((e) => /commentary|instructions/.test(e.type)).length === 2);
  assert.deepEqual(
    fromClient.find((e) => e.type === "session.commentary.append"),
    { type: "session.commentary.append", content: "Build przeszedł.", delegation_id: "d1" },
  );
  assert.match(fromClient.find((e) => e.type === "session.instructions.append").content, /word for word: Nie podawaj PIN-u\./);

  // Hanging up ends the Twilio call and the voice session; Claude ending it gets no extra event.
  await rt.hangup();
  assert.deepEqual(rest[0].slice(1), ["POST", "Calls/CA1.json", { Status: "completed" }]);
  await until(() => fromClient.some((e) => e.type === "session.close"));
  assert.equal(events.length, 1);
  server.close();
});

test("realtime call: when the caller hangs up, the session gets the transcript", async () => {
  const events = [];
  const tw = Object.assign(new EventEmitter(), { send() {}, close() {} });
  const rt = new RealtimeCall({ cfg: {}, language: "en-US", opening: "Hi", project: "p", notify: (m, p) => events.push(p), log: () => {} });
  rt.attachTwilio(tw);
  rt.callSid = "CA2";
  rt.add("caller", "Thanks, bye");
  tw.emit("message", JSON.stringify({ event: "stop" }));
  assert.match(events[0].content, /has ended \(the caller hung up\)[\s\S]*Caller: Thanks, bye/);
  assert.equal(events[0].meta.live, "false");
});

test("voice instructions keep the voice from inventing and from taking secrets", () => {
  const t = voiceInstructions({ language: "en-US", opening: "Build done.", project: "x" });
  assert.match(t, /<\|SpawnThinking\|>/);
  assert.match(t, /Never accept passwords, PINs/);
  assert.match(t, /never invent results/);
});

test("relay: TwiML asks for Polish, smart interruptions and our socket", async () => {
  const { relayTwiml } = await import("../plugins/call-me/server/relay.mjs");
  const x = relayTwiml({ url: "wss://h/relay/abc", language: "pl-PL", greeting: "Cześć & witaj", cfg: { CALL_ME_RELAY_VOICE: "pl-PL-Chirp3-HD-Aoede", CALL_ME_RELAY_TTS: "Google" } });
  assert.match(x, /<Connect><ConversationRelay url="wss:\/\/h\/relay\/abc" language="pl-PL" welcomeGreeting="Cześć &amp; witaj"/);
  assert.match(x, /interruptSensitivity="low" ignoreBackchannel="true" transcriptionProvider="Deepgram" speechModel="nova-3-general"/);
  assert.match(x, /ttsProvider="Google" voice="pl-PL-Chirp3-HD-Aoede"/);
  assert.doesNotMatch(relayTwiml({ url: "wss://h", language: "pl-PL", greeting: "x", cfg: {} }), /ttsProvider|voice=/);
});

test("relay: caller's sentence reaches Claude, filler while waiting, answer spoken, hang-up", async () => {
  const { RelayCall } = await import("../plugins/call-me/server/relay.mjs");
  const out = [], events = [], rest = [];
  const ws = Object.assign(new EventEmitter(), { send: (m) => out.push(m), close() {} });
  const rc = new RelayCall({ cfg: {}, language: "pl-PL", opening: "Cześć", notify: (m, p) => events.push(p), log: () => {}, twilio: async (...a) => rest.push(a) });
  rc.attach(ws);
  ws.emit("message", JSON.stringify({ type: "setup", callSid: "CA9" }));
  assert.ok(rc.ready);
  ws.emit("message", JSON.stringify({ type: "prompt", voicePrompt: "Jaka jest wersja", last: false }));
  assert.equal(events.length, 0);
  ws.emit("message", JSON.stringify({ type: "prompt", voicePrompt: "Jaka jest wersja pluginu?", last: true }));
  assert.match(events[0].content, /^Jaka jest wersja pluginu\?/);
  assert.equal(events[0].meta.call_sid, "CA9");
  await until(() => out.length === 1, 3000); // filler after 1.5 s
  assert.match(out[0].token, /chwileczkę|sprawdzam/i);
  assert.match(rc.say("Wersja zero osiem."), /^Said/);
  assert.deepEqual(out[1], { type: "text", token: "Wersja zero osiem.", last: true, lang: "pl-PL" });
  await rc.hangup();
  assert.equal(out[2].type, "end");
  assert.deepEqual(rest[0].slice(1), ["POST", "Calls/CA9.json", { Status: "completed" }]);
  assert.equal(events.length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseEnv, loadConfig, buildCallTwiml, buildInboundTwiml, twilioSignature, validSignature, xmlEscape,
  normalizeLanguage, speechProfile, offlineUrl, samePhone,
  classifyOutcome, saveForCallback, takeSaved, dndActive, readState,
} from "../plugins/call-me/server/lib.mjs";

test("parseEnv handles comments, quotes, export", () => {
  const env = parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\'\n\nbad line\n');
  assert.deepEqual(env, { A: "1", B: "two words", C: "x" });
});

test("loadConfig: env overrides file and reports missing keys", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cm-")), "c.env");
  fs.writeFileSync(f, "TWILIO_ACCOUNT_SID=AC1\nTWILIO_AUTH_TOKEN=file\n");
  const { cfg, missing } = loadConfig({ TWILIO_AUTH_TOKEN: "env", PATH: "/bin" }, f);
  assert.equal(cfg.TWILIO_AUTH_TOKEN, "env");
  assert.equal(cfg.PATH, undefined);
  assert.deepEqual(missing, ["TWILIO_FROM_NUMBER", "CALL_ME_TO_NUMBER"]);
});

test("twiml escapes message and includes gather only when replying", () => {
  const oneWay = buildCallTwiml("a < b & c", speechProfile({}), null);
  assert.match(oneWay, /a &lt; b &amp; c/);
  assert.doesNotMatch(oneWay, /Gather/);
  const twoWay = buildCallTwiml("hi", speechProfile({ CALL_ME_LANGUAGE: "pl-PL" }), "https://x/gather/1?a=1&b=2");
  assert.match(twoWay, /<Gather [^>]*action="https:\/\/x\/gather\/1\?a=1&amp;b=2"/);
  assert.match(twoWay, /language="pl-PL"/);
  assert.match(twoWay, /speechTimeout="3"/);
  assert.match(buildCallTwiml("hi", speechProfile({ CALL_ME_SPEECH_TIMEOUT: "5" }), "https://x/g"), /speechTimeout="5"/);
  assert.match(twoWay, /Nie dosłyszałem/);
  assert.doesNotMatch(twoWay, /didn't catch/);
});

test("normalizeLanguage accepts short forms and rejects unsupported", () => {
  assert.equal(normalizeLanguage("pl"), "pl-PL");
  assert.equal(normalizeLanguage("EN-us"), "en-US");
  assert.equal(normalizeLanguage("Polish"), "pl-PL");
  assert.equal(normalizeLanguage(undefined), null);
  assert.throws(() => normalizeLanguage("de-DE"), /Unsupported language/);
});

test("speechProfile: per-call language wins; config overrides apply only to the default language", () => {
  const cfg = { CALL_ME_LANGUAGE: "pl-PL", CALL_ME_VOICE: "Polly.Custom", CALL_ME_INTRO: "Siema." };
  const pl = speechProfile(cfg);
  assert.deepEqual([pl.language, pl.voice, pl.intro], ["pl-PL", "Polly.Custom", "Siema."]);
  const en = speechProfile(cfg, "en");
  assert.deepEqual([en.language, en.voice, en.intro], ["en-US", "Polly.Joanna", "Hi, this is Claude."]);
  assert.equal(speechProfile({ CALL_ME_INTRO: "" }).intro, "");
  assert.equal(speechProfile({}).language, "en-US");
});

test("inbound twiml gathers speech in the profile language", () => {
  const x = buildInboundTwiml(speechProfile({}, "pl"), "https://x/incoming/gather");
  assert.match(x, /<Gather input="speech" action="https:\/\/x\/incoming\/gather"[^>]*language="pl-PL"><Say[^>]*>Cześć, tu Claude. Słucham.<\/Say><\/Gather>/);
});

test("offlineUrl encodes TwiML for the Twimlets echo service", () => {
  const u = new URL(offlineUrl(speechProfile({}, "pl")));
  assert.equal(u.origin + u.pathname, "https://twimlets.com/echo");
  assert.match(u.searchParams.get("Twiml"), /Claude jest teraz offline/);
});

test("samePhone ignores formatting", () => {
  assert.ok(samePhone("+48 500-000-001", "+48500000001"));
  assert.ok(!samePhone("+48500000002", "+48500000001"));
  assert.ok(!samePhone(undefined, "+48500000001"));
});

test("twilio signature matches Twilio's documented example", () => {
  // Expected value computed with the official twilio npm package (getExpectedTwilioSignature).
  const url = "https://example.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  const sig = twilioSignature("12345", url, params);
  assert.equal(sig, "vNe7KK2kJwCsxc9K3OLkkKB3qqI=");
  assert.ok(validSignature("12345", url, params, sig));
  assert.ok(!validSignature("12345", url, params, "nope"));
  assert.ok(!validSignature("12345", url, params, undefined));
});

test("xmlEscape", () => assert.equal(xmlEscape(`"'<>&`), "&quot;&apos;&lt;&gt;&amp;"));

test("classifyOutcome: voicemail = rejected, ring-out = no-answer, instant hang-up = short", () => {
  assert.equal(classifyOutcome({ status: "completed", answeredBy: "machine_start", duration: "14" }), "rejected");
  assert.equal(classifyOutcome({ status: "completed", answeredBy: "fax" }), "rejected");
  assert.equal(classifyOutcome({ status: "completed", answeredBy: "human", duration: "1" }), "answered");
  assert.equal(classifyOutcome({ status: "completed", answeredBy: "unknown", duration: "9" }), "answered");
  assert.equal(classifyOutcome({ status: "completed", answeredBy: null, duration: "1" }), "short");
  assert.equal(classifyOutcome({ status: "no-answer", duration: "0" }), "no-answer");
  assert.equal(classifyOutcome({ status: "busy" }), "busy");
});

test("saved messages and do-not-disturb", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-st-"));
  const now = Date.now();
  assert.equal(dndActive(now, dir), false);
  saveForCallback({ message: "a", language: "pl-PL", project: "p" }, { dir, now });
  assert.equal(dndActive(now, dir), false);
  saveForCallback({ message: "b", language: "en-US", project: "q" }, { dir, now, dndMinutes: 120 });
  assert.equal(dndActive(now + 119 * 60000, dir), true);
  assert.equal(dndActive(now + 121 * 60000, dir), false);
  assert.deepEqual(takeSaved(dir).map((m) => m.message), ["a", "b"]);
  assert.deepEqual(readState(dir), { saved: [], dndUntil: 0 });
  assert.equal((fs.statSync(path.join(dir, "state.json")).mode & 0o777), 0o600);
});

test("inbound twiml reads saved messages before listening", () => {
  const x = buildInboundTwiml(speechProfile({ CALL_ME_LANGUAGE: "pl-PL" }), "https://x/g", [
    { message: "Gotowe.", language: "pl-PL", project: "euro" },
  ]);
  assert.match(x, /Masz jedną zapisaną wiadomość\.<\/Say><Say[^>]*>Z projektu euro: Gotowe\.<\/Say><Pause length="1"\/><Gather/);
});

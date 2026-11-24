import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseEnv, loadConfig, twilioSignature, validSignature, xmlEscape,
  normalizeLanguage, speechProfile, offlineUrl, samePhone, allowedCaller, machineName, e164, projectConfigPath,
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

test("normalizeLanguage accepts short forms and rejects unsupported", () => {
  assert.equal(normalizeLanguage("pl"), "pl-PL");
  assert.equal(normalizeLanguage("EN-us"), "en-US");
  assert.equal(normalizeLanguage("Polish"), "pl-PL");
  assert.equal(normalizeLanguage(undefined), null);
  assert.throws(() => normalizeLanguage("de-DE"), /Unsupported language/);
});

test("speechProfile: per-call language wins; voice settings apply only to the language they were set for", () => {
  const cfg = { CALL_ME_LANGUAGE: "pl-PL", CALL_ME_RELAY_TTS: "Amazon", CALL_ME_RELAY_VOICE: "Ola-Neural", CALL_ME_GREETING: "Siema, słucham." };
  const pl = speechProfile(cfg);
  assert.deepEqual([pl.language, pl.relayTts, pl.relayVoice, pl.inboundGreeting], ["pl-PL", "Amazon", "Ola-Neural", "Siema, słucham."]);
  const en = speechProfile(cfg, "en");
  assert.deepEqual([en.language, en.relayTts, en.relayVoice, en.inboundGreeting], ["en-US", null, null, "Hi, this is Claude. I'm listening."]);
  assert.equal(speechProfile({}).language, "en-US");
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

test("allowedCaller accepts CALL_ME_TO_NUMBER and CALL_ME_ALLOWED_CALLERS", () => {
  const cfg = { CALL_ME_TO_NUMBER: "+48500000001", CALL_ME_ALLOWED_CALLERS: "+48 600 000 001, +12025550100" };
  assert.ok(allowedCaller(cfg, "+48500000001"));
  assert.ok(allowedCaller(cfg, "+48600000001"));
  assert.ok(allowedCaller(cfg, "+12025550100"));
  assert.ok(!allowedCaller(cfg, "+48600000002"));
  assert.ok(!allowedCaller({ CALL_ME_TO_NUMBER: "+48500000001" }, "+48600000001"));
});

test("machineName defaults to the hostname", () => {
  assert.equal(machineName({ CALL_ME_MACHINE: "laptop" }), "laptop");
  assert.ok(machineName({}).length > 0);
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

test("e164 normalises formatting and rejects non-numbers", () => {
  assert.equal(e164("+1 (725) 000-0002"), "+17250000002");
  assert.throws(() => e164("725 000 0002"), /E\.164/);
  assert.throws(() => e164("+0123"), /E\.164/);
});

test("projectConfigPath gives each project directory its own file", () => {
  assert.equal(projectConfigPath("/home/a/my proj", "/cfg/config.env"), "/cfg/projects/home-a-my-proj.env");
  assert.notEqual(projectConfigPath("/home/a/x"), projectConfigPath("/home/a/y"));
});

test("a project switching language does not inherit the machine config's voice", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-lang-"));
  const machine = path.join(dir, "config.env"), project = path.join(dir, "project.env");
  fs.writeFileSync(machine, "CALL_ME_LANGUAGE=pl-PL\nCALL_ME_RELAY_TTS=Amazon\nCALL_ME_RELAY_VOICE=Ola-Neural\n");
  fs.writeFileSync(project, "CALL_ME_LANGUAGE=en-US\n");
  const { cfg } = loadConfig({}, machine, project);
  const en = speechProfile(cfg);
  assert.equal(en.language, "en-US");
  assert.equal(en.relayVoice, null);
  // A Polish call from that project still gets the machine's Polish voice.
  assert.equal(speechProfile(cfg, "pl-PL").relayVoice, "Ola-Neural");
  // Without a project file, nothing changes.
  assert.equal(speechProfile(loadConfig({}, machine).cfg).relayVoice, "Ola-Neural");
});

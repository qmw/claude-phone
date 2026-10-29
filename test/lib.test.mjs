import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv, loadConfig, buildCallTwiml, twilioSignature, validSignature, xmlEscape } from "../plugins/call-me/server/lib.mjs";

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
  const oneWay = buildCallTwiml("a < b & c", {}, null);
  assert.match(oneWay, /a &lt; b &amp; c/);
  assert.doesNotMatch(oneWay, /Gather/);
  const twoWay = buildCallTwiml("hi", { CALL_ME_LANGUAGE: "pl-PL" }, "https://x/gather/1?a=1&b=2");
  assert.match(twoWay, /<Gather [^>]*action="https:\/\/x\/gather\/1\?a=1&amp;b=2"/);
  assert.match(twoWay, /language="pl-PL"/);
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

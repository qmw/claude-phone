// Preloaded with `node --import` in the e2e test: replaces the Twilio REST API with an in-memory fake
// and logs every request to stderr as `TWILIO {json}`.
const realFetch = globalThis.fetch;
const number = { sid: "PN1", voice_url: "" };
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== "api.twilio.com") return realFetch(url, opts);
  const method = opts.method || "GET";
  const form = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : {};
  process.stderr.write(`TWILIO ${JSON.stringify({ method, path: u.pathname + u.search, form })}\n`);
  let body = {};
  if (u.pathname.endsWith("/IncomingPhoneNumbers.json")) body = { incoming_phone_numbers: [number] };
  else if (u.pathname.endsWith("/IncomingPhoneNumbers/PN1.json")) {
    if (method === "POST" && form.VoiceUrl) number.voice_url = form.VoiceUrl;
    body = number;
  } else if (u.pathname.endsWith("/Calls.json")) body = { sid: "CA1", status: "queued" };
  else if (u.pathname.endsWith("/Calls/CA1.json")) body = { sid: "CA1", status: "in-progress" };
  return new Response(JSON.stringify(body), { status: 200 });
};

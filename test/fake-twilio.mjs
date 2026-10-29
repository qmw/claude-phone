// Preloaded with `node --import` in the e2e test: replaces the Twilio REST API with an in-memory fake
// and logs every request to stderr as `TWILIO {json}`.
// FAKE_CALLS="no-answer;completed:machine_start;completed:human:12" scripts the outcome of each placed call
// (status[:answered_by[:duration]]); without it calls stay in-progress.
const realFetch = globalThis.fetch;
const number = { sid: "PN1", voice_url: "" };
const script = (process.env.FAKE_CALLS || "").split(";").filter(Boolean);
const calls = {};
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
  } else if (u.pathname.endsWith("/Calls.json")) {
    const sid = `CA${Object.keys(calls).length + 1}`;
    const [status, answered_by = null, duration = "10"] = (script.shift() || "in-progress").split(":");
    calls[sid] = { sid, status, answered_by, duration };
    body = { sid, status: "queued" };
  } else if (/\/Calls\/CA\d+\.json$/.test(u.pathname)) {
    const c = calls[u.pathname.match(/(CA\d+)\.json$/)[1]];
    if (method === "POST" && form.Status) c.status = form.Status;
    body = c;
  }
  return new Response(JSON.stringify(body), { status: 200 });
};

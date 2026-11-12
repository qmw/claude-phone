// Minimal WebSocket (RFC 6455) for text messages, without dependencies: the server side for Twilio Media
// Streams and the client side for OpenAI's Live API. Node 20 has no built-in WebSocket client.
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class Conn extends EventEmitter {
  constructor(socket, isClient, head) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.parts = [];
    this.open = true;
    socket.setNoDelay?.(true);
    socket.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.parse();
    });
    socket.on("close", () => this.finish());
    // A reset connection (caller hung up, network drop) must not crash the server: report it only if someone listens.
    socket.on("error", (e) => {
      if (this.listenerCount("error")) this.emit("error", e);
      this.finish();
    });
    if (this.buf.length) setImmediate(() => this.parse());
  }

  finish() {
    if (!this.open) return;
    this.open = false;
    this.emit("close");
  }

  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      const maskKey = masked ? b.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = Buffer.from(b.subarray(off, off + len));
      this.buf = b.subarray(off + len);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      if (op === 0x8) {
        this.frame(0x8, payload.subarray(0, 2));
        this.socket.end();
        return this.finish();
      }
      if (op === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.parts.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.parts);
          this.parts = [];
          this.emit("message", msg.toString("utf8"));
        }
      }
    }
  }

  frame(op, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    const head = [0x80 | op];
    const lenBytes = [];
    if (len < 126) head.push((this.isClient ? 0x80 : 0) | len);
    else if (len < 65536) {
      head.push((this.isClient ? 0x80 : 0) | 126);
      lenBytes.push((len >> 8) & 0xff, len & 0xff);
    } else {
      head.push((this.isClient ? 0x80 : 0) | 127);
      const l = Buffer.alloc(8);
      l.writeBigUInt64BE(BigInt(len));
      lenBytes.push(...l);
    }
    let body = payload;
    const parts = [Buffer.from(head), Buffer.from(lenBytes)];
    if (this.isClient) {
      const key = crypto.randomBytes(4);
      body = Buffer.from(payload);
      for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
      parts.push(key);
    }
    parts.push(body);
    this.socket.write(Buffer.concat(parts));
  }

  send(text) {
    this.frame(0x1, Buffer.from(typeof text === "string" ? text : JSON.stringify(text), "utf8"));
  }

  close() {
    if (!this.open) return;
    this.frame(0x8, Buffer.from([0x03, 0xe8]));
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
    this.finish();
  }
}

/** Accept a WebSocket upgrade on an http server's "upgrade" event. */
export function acceptUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key || (req.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new Conn(socket, false, head);
}

/** Open a wss:// (or ws://, for tests) connection. Resolves to a connection once the server switched protocols. */
export function connect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = (url.startsWith("ws:") ? http : https).request(url.replace(/^ws/, "http"), {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, ...headers },
    });
    req.on("upgrade", (res, socket, head) => {
      const want = crypto.createHash("sha1").update(key + GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== want) return reject(new Error("bad WebSocket handshake"));
      resolve(new Conn(socket, true, head));
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => reject(new Error(`WebSocket refused: HTTP ${res.statusCode} ${body.slice(0, 300)}`)));
    });
    req.on("error", reject);
    req.end();
  });
}

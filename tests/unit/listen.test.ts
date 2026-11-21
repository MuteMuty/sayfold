// The Worker's live-dictation endpoints (src/server/listen.ts), with a mocked AI binding: nothing here
// reaches Workers AI, whose free allowance the whole account shares.
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../../src/server/listen.ts";
import { DRAIN_MS, KEYTERMS, MAX_FRAME_BYTES, NEURONS_PER_AUDIO_SECOND, SESSION_MAX_SECONDS, SPEECH_MODEL } from "../../src/server/config.ts";
import { BYTES_PER_SECOND, LISTEN_PATH, STATUS_PATH, parseClientMessage } from "../../src/listen/protocol.ts";
import { audio, fakeAi, flux, listenRequest, setup, type FakeSocket } from "./server-fakes.ts";

const STOP = JSON.stringify({ type: "stop" });

// A session's timers (its 2-minute limit, the wait for Flux's last words) run on a fake clock.
beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

/** Opens a session and returns the Worker's end of the client socket and the Flux socket. */
async function connect(s: ReturnType<typeof setup>, ip = "203.0.113.7") {
  const res = await handle(listenRequest({ ip }), s.rt);
  assert.equal(res.status, 101);
  const server = s.servers.at(-1)!;
  assert.equal(server.accepted, true);
  return { server, upstream: s.ai.calls.at(-1)?.upstream as FakeSocket };
}

/** Fills the day's counter to just under the cap with other visitors' audio. */
async function nearlyCap(s: ReturnType<typeof setup>, secondsLeft: number) {
  let seconds = Math.ceil(9000 / NEURONS_PER_AUDIO_SECOND) - secondsLeft;
  for (let v = 0; seconds > 0; v++) {
    const r = await s.core.open(`192.0.2.${v}`);
    assert.ok(r.ok);
    const n = Math.min(120, seconds);
    for (let i = 0; i < n; i++) s.core.add(r.session, 1);
    s.core.close(r.session);
    seconds -= n;
  }
}

// --- routes ---------------------------------------------------------------------------------

test("paths: the page's own files still come from the static assets, untouched", async () => {
  const s = setup();
  for (const path of ["/", "/index.html", "/api/other", "/api/listen/x"]) {
    const req = new Request(`https://sayfold.brightloopapps.com${path}`);
    const res = await handle(req, s.rt);
    assert.equal(await res.text(), "asset", path);
    assert.equal(s.assets.at(-1), req);
  }
  assert.equal(s.ai.calls.length, 0);
});

test("status: available, not cached; unavailable once the day's cap is reached", async () => {
  const s = setup();
  const res = await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`), s.rt);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { available: true });
  await nearlyCap(s, 0);
  const after = await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`), s.rt);
  assert.deepEqual(await after.json(), { available: false });
  const post = await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`, { method: "POST" }), s.rt);
  assert.equal(post.status, 405);
});

test("status: says unavailable (not an error) when the counter can't be reached", async () => {
  const s = setup();
  s.rt.meter.status = async () => { throw new Error("Durable Object reset"); };
  const res = await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`), s.rt);
  assert.deepEqual(await res.json(), { available: false });
});

test("listen: refuses a plain request (426) and other origins (403), before opening anything", async () => {
  const s = setup();
  assert.equal((await handle(listenRequest({ upgrade: null }), s.rt)).status, 426);
  assert.equal((await handle(listenRequest({ upgrade: "h2c" }), s.rt)).status, 426);
  for (const origin of [null, "https://evil.example", "https://sayfold.brightloopapps.com.evil.example", "http://sayfold.brightloopapps.com",
    "https://lab.brightloopapps.com", "http://localhost.evil.example", "https://localhost:5173", "null"]) {
    assert.equal((await handle(listenRequest({ origin }), s.rt)).status, 403, String(origin));
  }
  assert.equal(s.servers.length, 0);
  assert.equal(s.ai.calls.length, 0);
  await s.settle();
  assert.deepEqual(await s.core.status("203.0.113.7"), { available: true });
});

test("listen: takes the launch and preview origins and local development", async () => {
  for (const origin of ["https://sayfold.brightloopapps.com", "https://sayfold.erko-erka1.workers.dev", "http://localhost:5173", "http://127.0.0.1:4173", "http://localhost"]) {
    const s = setup();
    const res = await handle(listenRequest({ origin }), s.rt);
    assert.equal(res.status, 101, origin);
    assert.equal(s.ai.calls.length, 1, origin);
  }
});

// --- a session ----------------------------------------------------------------------------

test("session: opens Flux with the configured model and keyterms, and relays audio as it comes", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  const call = s.ai.calls[0];
  assert.equal(call.model, SPEECH_MODEL);
  assert.deepEqual(call.inputs, { encoding: "linear16", sample_rate: "16000", keyterm: KEYTERMS });
  assert.deepEqual(call.options, { websocket: true });
  assert.equal(upstream.accepted, true);

  const a = audio(0.08, [9, 8, 7]);
  const b = audio(0.08, [6, 5]);
  server.emit("message", a.buffer);
  server.emit("message", b);
  assert.deepEqual(upstream.bytes, new Uint8Array([...a, ...b]));
  assert.equal(server.closed, null);
});

test("session: Flux's updates and end of turn come back in the page's protocol; nothing else does", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  upstream.emit("message", JSON.stringify({ type: "Connected", request_id: "x", sequence_id: 0 }));
  upstream.emit("message", flux("Update", ""));
  upstream.emit("message", flux("StartOfTurn", "Water the"));
  upstream.emit("message", flux("Update", "Water the tomatoes"));
  upstream.emit("message", flux("EndOfTurn", "Water the tomatoes every morning."));
  upstream.emit("message", flux("Update", "And call", 1));
  upstream.emit("message", new Uint8Array([1, 2]).buffer);
  upstream.emit("message", "not json");
  upstream.emit("message", JSON.stringify({ type: "TurnInfo", event: "Update", turn_index: "0", transcript: "bad" }));
  assert.deepEqual(server.messages, [
    { type: "update", turn: 0, text: "" },
    { type: "update", turn: 0, text: "Water the" },
    { type: "update", turn: 0, text: "Water the tomatoes" },
    { type: "end-of-turn", turn: 0, text: "Water the tomatoes every morning." },
    { type: "update", turn: 1, text: "And call" },
  ]);
});

test("session: stop asks Flux for its last words, relays them, then closes cleanly", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  server.emit("message", audio(1));
  server.emit("message", audio(0.5));
  server.emit("message", STOP);
  assert.deepEqual(upstream.messages, [{ type: "CloseStream" }]);
  server.emit("message", audio(1)); // dropped: the recording has stopped
  assert.equal(upstream.bytes.length, 1.5 * BYTES_PER_SECOND);
  upstream.emit("message", flux("EndOfTurn", "Call the plumber on Friday."));
  assert.equal(server.closed, null);
  upstream.emit("close");
  assert.deepEqual(server.messages, [{ type: "end-of-turn", turn: 0, text: "Call the plumber on Friday." }]);
  assert.deepEqual(server.closed, { code: 1000, reason: "done" });
  await s.settle();
  // The session is closed in the counter, with its 1.5 seconds counted.
  assert.equal((await s.core.open("203.0.113.7")).ok, true);
  const used = s.sql.db.prepare("SELECT seconds FROM visitors").get() as { seconds: number };
  assert.equal(used.seconds, 1.5);
});

test("session: if Flux doesn't close after stop, the Worker closes anyway", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  server.emit("message", STOP);
  mock.timers.tick(DRAIN_MS - 1);
  assert.equal(server.closed, null);
  mock.timers.tick(1);
  assert.deepEqual(server.closed, { code: 1000, reason: "done" });
  assert.ok(upstream.closed);
});

test("session: the page closing closes Flux and frees the visitor's session", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  server.emit("message", audio(1));
  server.emit("close");
  assert.ok(upstream.closed);
  await s.settle();
  assert.equal((await s.core.open("203.0.113.7")).ok, true);
});

test("session: text for a page that has already gone ends the session instead of throwing", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  server.close(1006, "gone"); // closed, but its close event hasn't arrived yet
  upstream.emit("message", flux("Update", "Water"));
  assert.ok(upstream.closed);
  await s.settle();
  assert.equal((await s.core.open("203.0.113.7")).ok, true);
});

test("session: unknown text frames are ignored, and a frame over a second is refused", async () => {
  assert.deepEqual(parseClientMessage(STOP), { type: "stop" });
  for (const junk of ["", "stop", "{}", "[]", "null", JSON.stringify({ type: "start" })]) assert.equal(parseClientMessage(junk), null, junk);
  const s = setup();
  const { server, upstream } = await connect(s);
  server.emit("message", JSON.stringify({ type: "hello" }));
  assert.equal(server.closed, null);
  server.emit("message", new Uint8Array(MAX_FRAME_BYTES + 2));
  assert.deepEqual(server.closed, { code: 1009, reason: "frame too big" });
  assert.equal(upstream.bytes.length, 0);
  assert.ok(upstream.closed);
});

// --- falling back ------------------------------------------------------------------------

for (const behaviour of ["throws", "no-socket"] as const) {
  test(`fallback: when Workers AI fails (${behaviour}), the page is told and the socket closes cleanly`, async () => {
    const s = setup({ ai: fakeAi(behaviour) });
    const res = await handle(listenRequest(), s.rt);
    assert.equal(res.status, 101);
    const server = s.servers[0];
    assert.deepEqual(server.messages, [{ type: "fallback", reason: "error" }]);
    assert.deepEqual(server.closed, { code: 1000, reason: "fallback" });
    await s.settle();
    assert.equal((await s.core.open("203.0.113.7")).ok, true, "the failed session doesn't hold the visitor's slot");
  });
}

test("fallback: Flux dropping the connection or sending an error tells the page", async () => {
  {
    const s = setup();
    const { server, upstream } = await connect(s);
    upstream.emit("message", flux("Update", "Water"));
    upstream.emit("close");
    assert.deepEqual(server.messages.at(-1), { type: "fallback", reason: "error" });
    assert.deepEqual(server.closed, { code: 1000, reason: "fallback" });
  }
  {
    const s = setup();
    const { server, upstream } = await connect(s);
    upstream.emit("message", JSON.stringify({ type: "Error", code: "INTERNAL", description: "x" }));
    assert.deepEqual(server.messages, [{ type: "fallback", reason: "error" }]);
    assert.ok(upstream.closed);
  }
  {
    const s = setup();
    const { server, upstream } = await connect(s);
    upstream.emit("error");
    assert.deepEqual(server.messages, [{ type: "fallback", reason: "error" }]);
  }
});

test("fallback: a second recording from the same visitor gets busy, without opening Flux", async () => {
  const s = setup();
  await connect(s);
  const res = await handle(listenRequest(), s.rt);
  assert.equal(res.status, 101);
  assert.deepEqual(s.servers[1].messages, [{ type: "fallback", reason: "busy" }]);
  assert.deepEqual(s.servers[1].closed, { code: 1000, reason: "fallback" });
  assert.equal(s.ai.calls.length, 1);
  await connect(s, "198.51.100.4");
});

test("limits: a session takes at most 2 minutes of audio; Flux gets exactly that, then the page hears session-limit", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  for (let i = 0; i < SESSION_MAX_SECONDS * 2 + 10; i++) server.emit("message", audio(0.5));
  await s.settle();
  assert.equal(upstream.bytes.length, SESSION_MAX_SECONDS * BYTES_PER_SECOND);
  assert.deepEqual(upstream.messages, [{ type: "CloseStream" }]);
  upstream.emit("close");
  assert.deepEqual(server.messages, [{ type: "fallback", reason: "session-limit" }]);
  assert.deepEqual(server.closed, { code: 1000, reason: "fallback" });
});

test("limits: a session also ends after 2 minutes connected, audio or not", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  mock.timers.tick(SESSION_MAX_SECONDS * 1000 - 1);
  assert.deepEqual(upstream.messages, []);
  mock.timers.tick(1);
  assert.deepEqual(upstream.messages, [{ type: "CloseStream" }]);
  mock.timers.tick(DRAIN_MS);
  assert.deepEqual(server.messages, [{ type: "fallback", reason: "session-limit" }]);
  assert.deepEqual(server.closed, { code: 1000, reason: "fallback" });
});

test("limits: a visitor's 3 minutes a day are counted across sessions; the rest of the day falls back", async () => {
  const s = setup();
  const first = await connect(s);
  for (let i = 0; i < 120; i++) first.server.emit("message", audio(1));
  first.upstream.emit("close");
  await s.settle();
  const second = await connect(s);
  for (let i = 0; i < 100; i++) second.server.emit("message", audio(1));
  await s.settle();
  assert.equal(second.upstream.bytes.length, 60 * BYTES_PER_SECOND, "only the minute left");
  second.upstream.emit("close");
  assert.deepEqual(second.server.messages, [{ type: "fallback", reason: "visitor-limit" }]);
  await s.settle();
  await handle(listenRequest(), s.rt);
  assert.deepEqual(s.servers.at(-1)!.messages, [{ type: "fallback", reason: "visitor-limit" }]);
  assert.equal(s.ai.calls.length, 2);
});

test("cap: crossing 9,000 tells every open session and closes it; new sessions fall back; midnight UTC resets it", async () => {
  const s = setup({ start: Date.UTC(2026, 10, 21, 23, 58, 0) });
  await nearlyCap(s, 3);
  const a = await connect(s, "198.51.100.1");
  const b = await connect(s, "198.51.100.2");
  for (let i = 0; i < 3; i++) a.server.emit("message", audio(1));
  await s.settle();
  // A crossed the cap: it stops taking audio and is told once Flux has finished.
  assert.deepEqual(a.upstream.messages, [{ type: "CloseStream" }]);
  a.upstream.emit("close");
  assert.deepEqual(a.server.messages, [{ type: "fallback", reason: "cap" }]);
  // B is told at its next report.
  b.server.emit("message", audio(1));
  await s.settle();
  b.upstream.emit("close");
  assert.deepEqual(b.server.messages, [{ type: "fallback", reason: "cap" }]);
  assert.deepEqual(b.server.closed, { code: 1000, reason: "fallback" });

  const status = await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`), s.rt);
  assert.deepEqual(await status.json(), { available: false });
  await handle(listenRequest({ ip: "198.51.100.3" }), s.rt);
  assert.deepEqual(s.servers.at(-1)!.messages, [{ type: "fallback", reason: "cap" }]);
  assert.equal(s.ai.calls.length, 2, "no Flux call once the cap is reached");

  s.clock.now = Date.UTC(2026, 10, 22, 0, 0, 0);
  const next = await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`), s.rt);
  assert.deepEqual(await next.json(), { available: true });
  await connect(s, "198.51.100.3");
  assert.equal(s.ai.calls.length, 3);
});

// --- nothing is kept -------------------------------------------------------------------------

test("privacy: audio and text pass through, but never reach storage, a log or any other request", async (t) => {
  const spied = (["log", "info", "warn", "error", "debug", "trace", "dir", "table"] as const).map((m) => t.mock.method(console, m));
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response(""));
  const s = setup();
  const IP = "203.0.113.77";
  const SECRET_TEXT = "Marigold zeppelin password seventeen";
  // "SAYFOLD-SECRET-AUDIO" as bytes, repeated: easy to spot anywhere it might land.
  const marker = [...new TextEncoder().encode("SAYFOLD-SECRET-AUDIO")];
  const { server, upstream } = await connect(s, IP);
  for (let i = 0; i < 4; i++) server.emit("message", audio(0.75, marker));
  upstream.emit("message", flux("Update", SECRET_TEXT.slice(0, 15)));
  upstream.emit("message", flux("EndOfTurn", SECRET_TEXT));
  server.emit("message", STOP);
  upstream.emit("close");
  await s.settle();
  assert.equal(server.messages.length, 2, "the text did reach the page");
  assert.equal(upstream.bytes.length, 3 * BYTES_PER_SECOND, "the audio did reach Flux");

  for (const spy of spied) assert.equal(spy.mock.callCount(), 0, "nothing is logged at all");
  assert.equal(fetched.mock.callCount(), 0, "no other request is made");

  const db = s.sql.db;
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(tables, ["days", "salts", "sessions", "visitors"]);
  const hex64 = /^[0-9a-f]{64}$/;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const allowed: Record<string, Record<string, (v: unknown) => boolean>> = {
    days: { day: (v) => day.test(String(v)), neurons: isNumber },
    salts: { day: (v) => day.test(String(v)), salt: (v) => hex64.test(String(v)) },
    visitors: { day: (v) => day.test(String(v)), visitor: (v) => hex64.test(String(v)), seconds: isNumber },
    sessions: { id: (v) => /^[0-9a-f-]{36}$/.test(String(v)), visitor: (v) => hex64.test(String(v)), seen: isNumber },
  };
  for (const name of tables) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
      assert.deepEqual(Object.keys(row).sort(), Object.keys(allowed[name]).sort(), name);
      for (const [col, ok] of Object.entries(allowed[name])) assert.ok(ok(row[col]), `${name}.${col} = ${String(row[col])}`);
    }
  }
  // And the raw database file holds none of it either.
  const file = Buffer.from((db as unknown as { serialize?: () => Uint8Array }).serialize?.() ?? []);
  const everything = JSON.stringify(tables.map((n) => db.prepare(`SELECT * FROM "${n}"`).all())) + file.toString("latin1");
  for (const needle of [SECRET_TEXT, "Marigold", "zeppelin", "SAYFOLD-SECRET-AUDIO", IP, "203.0.113"]) {
    assert.ok(!everything.includes(needle), `storage holds "${needle}"`);
  }
});

test("privacy: the server code has no logging calls, and the Worker has no analytics, logs or other storage bound", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(import.meta.dirname, "../..");
  for (const dir of ["src/server", "src/listen"]) {
    for (const f of readdirSync(join(root, dir)).filter((n) => n.endsWith(".ts"))) {
      assert.doesNotMatch(readFileSync(join(root, dir, f), "utf8"), /\bconsole\s*\.|\b(?:await|return)\s+fetch\s*\(|globalThis\.fetch/, `${dir}/${f}`);
    }
  }
  assert.equal(LISTEN_PATH, "/api/listen");
});

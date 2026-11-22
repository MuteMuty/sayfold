// The Worker's live-dictation endpoints (src/server/listen.ts), with a mocked AI binding: nothing here
// reaches Workers AI, whose free allowance the whole account shares.
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { handle, isQuotaRefusal } from "../../src/server/listen.ts";
import {
  DRAIN_MS, FIX_MODEL, FIX_TIMEOUT_MS, FIX_WAIT_MS, IDLE_SECONDS, KEYTERMS, MAX_FRAME_BYTES, MIP_OPT_OUT, NEURONS_PER_AUDIO_SECOND, SESSION_MAX_SECONDS, SPEECH_MODEL, VISITOR_SECONDS_PER_DAY,
} from "../../src/server/config.ts";
import { BYTES_PER_SECOND, LISTEN_PATH, STATUS_PATH, parseClientMessage } from "../../src/listen/protocol.ts";
import { AI_ERRORS, audio, fakeAi, flux, listenRequest, replies, setup, typesOut, type FakeSocket } from "./server-fakes.ts";
import { fixNeurons } from "../../src/server/correct.ts";
import { STOP_WAIT_MS } from "../../src/core/live.ts";

const STOP = JSON.stringify({ type: "stop" });

// A session's timers (its 2-minute limit, the idle timeout, the wait for Flux's last words) and the time it
// has been connected run on a fake clock.
beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.UTC(2026, 10, 21, 12, 0, 0) }));
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
  assert.deepEqual(call.inputs, { encoding: "linear16", sample_rate: "16000", keyterm: KEYTERMS, mip_opt_out: "true" });
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
  await s.settle();
  assert.deepEqual(server.messages, [
    { type: "update", turn: 0, text: "" },
    { type: "update", turn: 0, text: "Water the" },
    { type: "update", turn: 0, text: "Water the tomatoes" },
    { type: "end-of-turn", turn: 0, text: "Water the tomatoes every morning." },
    { type: "update", turn: 1, text: "And call" },
    // The ended turn's correction comes once the model answers, after the words that came meanwhile.
    { type: "text", turn: 0, text: "Water the tomatoes every morning." },
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
  // It waits for the last turn's correction, then closes.
  await s.settle();
  assert.deepEqual(server.messages, [
    { type: "end-of-turn", turn: 0, text: "Call the plumber on Friday." },
    { type: "text", turn: 0, text: "Call the plumber on Friday." },
  ]);
  assert.deepEqual(server.closed, { code: 1000, reason: "done" });
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

for (const behaviour of ["throws", "capacity", "no-socket"] as const) {
  test(`fallback: when Workers AI fails (${behaviour}), the page is told and the socket closes cleanly`, async () => {
    const s = setup({ ai: fakeAi(behaviour) });
    const res = await handle(listenRequest(), s.rt);
    assert.equal(res.status, 101);
    const server = s.servers[0];
    assert.deepEqual(server.messages, [{ type: "fallback", reason: "error" }]);
    assert.deepEqual(server.closed, { code: 1000, reason: "fallback" });
    await s.settle();
    assert.equal((await s.core.open("203.0.113.7")).ok, true, "the failed session doesn't hold the visitor's slot");
    assert.deepEqual(await s.core.status("198.51.100.4"), { available: true }, "only that session falls back");
    await handle(listenRequest({ ip: "198.51.100.4" }), s.rt);
    assert.equal(s.ai.runs.count, 2, "the next recording tries Workers AI again");
  });
}

test("quota: only Workers AI's daily-allowance refusal (3036) counts as the day being used up", () => {
  assert.equal(isQuotaRefusal(new Error(AI_ERRORS.quota)), true);
  assert.equal(isQuotaRefusal(new Error("InferenceUpstreamError: 3036: account limited")), true);
  assert.equal(isQuotaRefusal(new Error("3036: account limited")), true);
  assert.equal(isQuotaRefusal(new Error("You have used up your daily free allocation of 10,000 neurons.")), true);
  assert.equal(isQuotaRefusal(Object.assign(new Error("Account limited"), { code: 3036 })), true, "an error code of 3036");
  assert.equal(isQuotaRefusal({ code: "3036", message: "x" }), true, "the code as a string, too");
  for (const other of [AI_ERRORS.capacity, AI_ERRORS.throws, "AiError: 13036: x", "AiError: 30360: x", "3036abc", "Network connection lost.", "",
    "timeout after 3036 ms", "Request 3036 failed", "AiError: 3040: retry in 3036 ms", "id 3036", "3036"]) {
    assert.equal(isQuotaRefusal(new Error(other)), false, other);
  }
  for (const code of [3040, "13036", 30360, null]) assert.equal(isQuotaRefusal({ code, message: "timeout after 3036 ms" }), false, String(code));
  assert.equal(isQuotaRefusal("AiError: 3036: daily free allocation"), true, "a thrown string, too");
  assert.equal(isQuotaRefusal(undefined), false);
});

test("quota: an error that only mentions 3036 (a timeout of 3036 ms) falls back for that recording, and the day stays open", async () => {
  const s = setup({ ai: { ...fakeAi(), ai: { run: async () => { throw new Error("AiError: 3040: timeout after 3036 ms"); } } } });
  await handle(listenRequest(), s.rt);
  assert.deepEqual(s.servers[0].messages, [{ type: "fallback", reason: "error" }]);
  await s.settle();
  assert.deepEqual(await s.core.status("198.51.100.4"), { available: true });
});

test("quota: a Workers AI error with code 3036 closes the day", async () => {
  const s = setup({ ai: { ...fakeAi(), ai: { run: async () => { throw Object.assign(new Error("Account limited"), { code: 3036 }); } } } });
  await handle(listenRequest(), s.rt);
  assert.deepEqual(s.servers[0].messages, [{ type: "fallback", reason: "cap" }]);
  await s.settle();
  assert.deepEqual(await s.core.status("198.51.100.4"), { available: false });
});

test("quota: Flux reporting the daily refusal mid-stream closes the day with cap, not error", async () => {
  for (const error of [
    { type: "Error", code: 3036, description: "Account limited" },
    { type: "Error", code: "INTERNAL", description: "AiError: 3036: You have used up your daily free allocation of 10,000 neurons." },
    { type: "Error", code: "INTERNAL", message: "You have used up your daily free allocation of 10,000 neurons." },
  ]) {
    const s = setup();
    const { server, upstream } = await connect(s);
    server.emit("message", audio(1));
    upstream.emit("message", flux("Update", "Water the"));
    upstream.emit("message", JSON.stringify(error));
    await s.settle();
    assert.deepEqual(server.messages, [{ type: "update", turn: 0, text: "Water the" }, { type: "fallback", reason: "cap", seconds: 1 }], JSON.stringify(error));
    assert.ok(upstream.closed);
    assert.deepEqual(await s.core.status("198.51.100.4"), { available: false }, "the rest of the day falls back");
  }
  // Any other Flux error is that recording's error only, even one that mentions 3036.
  const s = setup();
  const { server, upstream } = await connect(s);
  upstream.emit("message", JSON.stringify({ type: "Error", code: "TIMEOUT", description: "timeout after 3036 ms" }));
  await s.settle();
  assert.deepEqual(server.messages, [{ type: "fallback", reason: "error" }]);
  assert.deepEqual(await s.core.status("198.51.100.4"), { available: true });
});

test("quota: when Workers AI says the account's allowance is used up, the day closes until midnight UTC without asking it again", async () => {
  const s = setup({ ai: fakeAi("quota"), start: Date.UTC(2026, 10, 21, 22, 0, 0) });
  await handle(listenRequest(), s.rt);
  assert.deepEqual(s.servers[0].messages, [{ type: "fallback", reason: "cap" }]);
  assert.deepEqual(s.servers[0].closed, { code: 1000, reason: "fallback" });
  assert.equal(s.ai.runs.count, 1);
  await s.settle();

  const status = await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`), s.rt);
  assert.deepEqual(await status.json(), { available: false });
  for (const ip of ["203.0.113.7", "198.51.100.4", "198.51.100.5"]) {
    await handle(listenRequest({ ip }), s.rt);
    assert.deepEqual(s.servers.at(-1)!.messages, [{ type: "fallback", reason: "cap" }], ip);
  }
  assert.equal(s.ai.runs.count, 1, "no Flux call for the rest of the day");

  s.clock.now = Date.UTC(2026, 10, 22, 0, 0, 0);
  const next = await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`), s.rt);
  assert.deepEqual(await next.json(), { available: true });
  await handle(listenRequest(), s.rt);
  assert.equal(s.ai.runs.count, 2, "tried again after midnight UTC");
});

test("quota: if the counter can't be told, that session still falls back", async () => {
  const s = setup({ ai: fakeAi("quota") });
  s.rt.meter.exhausted = async () => { throw new Error("Durable Object reset"); };
  await handle(listenRequest(), s.rt);
  assert.deepEqual(s.servers[0].messages, [{ type: "fallback", reason: "cap" }]);
});

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

test("fallback: says how many seconds of audio it took, so the page can turn the rest into text itself", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  for (let i = 0; i < 25; i++) server.emit("message", audio(0.08));
  upstream.emit("message", flux("Update", "Water the"));
  upstream.emit("close");
  assert.deepEqual(server.messages, [{ type: "update", turn: 0, text: "Water the" }, { type: "fallback", reason: "error", seconds: 2 }]);
  // Audio sent once the server has stopped taking it isn't counted as taken.
  const t = setup();
  const b = await connect(t);
  b.server.emit("message", audio(1));
  mock.timers.tick(IDLE_SECONDS * 1000);
  b.server.emit("message", audio(1)); // too late: draining
  b.upstream.emit("close");
  assert.deepEqual(b.server.messages, [{ type: "fallback", reason: "idle", seconds: 1 }]);
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
  assert.deepEqual(server.messages, [{ type: "fallback", reason: "session-limit", seconds: SESSION_MAX_SECONDS }], "with the seconds of audio taken");
  assert.deepEqual(server.closed, { code: 1000, reason: "fallback" });
});

test("limits: a session also ends after 2 minutes connected, however little audio it sends", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  for (let t = 0; t < SESSION_MAX_SECONDS - 1; t++) {
    server.emit("message", audio(0.01));
    mock.timers.tick(1000);
  }
  server.emit("message", audio(0.01));
  mock.timers.tick(999);
  assert.deepEqual(upstream.messages, []);
  mock.timers.tick(1);
  assert.deepEqual(upstream.messages, [{ type: "CloseStream" }]);
  mock.timers.tick(DRAIN_MS);
  assert.deepEqual(server.messages, [{ type: "fallback", reason: "session-limit", seconds: 1.2 }]);
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
  assert.deepEqual(second.server.messages, [{ type: "fallback", reason: "visitor-limit", seconds: 60 }]);
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
  assert.deepEqual(a.server.messages, [{ type: "fallback", reason: "cap", seconds: 3 }]);
  // B is told at its next report.
  b.server.emit("message", audio(1));
  await s.settle();
  b.upstream.emit("close");
  assert.deepEqual(b.server.messages, [{ type: "fallback", reason: "cap", seconds: 1 }]);
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

// --- spoken corrections (slice 3) --------------------------------------------------------------

const texts = (server: FakeSocket) => server.messages.filter((m) => (m as { type: string }).type === "text");

/** Says each turn as Flux would hear it (an update, then its end), and lets the corrections run. */
async function sayTurns(s: ReturnType<typeof setup>, upstream: FakeSocket, turns: string[], first = 0) {
  for (const [i, said] of turns.entries()) {
    upstream.emit("message", flux("Update", said.split(" ").slice(0, 2).join(" "), first + i));
    upstream.emit("message", flux("EndOfTurn", said, first + i));
    await s.settle();
  }
}

test("corrections: Erik's clips c1, c4 and c6: each turn goes to the model with the text so far, and the page gets the whole corrected text", async () => {
  for (const [turns, fixed] of [
    [["Let's meet on Monday at ten.", "No, Tuesday."], "Let's meet on Tuesday at ten."],
    [["Send the report to Anna.", "I mean Henna."], "Send the report to Henna."],
    [["The app crashes when I rotate the phone.", "Wait. Not the phone. The tablet."], "The app crashes when I rotate the tablet."],
  ] as const) {
    const s = setup({ ai: fakeAi("ok", replies({ [turns[1]]: fixed })) });
    const { server, upstream } = await connect(s);
    await sayTurns(s, upstream, [...turns]);
    assert.deepEqual(s.ai.fixes.map((f) => [f.model, f.doc, f.said]), [
      [FIX_MODEL, "", turns[0]],
      [FIX_MODEL, turns[0], turns[1]],
    ]);
    assert.deepEqual(texts(server), [
      { type: "text", turn: 0, text: turns[0] },
      { type: "text", turn: 1, text: fixed },
    ]);
    // The end of each turn still comes first, so the page shows it at once.
    assert.deepEqual(server.messages.filter((m) => (m as { type: string }).type === "end-of-turn").length, 2);
  }
});

test("corrections: \"scratch that\" in one breath, a spoken list, and plain sentences that only sound like commands", async () => {
  const s = setup({
    ai: fakeAi("ok", replies({
      "The login page is slow. It takes ten seconds to load scratch that.": "The login page is slow.",
      "Shopping list: milk, bread, eggs and butter.": "The login page is slow.\nShopping list:\n- Milk\n- Bread\n- Eggs\n- Butter",
    })),
  });
  const { server, upstream } = await connect(s);
  await sayTurns(s, upstream, [
    "The login page is slow. It takes ten seconds to load scratch that.",
    "Shopping list: milk, bread, eggs and butter.",
    // Typed out by the model, as said: they aren't commands.
    "No, I don't think the old design was better.",
    "Make the list view load faster.",
    "She likes to scratch the sofa.",
  ]);
  assert.deepEqual(texts(server).map((m) => (m as { text: string }).text), [
    "The login page is slow.",
    "The login page is slow.\nShopping list:\n- Milk\n- Bread\n- Eggs\n- Butter",
    // After the list's last item, a new line, so the sentence isn't taken for an item.
    "The login page is slow.\nShopping list:\n- Milk\n- Bread\n- Eggs\n- Butter\nNo, I don't think the old design was better.",
    "The login page is slow.\nShopping list:\n- Milk\n- Bread\n- Eggs\n- Butter\nNo, I don't think the old design was better. Make the list view load faster.",
    "The login page is slow.\nShopping list:\n- Milk\n- Bread\n- Eggs\n- Butter\nNo, I don't think the old design was better. Make the list view load faster. She likes to scratch the sofa.",
  ]);
});

test("corrections: turns are corrected one after another, in order, each on the text the one before it made", async () => {
  const answers: ((v: unknown) => void)[] = [];
  const s = setup({ ai: fakeAi("ok", () => new Promise((r) => answers.push(r))) });
  const { server, upstream } = await connect(s);
  upstream.emit("message", flux("EndOfTurn", "Ship it on the twelfth.", 0));
  upstream.emit("message", flux("EndOfTurn", "No, the thirteenth.", 1));
  await s.settle();
  assert.equal(s.ai.fixes.length, 1, "the second turn waits for the first");
  answers[0]({ response: "<text>Ship it on the twelfth.</text>" });
  await s.settle();
  assert.deepEqual([s.ai.fixes[1].doc, s.ai.fixes[1].said], ["Ship it on the twelfth.", "No, the thirteenth."]);
  answers[1]({ response: "<text>Ship it on the thirteenth.</text>" });
  await s.settle();
  assert.deepEqual(texts(server), [
    { type: "text", turn: 0, text: "Ship it on the twelfth." },
    { type: "text", turn: 1, text: "Ship it on the thirteenth." },
  ]);
});

test("corrections: an empty turn isn't sent to the model", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  upstream.emit("message", flux("EndOfTurn", "  "));
  await s.settle();
  assert.equal(s.ai.fixes.length, 0);
  assert.deepEqual(texts(server), []);
});

test("corrections: when the model fails or writes junk, that turn's plain text is kept, and the next turn is corrected as usual", async () => {
  for (const bad of [new Error(AI_ERRORS.capacity), { response: "Sure! <text>Let's meet on Tuesday at ten.</text>" }, { response: "<text>* Tuesday</text>" }, { response: "" }]) {
    const s = setup({ ai: fakeAi("ok", (call) => (call.said === "No, Tuesday." ? bad : typesOut(call))) });
    const { server, upstream } = await connect(s);
    await sayTurns(s, upstream, ["Let's meet on Monday at ten.", "No, Tuesday.", "Bring the slides."]);
    assert.deepEqual(texts(server).map((m) => (m as { text: string }).text), [
      "Let's meet on Monday at ten.",
      "Let's meet on Monday at ten. No, Tuesday.",
      "Let's meet on Monday at ten. No, Tuesday. Bring the slides.",
    ], JSON.stringify(String(bad)));
    assert.equal(s.ai.fixes[2].doc, "Let's meet on Monday at ten. No, Tuesday.");
    assert.equal(server.closed, null, "the recording goes on");
  }
});

test("corrections: a model slower than the timeout keeps the plain text, and its late answer is never sent", async () => {
  let answer!: (v: unknown) => void;
  const s = setup({ ai: fakeAi("ok", () => new Promise((r) => (answer = r))) });
  const { server, upstream } = await connect(s);
  upstream.emit("message", flux("EndOfTurn", "Let's meet on Monday at ten."));
  await s.settle();
  mock.timers.tick(FIX_TIMEOUT_MS - 1);
  await s.settle();
  assert.deepEqual(texts(server), [], "gave up before the timeout");
  mock.timers.tick(1);
  await s.settle();
  assert.deepEqual(texts(server), [{ type: "text", turn: 0, text: "Let's meet on Monday at ten." }]);
  answer({ response: "<text>Let's meet on Friday.</text>" });
  await s.settle();
  assert.equal(texts(server).length, 1);
  assert.equal(server.closed, null);
});

test("corrections: Workers AI's daily refusal from the model closes the day, as Flux's does", async () => {
  const s = setup({ ai: fakeAi("ok", () => new Error(AI_ERRORS.quota)) });
  const { server, upstream } = await connect(s);
  server.emit("message", audio(1));
  upstream.emit("message", flux("EndOfTurn", "Let's meet on Monday at ten."));
  await s.settle();
  assert.deepEqual(server.messages.at(-1), { type: "fallback", reason: "cap", seconds: 1 });
  assert.deepEqual(server.closed, { code: 1000, reason: "fallback" });
  assert.equal(texts(server).length, 0);
  // The rest of the day is off, without asking Workers AI again.
  const status = await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`), s.rt);
  assert.deepEqual(await status.json(), { available: false });
  const runs = s.ai.runs.count;
  const next = await connect(s, "198.51.100.9");
  assert.deepEqual(next.server.messages, [{ type: "fallback", reason: "cap" }]);
  assert.equal(s.ai.runs.count, runs);
});

test("corrections: the model's neurons count toward the day's cap: from its token usage, or estimated", async () => {
  const s = setup({ ai: fakeAi("ok", (call) => (call.said === "One." ? { ...(typesOut(call) as object), usage: { prompt_tokens: 1000, completion_tokens: 100 } } : typesOut(call))) });
  const neurons = () => (s.sql.db.prepare("SELECT neurons FROM days").get() as { neurons: number } | undefined)?.neurons ?? 0;
  const { upstream } = await connect(s);
  await sayTurns(s, upstream, ["One."]);
  assert.ok(Math.abs(neurons() - (1000 * 26668 + 100 * 204805) / 1e6) < 1e-6, String(neurons()));
  const before = neurons();
  await sayTurns(s, upstream, ["Two."], 1);
  const call = s.ai.fixes[1];
  const prompt = call.inputs.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(Math.abs(neurons() - before - fixNeurons(null, prompt, "<text>One. Two.</text>".length)) < 1e-6);
});

test("corrections: a correction that takes the day past the cap ends the recording with cap", async () => {
  const s = setup({ ai: fakeAi("ok", (call) => ({ ...(typesOut(call) as object), usage: { prompt_tokens: 0, completion_tokens: 1_000_000 } })) });
  const { server, upstream } = await connect(s);
  await sayTurns(s, upstream, ["A long idea."]);
  upstream.emit("close");
  await s.settle();
  assert.deepEqual(server.messages.at(-1), { type: "fallback", reason: "cap" });
  assert.deepEqual(await (await handle(new Request(`https://sayfold.brightloopapps.com${STATUS_PATH}`), s.rt)).json(), { available: false });
});

test("corrections: after stop, the Worker waits for the last turn's correction before it closes, so the review gets it", async () => {
  let answer!: (v: unknown) => void;
  const s = setup({ ai: fakeAi("ok", () => new Promise((r) => (answer = r))) });
  const { server, upstream } = await connect(s);
  server.emit("message", audio(1));
  server.emit("message", STOP);
  upstream.emit("message", flux("EndOfTurn", "Let's meet on Monday at ten. No, Tuesday."));
  upstream.emit("close");
  await s.settle();
  assert.equal(server.closed, null, "closed before the correction came");
  mock.timers.tick(500);
  answer({ response: "<text>Let's meet on Tuesday at ten.</text>" });
  await s.settle();
  assert.deepEqual(server.messages.slice(-1), [{ type: "text", turn: 0, text: "Let's meet on Tuesday at ten." }]);
  assert.deepEqual(server.closed, { code: 1000, reason: "done" });
});

test("corrections: the wait after stop is bounded: a model that never answers leaves the plain text, then the close", async () => {
  const s = setup({ ai: fakeAi("ok", () => new Promise(() => {})) });
  const { server, upstream } = await connect(s);
  server.emit("message", STOP);
  upstream.emit("message", flux("EndOfTurn", "Call the plumber on Friday."));
  await s.settle();
  // Flux never closes either: the drain, then the correction's own timeout.
  mock.timers.tick(DRAIN_MS);
  await s.settle();
  assert.equal(server.closed, null);
  mock.timers.tick(FIX_TIMEOUT_MS - DRAIN_MS);
  await s.settle();
  assert.deepEqual(texts(server), [{ type: "text", turn: 0, text: "Call the plumber on Friday." }]);
  assert.deepEqual(server.closed, { code: 1000, reason: "done" });
});

test("corrections: with corrections queued behind a slow one, the close comes at most FIX_WAIT_MS after Flux's", async () => {
  const s = setup({ ai: fakeAi("ok", () => new Promise(() => {})) });
  const { server, upstream } = await connect(s);
  upstream.emit("message", flux("EndOfTurn", "Call the plumber.", 0));
  upstream.emit("message", flux("EndOfTurn", "On Friday.", 1));
  server.emit("message", STOP);
  upstream.emit("close");
  await s.settle();
  mock.timers.tick(FIX_WAIT_MS - 1);
  await s.settle();
  assert.equal(server.closed, null);
  mock.timers.tick(1);
  await s.settle();
  assert.deepEqual(server.closed, { code: 1000, reason: "done" });
  // Whatever came is the plain text; the page keeps every ended turn's words anyway.
  for (const m of texts(server)) assert.equal((m as { text: string }).text, "Call the plumber.");
  assert.ok(DRAIN_MS + FIX_WAIT_MS < STOP_WAIT_MS, "the page waits longer than the Worker can take");
});

test("corrections: a fallback once a turn has ended (the recording going idle, say) also waits for its correction, then says why", async () => {
  let answer!: (v: unknown) => void;
  const s = setup({ ai: fakeAi("ok", () => new Promise((r) => (answer = r))) });
  const { server, upstream } = await connect(s);
  server.emit("message", audio(1));
  upstream.emit("message", flux("EndOfTurn", "Remind me to call the dentist."));
  mock.timers.tick(IDLE_SECONDS * 1000);
  await s.settle();
  upstream.emit("close");
  await s.settle();
  assert.equal(server.closed, null);
  answer({ response: "<text>Remind me to call the dentist.</text>" });
  await s.settle();
  assert.deepEqual(server.messages.slice(-2), [
    { type: "text", turn: 0, text: "Remind me to call the dentist." },
    { type: "fallback", reason: "idle", seconds: 1 },
  ]);
});

test("corrections: when the page goes mid-correction, nothing more is sent, the text is dropped, and the neurons still count", async () => {
  let answer!: (v: unknown) => void;
  const s = setup({ ai: fakeAi("ok", () => new Promise((r) => (answer = r))) });
  const { server, upstream } = await connect(s);
  upstream.emit("message", flux("EndOfTurn", "Let's meet on Monday at ten."));
  await s.settle();
  server.emit("close");
  answer({ response: "<text>Let's meet on Monday at ten.</text>", usage: { prompt_tokens: 0, completion_tokens: 10_000 } });
  await s.settle();
  assert.deepEqual(texts(server), []);
  assert.ok(upstream.closed, "Flux closed");
  const day = s.sql.db.prepare("SELECT neurons FROM days").get() as { neurons: number };
  assert.ok(day.neurons >= 2048, String(day.neurons));
  // And the visitor's session is freed after it.
  assert.equal((await s.core.open("203.0.113.7")).ok, true);
});

// --- nothing is kept -------------------------------------------------------------------------

/** Checks the counter's database holds only its numbers, hashes and dates, and none of `needles`, even in its raw file. */
function nothingKept(db: ReturnType<typeof setup>["sql"]["db"], needles: string[]) {
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
  for (const needle of needles) assert.ok(!everything.includes(needle), `storage holds "${needle}"`);
}

const SECRET_TEXT = "Marigold zeppelin password seventeen";
/** What the correction model writes back, marked too: "seventeen" corrected to "eighteen". */
const SECRET_FIX = "Marigold zeppelin password eighteen";

/**
 * How the correction model answers in each privacy run: well, with junk that quotes the text, with an error that
 * quotes the prompt, too slowly, or with the day's refusal quoting it. Each run checks the text reached the model
 * (and, but for the refusal, came back to the page), and went nowhere else.
 */
const MODEL_PATHS: [string, (prompt: string) => unknown][] = [
  ["a good reply", () => ({ response: `<text>${SECRET_FIX}</text>`, usage: { prompt_tokens: 600, completion_tokens: 12 } })],
  ["junk", () => ({ response: `Sure! I changed it for you: <text>${SECRET_FIX}</text> (from "${SECRET_TEXT}")` })],
  ["an error quoting the prompt", (prompt) => new Error(`AiError: 5006: Invalid input: ${prompt}`)],
  ["no answer in time", () => new Promise(() => {})],
  ["the day's refusal, quoting the prompt", (prompt) => new Error(`${AI_ERRORS.quota} (input: ${prompt})`)],
];

for (const [path, answer] of MODEL_PATHS) {
  test(`privacy: audio, text and the correction model's prompt and reply (${path}) never reach storage, a log or any other request`, async (t) => {
    const spied = (["log", "info", "warn", "error", "debug", "trace", "dir", "table"] as const).map((m) => t.mock.method(console, m));
    const fetched = t.mock.method(globalThis, "fetch", async () => new Response(""));
    const s = setup({ ai: fakeAi("ok", (call) => answer(call.inputs.messages[1].content)) });
    const IP = "203.0.113.77";
    // "SAYFOLD-SECRET-AUDIO" as bytes, repeated: easy to spot anywhere it might land.
    const marker = [...new TextEncoder().encode("SAYFOLD-SECRET-AUDIO")];
    const { server, upstream } = await connect(s, IP);
    for (let i = 0; i < 4; i++) server.emit("message", audio(0.75, marker));
    upstream.emit("message", flux("Update", SECRET_TEXT.slice(0, 15)));
    upstream.emit("message", flux("EndOfTurn", SECRET_TEXT));
    await s.settle();
    mock.timers.tick(FIX_TIMEOUT_MS);
    await s.settle();
    server.emit("message", STOP);
    upstream.emit("close");
    await s.settle();
    assert.equal(upstream.bytes.length, 3 * BYTES_PER_SECOND, "the audio did reach Flux");
    assert.equal(s.ai.fixes.length, 1);
    assert.match(s.ai.fixes[0].inputs.messages[1].content, new RegExp(SECRET_TEXT), "the text did reach the model");
    const texts = server.messages.filter((m) => (m as { type: string }).type === "text");
    const refused = path.startsWith("the day's refusal");
    if (refused) assert.deepEqual(server.messages.at(-1), { type: "fallback", reason: "cap", seconds: 3 });
    else assert.deepEqual(texts, [{ type: "text", turn: 0, text: path === "a good reply" ? SECRET_FIX : SECRET_TEXT }], "the text did reach the page");

    for (const spy of spied) assert.equal(spy.mock.callCount(), 0, "nothing is logged at all");
    assert.equal(fetched.mock.callCount(), 0, "no other request is made");
    // Nothing the page is told, but the words themselves, carries the text: not a fallback, not a close reason.
    const told = server.sent.filter((m) => typeof m === "string" && !/"type":"(?:update|end-of-turn|text)"/.test(m)).join(" ") + JSON.stringify(server.closed);
    for (const needle of ["Marigold", "zeppelin", "TEXT:", "SAID:", "<text>"]) assert.ok(!told.includes(needle), `the page was told "${needle}" outside the text`);
    assert.ok(!JSON.stringify(upstream.sent.filter((m) => typeof m === "string")).includes("Marigold"), "the text went back to Flux");
    nothingKept(s.sql.db, [SECRET_TEXT, SECRET_FIX, "Marigold", "zeppelin", "SAYFOLD-SECRET-AUDIO", IP, "203.0.113", "TEXT:", "<text>"]);
  });
}

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

// --- connected time --------------------------------------------------------------------------

/** The seconds counted against the visitor today. */
const visitorSeconds = (s: ReturnType<typeof setup>) =>
  (s.sql.db.prepare("SELECT seconds FROM visitors").get() as { seconds: number } | undefined)?.seconds ?? 0;

test("idle: a recording that sends no audio is closed after the idle timeout, and its connected time is counted", async () => {
  assert.equal(IDLE_SECONDS, 10);
  const s = setup();
  const { server, upstream } = await connect(s);
  mock.timers.tick(IDLE_SECONDS * 1000 - 1);
  assert.deepEqual(upstream.messages, []);
  mock.timers.tick(1);
  assert.deepEqual(upstream.messages, [{ type: "CloseStream" }], "Flux is asked for its last words");
  upstream.emit("close");
  assert.deepEqual(server.messages, [{ type: "fallback", reason: "idle" }]);
  assert.deepEqual(server.closed, { code: 1000, reason: "fallback" });
  await s.settle();
  assert.equal(visitorSeconds(s), IDLE_SECONDS, "10 seconds connected, though no audio came");
  const neurons = (s.sql.db.prepare("SELECT neurons FROM days").get() as { neurons: number }).neurons;
  assert.ok(Math.abs(neurons - IDLE_SECONDS * NEURONS_PER_AUDIO_SECOND) < 1e-6, "and against the day's cap");
});

test("idle: audio keeps a recording open; a pause as long as the timeout closes it; empty frames don't count as audio", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  for (let t = 0; t < 30; t++) {
    server.emit("message", audio(0.1));
    mock.timers.tick(1000);
  }
  assert.deepEqual(upstream.messages, [], "still open after 30 seconds of slow audio");
  server.emit("message", audio(0.1)); // the last audio
  for (let t = 0; t < IDLE_SECONDS - 1; t++) {
    server.emit("message", new Uint8Array(0));
    server.emit("message", new ArrayBuffer(0));
    mock.timers.tick(1000);
  }
  assert.deepEqual(upstream.messages, []);
  mock.timers.tick(1000);
  assert.deepEqual(upstream.messages, [{ type: "CloseStream" }]);
  assert.equal(upstream.sent.filter((f) => typeof f !== "string" && f.length === 0).length, 0, "no empty frame reached Flux");
});

test("connected time: a slow recording counts the time it was connected, not just its audio", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  for (let t = 0; t < 30; t++) {
    server.emit("message", audio(0.1));
    mock.timers.tick(1000);
  }
  await s.settle();
  assert.ok(visitorSeconds(s) >= 29, `reported as it goes: ${visitorSeconds(s)}`);
  server.emit("message", STOP);
  upstream.emit("close");
  await s.settle();
  assert.equal(visitorSeconds(s), 30, "30 seconds connected, 3 of audio");
});

test("connected time: audio sent faster than real time still counts in full", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  for (let i = 0; i < 20; i++) server.emit("message", audio(1));
  mock.timers.tick(2000);
  server.emit("message", STOP);
  upstream.emit("close");
  await s.settle();
  assert.equal(visitorSeconds(s), 20);
});

test("connected time: the visitor's daily budget is spent by time connected, so reconnecting doesn't get round it", async () => {
  const s = setup();
  let sessions = 0;
  for (;;) {
    await handle(listenRequest(), s.rt);
    const server = s.servers.at(-1)!;
    const upstream = s.ai.calls.at(-1)?.upstream;
    if (server.messages.length) {
      assert.deepEqual(server.messages, [{ type: "fallback", reason: "visitor-limit" }]);
      break;
    }
    sessions++;
    mock.timers.tick(IDLE_SECONDS * 1000); // connect, say nothing, get closed
    upstream!.emit("close");
    await s.settle();
    assert.ok(sessions < 100, "reconnecting must run out");
  }
  assert.equal(sessions, VISITOR_SECONDS_PER_DAY / IDLE_SECONDS);
  assert.equal(visitorSeconds(s), VISITOR_SECONDS_PER_DAY);
});

test("connected time: a visitor with a minute left is stopped after a minute connected, audio or not", async () => {
  const s = setup();
  const first = await connect(s);
  for (let i = 0; i < 120; i++) first.server.emit("message", audio(1));
  await s.settle();
  first.upstream.emit("close");
  await s.settle();
  const { server, upstream } = await connect(s);
  for (let t = 0; t < 59; t++) {
    server.emit("message", audio(0.01));
    mock.timers.tick(1000);
  }
  await s.settle();
  assert.deepEqual(upstream.messages, []);
  server.emit("message", audio(0.01));
  mock.timers.tick(1000);
  await s.settle();
  assert.deepEqual(upstream.messages, [{ type: "CloseStream" }]);
  upstream.emit("close");
  assert.deepEqual(server.messages, [{ type: "fallback", reason: "visitor-limit", seconds: 0.6 }]);
});

test("connected time: near the day's cap, a slow recording is stopped by the time it holds Flux", async () => {
  const s = setup();
  await nearlyCap(s, 5);
  const { server, upstream } = await connect(s, "198.51.100.1");
  for (let t = 0; t < 10 && upstream.messages.length === 0; t++) {
    server.emit("message", audio(0.01));
    mock.timers.tick(1000);
    await s.settle();
  }
  assert.deepEqual(upstream.messages, [{ type: "CloseStream" }]);
  upstream.emit("close");
  const [m] = server.messages as { type: string; reason: string; seconds: number }[];
  assert.deepEqual({ ...m, seconds: undefined }, { type: "fallback", reason: "cap", seconds: undefined });
  assert.equal(m.seconds, upstream.bytes.length / BYTES_PER_SECOND);
});

// --- frames -----------------------------------------------------------------------------------

test("frames: only whole 16-bit samples reach Flux; an odd last byte is dropped, never forwarded or split", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  server.emit("message", new Uint8Array([1]));
  server.emit("message", new Uint8Array([1, 2, 3]));
  server.emit("message", new Uint8Array([4, 5, 6, 7, 8]).subarray(1));
  assert.deepEqual(upstream.bytes, new Uint8Array([1, 2, 5, 6, 7, 8]));
  for (const f of upstream.sent) assert.ok(typeof f === "string" || f.length % 2 === 0, `a frame of ${f.length} bytes`);
});

test("frames: at the session's limit, the last frame is cut to whole samples too", async () => {
  const s = setup();
  const { server, upstream } = await connect(s);
  const odd = audio(0.5).subarray(1); // 15,999 bytes
  for (let i = 0; i < SESSION_MAX_SECONDS * 2 + 10; i++) server.emit("message", odd);
  await s.settle();
  assert.ok(upstream.bytes.length <= SESSION_MAX_SECONDS * BYTES_PER_SECOND);
  for (const f of upstream.sent) assert.ok(typeof f === "string" || f.length % 2 === 0, `a frame of ${f.length} bytes`);
  assert.equal(upstream.bytes.length % 2, 0);
});

test("listen: only a GET can open the WebSocket", async () => {
  const s = setup();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await handle(listenRequest({ method }), s.rt);
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET");
  }
  assert.equal(s.servers.length, 0);
  assert.equal(s.ai.runs.count, 0);
  assert.equal((await handle(listenRequest(), s.rt)).status, 101);
});

// --- the smoke test ---------------------------------------------------------------------------

test("smoke: lab.json checks the status endpoint, and a plain GET of every smoke path is a 200 that opens nothing", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const lab = JSON.parse(readFileSync(join(import.meta.dirname, "../../lab.json"), "utf8")) as { smoke: string[] };
  assert.ok(lab.smoke.includes("/"));
  assert.ok(lab.smoke.includes(STATUS_PATH));
  assert.ok(!lab.smoke.includes(LISTEN_PATH));
  const s = setup();
  for (const path of lab.smoke) {
    // As nightshift/bin/smoke.ts sends it: fetch(url, { redirect: "follow" }), no upgrade or origin.
    const res = await handle(new Request(`https://sayfold.erko-erka1.workers.dev${path}`, { redirect: "follow" }), s.rt);
    assert.equal(res.status, 200, path);
  }
  assert.equal(s.servers.length, 0, "no WebSocket");
  assert.equal(s.ai.runs.count, 0, "no Workers AI");
});

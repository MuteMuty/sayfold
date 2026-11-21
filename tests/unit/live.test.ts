// The page's side of live text (src/core/live.ts, lab#109): the status check, the audio frames, the running
// text and every way the server can't be used. The WebSocket is a stand-in: nothing here reaches the Worker
// or Workers AI.
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_SAMPLES, LiveSession, LiveText, OPEN_WAIT_MS, STOP_WAIT_MS, fallbackNote, joinText, liveStatus, toPcm16, type SocketLike,
} from "../../src/core/live.ts";
import { parseServerMessage, type FallbackReason } from "../../src/listen/protocol.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

/** The browser's WebSocket, as far as LiveSession uses it. */
class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  closedBy: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | ArrayBuffer) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedBy ??= code;
    this.readyState = 3;
  }
  // As the server would:
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  hangUp() {
    this.readyState = 3;
    this.onclose?.();
  }
  fail() {
    this.onerror?.();
    this.hangUp();
  }
  get frames() {
    return this.sent.filter((m): m is ArrayBuffer => typeof m !== "string");
  }
  get texts() {
    return this.sent.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m));
  }
}

function session() {
  const ws = new FakeSocket();
  const seen = { text: [] as string[], fallbacks: [] as FallbackReason[] };
  const live = new LiveSession(() => ws, {
    text: (t) => seen.text.push(t.map((p) => (p.done ? p.text : `[${p.text}]`)).join(" ")),
    fallback: (e) => seen.fallbacks.push(e.reason!),
  });
  return { ws, live, seen };
}
/** `seconds` of 16 kHz audio at a steady level. */
const tone = (seconds: number, v = 0.25) => new Float32Array(Math.round(seconds * 16000)).fill(v);

// --- pieces ---------------------------------------------------------------------------------

test("frames: 80 ms each, of 16-bit little-endian samples, clipped to range", () => {
  assert.equal(FRAME_SAMPLES, 1280);
  const pcm = new DataView(toPcm16(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2])));
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((i) => pcm.getInt16(i * 2, true)), [0, 16384, -16384, 32767, -32768, 32767, -32768]);
});

test("the server's messages are checked before they're used", () => {
  assert.deepEqual(parseServerMessage('{"type":"update","turn":0,"text":"Water"}'), { type: "update", turn: 0, text: "Water" });
  assert.deepEqual(parseServerMessage('{"type":"end-of-turn","turn":2,"text":"Done."}'), { type: "end-of-turn", turn: 2, text: "Done." });
  assert.deepEqual(parseServerMessage('{"type":"fallback","reason":"cap"}'), { type: "fallback", reason: "cap" });
  assert.deepEqual(parseServerMessage('{"type":"fallback","reason":"idle","seconds":2.5}'), { type: "fallback", reason: "idle", seconds: 2.5 });
  for (const bad of ["", "x", "null", "[]", '{"type":"update","turn":"0","text":"x"}', '{"type":"update","turn":0}', '{"type":"fallback","reason":"tired"}',
    '{"type":"fallback","reason":"cap","seconds":-1}', '{"type":"hello"}']) {
    assert.equal(parseServerMessage(bad), null, bad);
  }
  assert.equal(parseServerMessage(new ArrayBuffer(2)), null);
});

test("the running text: ended turns, then the latest update of the turn being spoken, which replaces the last", () => {
  const t = new LiveText();
  t.receive({ type: "update", turn: 0, text: "Water" });
  t.receive({ type: "update", turn: 0, text: "Water the tomatoes" });
  assert.equal(t.text, "Water the tomatoes");
  t.receive({ type: "end-of-turn", turn: 0, text: "Water the tomatoes every morning." });
  t.receive({ type: "update", turn: 1, text: "And call" });
  assert.deepEqual(t.parts, [{ text: "Water the tomatoes every morning.", done: true }, { text: "And call", done: false }]);
  assert.equal(t.text, "Water the tomatoes every morning. And call");
  // A late update for a turn that has ended doesn't undo it; an empty turn adds nothing.
  t.receive({ type: "update", turn: 0, text: "Water" });
  t.receive({ type: "update", turn: 2, text: "" });
  assert.equal(t.text, "Water the tomatoes every morning. And call");
});

test("joining the live text and the in-browser model's text", () => {
  assert.equal(joinText("Water the tomatoes.", " And call the plumber. "), "Water the tomatoes. And call the plumber.");
  // Mid-sentence, the in-browser model's capital goes (it starts every part with one), but not a name's or "I"'s.
  assert.equal(joinText("Water the tomatoes every morning,", "And call the plumber."), "Water the tomatoes every morning, and call the plumber.");
  assert.equal(joinText("Water the tomatoes and", "Then call."), "Water the tomatoes and then call.");
  assert.equal(joinText("Water the tomatoes,", "I think."), "Water the tomatoes, I think.");
  assert.equal(joinText("Ask", "NASA first."), "Ask NASA first.");
  assert.equal(joinText("Is it done?", "Yes."), "Is it done? Yes.");
  assert.equal(joinText("", "Call the plumber."), "Call the plumber.");
  assert.equal(joinText(" Water. ", ""), "Water.");
});

test("notes: a short plain line for each reason, saying what happens next", () => {
  const reasons: FallbackReason[] = ["cap", "visitor-limit", "busy", "session-limit", "idle", "error"];
  for (const r of reasons) {
    for (const partial of [true, false]) {
      const n = fallbackNote(r, partial);
      assert.match(n, partial ? /so the rest is turned into text on this device\.$/ : /so it's turned into text on this device\.$/, n);
      assert.ok(n.length < 110, n);
    }
  }
  assert.match(fallbackNote("cap", false), /^Live text is used up for today/);
  assert.match(fallbackNote("visitor-limit", true), /^You've used your live text for today/);
  assert.match(fallbackNote("busy", false), /another tab/);
});

// --- the status -------------------------------------------------------------------------------

test("status: available only when the server says so, in time", async () => {
  const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  assert.equal(await liveStatus(answer({ available: true })), true);
  assert.equal(await liveStatus(answer({ available: false })), false);
  assert.equal(await liveStatus(answer({ available: "yes" })), false);
  assert.equal(await liveStatus(answer({ available: true }, 500)), false);
  assert.equal(await liveStatus(async () => new Response("<html>", { status: 200 })), false);
  assert.equal(await liveStatus(async () => { throw new TypeError("Failed to fetch"); }), false);
  let asked = "";
  await liveStatus(async (url, init) => ((asked = `${url} ${init?.cache}`), new Response('{"available":true}')));
  assert.equal(asked, "/api/listen/status no-store");
  // No answer in time: the in-browser model, and the late answer is ignored.
  const slow = liveStatus(() => new Promise(() => {}));
  mock.timers.tick(3000);
  assert.equal(await slow, false);
});

// --- a recording ---------------------------------------------------------------------------------

test("live: audio is sent in 80 ms frames, silence included, from the start of the recording, with what came before the socket opened", async () => {
  const { ws, live } = session();
  live.push(tone(0.05, 0));
  live.push(tone(0.2, 0)); // silence is sent too
  assert.equal(ws.frames.length, 0, "nothing before the socket is open");
  ws.open();
  assert.equal(ws.binaryType, "arraybuffer");
  live.push(tone(0.33));
  assert.ok(ws.frames.every((f) => f.byteLength === FRAME_SAMPLES * 2), "whole frames only");
  assert.equal(ws.frames.length, Math.floor((0.58 * 16000) / FRAME_SAMPLES));
  const first = new DataView(ws.frames[0]!);
  assert.equal(first.getInt16(0, true), 0);
  const end = live.finish();
  // The rest goes before stop, then stop.
  assert.equal(ws.frames.reduce((n, f) => n + f.byteLength, 0), Math.round(0.58 * 16000) * 2);
  assert.deepEqual(ws.texts, [{ type: "stop" }]);
  assert.equal(ws.sent.at(-1), JSON.stringify({ type: "stop" }));
  ws.hangUp();
  assert.deepEqual(await end, { text: "", from: null, reason: null });
});

test("live: words show as they come; stop waits for the close and keeps the last unfinished update as that turn's text", async () => {
  const { ws, live, seen } = session();
  ws.open();
  live.push(tone(1));
  ws.say({ type: "update", turn: 0, text: "New idea." });
  ws.say({ type: "end-of-turn", turn: 0, text: "New idea." });
  live.push(tone(1));
  ws.say({ type: "update", turn: 1, text: "Water the" });
  ws.say({ type: "update", turn: 1, text: "Water the tomatoes" });
  assert.deepEqual(seen.text, ["[New idea.]", "New idea.", "New idea. [Water the]", "New idea. [Water the tomatoes]"]);
  let done = false;
  const end = live.finish().then((r) => ((done = true), r));
  ws.say({ type: "update", turn: 1, text: "Water the tomatoes every morning" });
  await Promise.resolve();
  assert.equal(done, false, "the text isn't final until the socket closes");
  ws.hangUp();
  assert.deepEqual(await end, { text: "New idea. Water the tomatoes every morning", from: null, reason: null });
  assert.deepEqual(seen.fallbacks, []);
});

test("live: a fallback in the middle keeps the text so far, stops sending, and the in-browser model takes over from the audio the server took", async () => {
  const { ws, live, seen } = session();
  ws.open();
  live.push(tone(2));
  ws.say({ type: "end-of-turn", turn: 0, text: "Water the tomatoes." });
  live.push(tone(1));
  ws.say({ type: "update", turn: 1, text: "And call" });
  live.push(tone(0.5));
  // The server stopped taking audio at 3.2 s, and Flux's last words for it came while it waited for them.
  ws.say({ type: "update", turn: 1, text: "And call the" });
  ws.say({ type: "fallback", reason: "visitor-limit", seconds: 3.2 });
  ws.hangUp();
  assert.deepEqual(seen.fallbacks, ["visitor-limit"]);
  const sent = ws.frames.length;
  live.push(tone(2));
  assert.equal(ws.frames.length, sent, "no audio after the fallback");
  assert.deepEqual(await live.finish(), { text: "Water the tomatoes. And call the", from: 3.2, reason: "visitor-limit" });
});

test("live: the in-browser model starts no later than the last words that came, so nothing said after them is lost", async () => {
  // The server took 3 s, but its last words came at 2 s of audio: whatever was said after them is unheard.
  const { ws, live } = session();
  ws.open();
  live.push(tone(2));
  ws.say({ type: "update", turn: 0, text: "Water the" });
  live.push(tone(1));
  ws.say({ type: "fallback", reason: "error", seconds: 3 });
  ws.hangUp();
  assert.deepEqual(await live.finish(), { text: "Water the", from: 2, reason: "error" });
});

for (const reason of ["cap", "visitor-limit", "busy", "session-limit", "idle", "error"] as const) {
  test(`live: the server refusing at the start (${reason}) means the whole recording goes to the in-browser model`, async () => {
    const { ws, live, seen } = session();
    live.push(tone(0.5));
    ws.open();
    ws.say({ type: "fallback", reason });
    ws.hangUp();
    live.push(tone(1));
    assert.deepEqual(seen.fallbacks, [reason]);
    assert.deepEqual(await live.finish(), { text: "", from: 0, reason });
    assert.deepEqual(ws.texts, [], "no stop for a socket that has closed");
  });
}

test("live: a socket that won't open falls back at once, with nothing sent", async () => {
  const { ws, live, seen } = session();
  live.push(tone(0.5));
  ws.fail();
  assert.deepEqual(seen.fallbacks, ["error"]);
  live.push(tone(1));
  assert.deepEqual(await live.finish(), { text: "", from: 0, reason: "error" });
  assert.equal(ws.sent.length, 0);
});

test("live: a socket that doesn't open in time is given up on, and closed", async () => {
  const { ws, live, seen } = session();
  live.push(tone(0.5));
  mock.timers.tick(OPEN_WAIT_MS - 1);
  assert.deepEqual(seen.fallbacks, []);
  mock.timers.tick(1);
  assert.deepEqual(seen.fallbacks, ["error"]);
  assert.ok(ws.closedBy !== null);
  ws.open(); // too late
  assert.equal(ws.sent.length, 0);
  assert.deepEqual(await live.finish(), { text: "", from: 0, reason: "error" });
});

test("live: stop before the socket opens still sends everything, then stop", async () => {
  const { ws, live } = session();
  live.push(tone(0.3));
  const end = live.finish();
  ws.open();
  assert.equal(ws.frames.reduce((n, f) => n + f.byteLength, 0), Math.round(0.3 * 16000) * 2);
  assert.deepEqual(ws.texts, [{ type: "stop" }]);
  ws.say({ type: "end-of-turn", turn: 0, text: "Hi." });
  ws.hangUp();
  assert.deepEqual(await end, { text: "Hi.", from: null, reason: null });
});

test("live: the connection dropping mid-recording keeps the text, and the in-browser model takes over after the last words", async () => {
  const { ws, live, seen } = session();
  ws.open();
  live.push(tone(1.5));
  ws.say({ type: "update", turn: 0, text: "Water" });
  live.push(tone(1));
  ws.hangUp();
  assert.deepEqual(seen.fallbacks, ["error"]);
  assert.deepEqual(await live.finish(), { text: "Water", from: 1.5, reason: "error" });
});

test("live: no close after stop in time: the text so far is kept, and anything after the last words goes to the in-browser model", async () => {
  const { ws, live } = session();
  ws.open();
  live.push(tone(2));
  ws.say({ type: "update", turn: 0, text: "Water the tomatoes" });
  live.push(tone(1));
  const end = live.finish();
  mock.timers.tick(STOP_WAIT_MS);
  assert.ok(ws.closedBy !== null);
  assert.deepEqual(await end, { text: "Water the tomatoes", from: 2, reason: "error" });
});

test("live: a send that throws (the socket closing under it) is a fallback, not an exception", async () => {
  const { ws, live, seen } = session();
  ws.open();
  live.push(tone(0.5));
  ws.send = () => { throw new Error("closed"); };
  live.push(tone(0.5));
  assert.deepEqual(seen.fallbacks, ["error"]);
  assert.deepEqual(await live.finish(), { text: "", from: 0, reason: "error" });
});

test("live: finish twice gives the same answer", async () => {
  const { ws, live } = session();
  ws.open();
  const a = live.finish();
  ws.hangUp();
  assert.deepEqual(await a, await live.finish());
});

test("live: a socket the browser refuses to make (a policy, say) falls back, just after the session is made", async () => {
  const fallbacks: (string | null)[] = [];
  const live = new LiveSession(() => { throw new DOMException("Refused", "SecurityError"); }, { text: () => {}, fallback: (e) => fallbacks.push(e.reason) });
  assert.deepEqual(fallbacks, [], "not while it's being made, so the page can hold on to it first");
  live.push(tone(0.5));
  await Promise.resolve();
  assert.deepEqual(fallbacks, ["error"]);
  assert.deepEqual(await live.finish(), { text: "", from: 0, reason: "error" });
});

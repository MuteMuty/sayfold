// The page's side of live text (src/core/live.ts, lab#109): the status check, the audio frames, the running
// text and every way the server can't be used. The WebSocket is a stand-in: nothing here reaches the Worker
// or Workers AI.
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_SAMPLES, LAG_MARGIN, LiveSession, LiveText, OPEN_WAIT_MS, STOP_WAIT_MS, fallbackNote, joinText, liveStatus, promiseLine, toPcm16, type SocketLike,
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
  assert.deepEqual(parseServerMessage('{"type":"text","turn":1,"text":"Shopping list:\\n- Milk"}'), { type: "text", turn: 1, text: "Shopping list:\n- Milk" });
  assert.deepEqual(parseServerMessage('{"type":"fallback","reason":"cap"}'), { type: "fallback", reason: "cap" });
  assert.deepEqual(parseServerMessage('{"type":"fallback","reason":"idle","seconds":2.5}'), { type: "fallback", reason: "idle", seconds: 2.5 });
  for (const bad of ["", "x", "null", "[]", '{"type":"update","turn":"0","text":"x"}', '{"type":"update","turn":0}', '{"type":"fallback","reason":"tired"}',
    '{"type":"fallback","reason":"cap","seconds":-1}', '{"type":"hello"}', '{"type":"text","turn":0}', '{"type":"text","turn":0.5,"text":"x"}']) {
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

test("spoken corrections: the corrected text replaces every turn up to its own, and later turns follow it", () => {
  const t = new LiveText();
  t.receive({ type: "end-of-turn", turn: 0, text: "Let's meet on Monday at ten." });
  t.receive({ type: "end-of-turn", turn: 1, text: "No, Tuesday." });
  t.receive({ type: "update", turn: 2, text: "Bring the" });
  assert.equal(t.text, "Let's meet on Monday at ten. No, Tuesday. Bring the");
  t.receive({ type: "text", turn: 0, text: "Let's meet on Monday at ten." });
  assert.equal(t.text, "Let's meet on Monday at ten. No, Tuesday. Bring the");
  t.receive({ type: "text", turn: 1, text: "Let's meet on Tuesday at ten." });
  assert.deepEqual(t.parts, [{ text: "Let's meet on Tuesday at ten.", done: true }, { text: "Bring the", done: false }]);
  assert.equal(t.text, "Let's meet on Tuesday at ten. Bring the");
  // An older correction arriving late doesn't undo a newer one; neither does a late end of a corrected turn.
  t.receive({ type: "text", turn: 0, text: "Let's meet on Monday at ten." });
  t.receive({ type: "end-of-turn", turn: 1, text: "No, Tuesday." });
  assert.equal(t.text, "Let's meet on Tuesday at ten. Bring the");
});

test("spoken corrections: \"scratch that\" can leave nothing, and a spoken list's lines stay lines, with the next turn on a line of its own", () => {
  const t = new LiveText();
  t.receive({ type: "end-of-turn", turn: 0, text: "Add a dark mode." });
  t.receive({ type: "end-of-turn", turn: 1, text: "Delete that." });
  t.receive({ type: "text", turn: 1, text: "" });
  assert.deepEqual(t.parts, []);
  t.receive({ type: "end-of-turn", turn: 2, text: "Shopping list: milk, bread, eggs and butter." });
  t.receive({ type: "text", turn: 2, text: "Shopping list:\n- Milk\n- Bread\n- Eggs\n- Butter" });
  t.receive({ type: "update", turn: 3, text: "Then call the bank." });
  assert.equal(t.text, "Shopping list:\n- Milk\n- Bread\n- Eggs\n- Butter\nThen call the bank.");
});

test("a bare \"-\" line at the end of the corrected text is dropped before the next turn, so the turn isn't a list item", () => {
  const t = new LiveText();
  t.receive({ type: "end-of-turn", turn: 0, text: "Shopping list: milk." });
  t.receive({ type: "text", turn: 0, text: "Shopping list:\n- Milk\n-" });
  t.receive({ type: "end-of-turn", turn: 1, text: "Then call the bank." });
  assert.equal(t.text, "Shopping list:\n- Milk\nThen call the bank.");
  // The same when the in-browser model takes over after it.
  assert.equal(joinText("Shopping list:\n- Milk\n- ", "Then call the bank."), "Shopping list:\n- Milk\nThen call the bank.");
  assert.equal(joinText("Shopping list:\n- Milk\n- .", "Then call the bank."), "Shopping list:\n- Milk\nThen call the bank.");
});

test("empty text: words heard and then all scratched are told apart from silence", () => {
  // "Buy milk." then "Scratch that.": the correction model rightly sends empty text.
  const t = new LiveText();
  assert.equal(t.scratched, false, "nothing yet");
  t.receive({ type: "update", turn: 0, text: "Buy" });
  t.receive({ type: "end-of-turn", turn: 0, text: "Buy milk." });
  t.receive({ type: "text", turn: 0, text: "Buy milk." });
  assert.equal(t.scratched, false, "words on screen");
  t.receive({ type: "end-of-turn", turn: 1, text: "Scratch that." });
  t.receive({ type: "text", turn: 1, text: "" });
  assert.equal(t.text, "");
  assert.equal(t.scratched, true);
  // Words said after it are no longer scratched.
  t.receive({ type: "update", turn: 2, text: "Buy bread" });
  assert.equal(t.scratched, false);

  // "Buy milk scratch that." in one breath: one turn, and its correction is empty.
  const breath = new LiveText();
  breath.receive({ type: "end-of-turn", turn: 0, text: "Buy milk scratch that." });
  breath.receive({ type: "text", turn: 0, text: "" });
  assert.equal(breath.scratched, true);

  // Real silence: no words at all, or turns that ended empty, and no correction. That's not "scratched".
  const silence = new LiveText();
  assert.equal(silence.scratched, false);
  silence.receive({ type: "update", turn: 0, text: "" });
  silence.receive({ type: "end-of-turn", turn: 0, text: "  " });
  assert.equal(silence.text, "");
  assert.equal(silence.scratched, false);
  // A correction of nothing to nothing isn't a scratch either.
  silence.receive({ type: "text", turn: 0, text: "" });
  assert.equal(silence.scratched, false);
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
  // After a spoken list, the rest starts on a line of its own, with its capital.
  assert.equal(joinText("Shopping list:\n- Milk\n- Bread", "Then call the bank."), "Shopping list:\n- Milk\n- Bread\nThen call the bank.");
});

test("joining: words the in-browser model heard again where the live text ended show once", () => {
  // The model starts a little before the last words came (LAG_MARGIN), so its first words may repeat the live text's last.
  assert.equal(joinText("New idea. Water the", "The tomatoes every morning, and call the plumber on Friday."), "New idea. Water the tomatoes every morning, and call the plumber on Friday.");
  assert.equal(joinText("New idea. Water the", "Water the tomatoes every morning."), "New idea. Water the tomatoes every morning.");
  // Case and punctuation don't matter, and the live text's own stays.
  assert.equal(joinText("Water the tomatoes every morning,", "Morning. And call the plumber."), "Water the tomatoes every morning, and call the plumber.");
  // A cut-off word where the model's audio starts (part of "Water") is dropped with the repeat after it.
  assert.equal(joinText("New idea. Water the", "Ter the tomatoes."), "New idea. Water the tomatoes.");
  assert.equal(joinText("Water the tomatoes", "Ter the tomatoes every morning."), "Water the tomatoes every morning.");
  // All of it heard already: nothing is added.
  assert.equal(joinText("Call the plumber on Friday.", "On Friday."), "Call the plumber on Friday.");
  // No repeat, nothing dropped.
  assert.equal(joinText("Water the tomatoes", "Every morning."), "Water the tomatoes every morning.");
  assert.equal(joinText("I went to the", "Store and the bank."), "I went to the store and the bank.");
  assert.equal(joinText("Water the tomatoes.", "Then the plumber."), "Water the tomatoes. Then the plumber.");
  assert.equal(joinText("", "The plumber."), "The plumber.");
});

test("joining on an exact start: the in-browser model's audio begins where the server's ended, so a word said twice stays twice", () => {
  // The server said how much audio it took, and its words cover it: nothing is heard twice, so nothing is dropped.
  assert.equal(joinText("The soup was very", "Very good.", true), "The soup was very very good.");
  assert.equal(joinText("And then I said no", "No, thank you.", true), "And then I said no no, thank you.");
  assert.equal(joinText("Go go", "Go.", true), "Go go go.");
  // The capital mid-sentence still goes, and a sentence's end still keeps it.
  assert.equal(joinText("Water the tomatoes every morning,", "And call the plumber.", true), "Water the tomatoes every morning, and call the plumber.");
  assert.equal(joinText("The soup was very good.", "Very good.", true), "The soup was very good. Very good.");
  assert.equal(joinText("", "Very good.", true), "Very good.");
});

test("joining on a margin start: the words re-heard show once, and a repeat said before the margin stays", () => {
  // The connection went after "The soup was very": the model, a margin earlier, heard "was very" again.
  assert.equal(joinText("The soup was very", "Was very very good.", false), "The soup was very very good.");
  assert.equal(joinText("The soup was very", "Very very good."), "The soup was very very good.");
});

test("the line under the button: on this device only for a recording that really stays on it", () => {
  const send = /^Your words go to your own GitHub repo only when you press Send\.$/;
  const tail = (s: string) => s.slice(s.indexOf("Your words"));
  const live = promiseLine(true, false);
  assert.equal(live, "What you say is sent to Sayfold's server to be turned into text and edited as you ask, and isn't kept. Your words go to your own GitHub repo only when you press Send.");
  assert.equal(promiseLine(null, false), live, "the status hasn't answered: the page may yet use the server");
  assert.equal(promiseLine(true, true), live);
  const off = promiseLine(false, false);
  assert.equal(off, "Live text is off right now, so speech is turned into text on this device and stays on it. Your words go to your own GitHub repo only when you press Send.");
  // Live text went off during a recording that was (partly) sent: that recording is never said to have stayed here.
  const after = promiseLine(false, true);
  assert.equal(after, "Part or all of this recording was sent to Sayfold's server to be turned into text, and isn't kept. Live text is off now, so the next one stays on this device. Your words go to your own GitHub repo only when you press Send.");
  for (const l of [live, off, after]) assert.match(tail(l), send);
  assert.doesNotMatch(after.slice(0, after.indexOf("Live text is off")), /on this device|stays/);
});

test("notes: a short plain line for each reason, saying what happens next", () => {
  const reasons: FallbackReason[] = ["cap", "visitor-limit", "busy", "session-limit", "idle", "error"];
  for (const r of reasons) {
    for (const partial of [true, false]) {
      const n = fallbackNote(r, partial, false);
      assert.match(n, partial ? /so the rest is turned into text on this device\.$/ : /so it's turned into text on this device\.$/, n);
      assert.ok(n.length < 110, n);
    }
    // Audio went to the server, but the in-browser model starts over from the beginning: never said as if none left.
    const sent = fallbackNote(r, false, true);
    assert.match(sent, /, so it's turned into text on this device, from the start\.$/, sent);
    assert.ok(sent.length < 110, sent);
    assert.equal(fallbackNote(r, true, true), fallbackNote(r, true, false));
  }
  assert.match(fallbackNote("cap", false, false), /^Live text is used up for today/);
  assert.match(fallbackNote("visitor-limit", true, true), /^You've used your live text for today/);
  assert.match(fallbackNote("busy", false, true), /another tab/);
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
  assert.deepEqual(await end, { text: "", from: null, exact: true, reason: null });
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
  assert.deepEqual(await end, { text: "New idea. Water the tomatoes every morning", from: null, exact: true, reason: null });
  assert.deepEqual(seen.fallbacks, []);
});

test("live: a correction replaces the words on screen, and stop waits for the close, keeping the corrected text", async () => {
  const { ws, live, seen } = session();
  ws.open();
  live.push(tone(1));
  ws.say({ type: "end-of-turn", turn: 0, text: "Let's meet on Monday at ten." });
  ws.say({ type: "text", turn: 0, text: "Let's meet on Monday at ten." });
  live.push(tone(1));
  ws.say({ type: "end-of-turn", turn: 1, text: "No, Tuesday." });
  const end = live.finish();
  // The correction of the last turn comes after stop, before the close.
  ws.say({ type: "text", turn: 1, text: "Let's meet on Tuesday at ten." });
  ws.hangUp();
  assert.deepEqual(seen.text, [
    "Let's meet on Monday at ten.",
    "Let's meet on Monday at ten.",
    "Let's meet on Monday at ten. No, Tuesday.",
    "Let's meet on Tuesday at ten.",
  ]);
  assert.deepEqual(await end, { text: "Let's meet on Tuesday at ten.", from: null, exact: true, reason: null });
});

test("live: a recording whose words were all scratched says so; silence doesn't", async () => {
  const { ws, live } = session();
  ws.open();
  live.push(tone(1));
  ws.say({ type: "end-of-turn", turn: 0, text: "Buy milk." });
  ws.say({ type: "text", turn: 0, text: "Buy milk." });
  live.push(tone(1));
  ws.say({ type: "end-of-turn", turn: 1, text: "Scratch that." });
  const end = live.finish();
  ws.say({ type: "text", turn: 1, text: "" });
  ws.hangUp();
  assert.deepEqual(await end, { text: "", from: null, exact: true, reason: null });
  assert.equal(live.scratched, true);

  const quiet = session();
  quiet.ws.open();
  quiet.live.push(tone(2, 0));
  const ended = quiet.live.finish();
  quiet.ws.hangUp();
  assert.deepEqual(await ended, { text: "", from: null, exact: true, reason: null });
  assert.equal(quiet.live.scratched, false);
});

test("live: a correction isn't new words: where the in-browser model takes over still follows the last words", async () => {
  const { ws, live } = session();
  ws.open();
  live.push(tone(2));
  ws.say({ type: "end-of-turn", turn: 0, text: "Water the tomatoes." });
  live.push(tone(2));
  // The correction comes 2 s of audio after the words it's about; then the connection drops.
  ws.say({ type: "text", turn: 0, text: "Water the tomatoes." });
  ws.hangUp();
  assert.deepEqual(await live.finish(), { text: "Water the tomatoes.", from: 2 - LAG_MARGIN, exact: false, reason: "error" });
});

test("live: after stop, the page waits longer than the server can take to send its last words and correction", () => {
  assert.ok(STOP_WAIT_MS >= 8000, String(STOP_WAIT_MS));
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
  assert.deepEqual(await live.finish(), { text: "Water the tomatoes. And call the", from: 3.2, exact: true, reason: "visitor-limit" });
});

test("live: when the server took more audio than its last words cover, the in-browser model starts a margin before them", async () => {
  // The server took 3 s, but its last words came at 2 s of audio: whatever was said after them may be unheard,
  // and 2 s may be the middle of a word, so the model starts a margin earlier and joinText drops what both heard.
  const { ws, live } = session();
  ws.open();
  live.push(tone(2));
  ws.say({ type: "update", turn: 0, text: "Water the" });
  live.push(tone(1));
  ws.say({ type: "fallback", reason: "error", seconds: 3 });
  ws.hangUp();
  assert.deepEqual(await live.finish(), { text: "Water the", from: 2 - LAG_MARGIN, exact: false, reason: "error" });
});

test("live: a fallback whose seconds the last words cover starts exactly there", async () => {
  // Flux's last words for the audio came while the server drained it, just before the fallback.
  const { ws, live } = session();
  ws.open();
  live.push(tone(1.4));
  ws.say({ type: "update", turn: 0, text: "The soup was very" });
  ws.say({ type: "fallback", reason: "error", seconds: 1.3 });
  ws.hangUp();
  assert.deepEqual(await live.finish(), { text: "The soup was very", from: 1.3, exact: true, reason: "error" });
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
    assert.deepEqual(await live.finish(), { text: "", from: 0, exact: false, reason });
    assert.deepEqual(ws.texts, [], "no stop for a socket that has closed");
  });
}

test("live: a socket that won't open falls back at once, with nothing sent", async () => {
  const { ws, live, seen } = session();
  live.push(tone(0.5));
  ws.fail();
  assert.deepEqual(seen.fallbacks, ["error"]);
  live.push(tone(1));
  assert.deepEqual(await live.finish(), { text: "", from: 0, exact: false, reason: "error" });
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
  assert.deepEqual(await live.finish(), { text: "", from: 0, exact: false, reason: "error" });
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
  assert.deepEqual(await end, { text: "Hi.", from: null, exact: true, reason: null });
});

test("live: the connection dropping mid-recording keeps the text, and the in-browser model takes over a margin before the last words came", async () => {
  // The words lag the audio: "Water the" came at 2.5 s, but "tomatoes" may have been said before then.
  assert.ok(LAG_MARGIN >= 0.5 && LAG_MARGIN <= 1, `${LAG_MARGIN}`);
  const { ws, live, seen } = session();
  ws.open();
  live.push(tone(1.5));
  ws.say({ type: "update", turn: 0, text: "Water" });
  live.push(tone(1));
  ws.say({ type: "update", turn: 0, text: "Water the" });
  live.push(tone(1));
  ws.hangUp();
  assert.deepEqual(seen.fallbacks, ["error"]);
  assert.deepEqual(await live.finish(), { text: "Water the", from: 2.5 - LAG_MARGIN, exact: false, reason: "error" });
});

test("live: a drop soon after the start gives the in-browser model all of the recording", async () => {
  const { ws, live } = session();
  ws.open();
  live.push(tone(0.4));
  ws.say({ type: "update", turn: 0, text: "New" });
  live.push(tone(1));
  ws.fail();
  assert.deepEqual(await live.finish(), { text: "New", from: 0, exact: false, reason: "error" });
});

test("live: a fallback that doesn't say how much the server took starts a margin before the last words, not from the start", async () => {
  const { ws, live } = session();
  ws.open();
  live.push(tone(2));
  ws.say({ type: "end-of-turn", turn: 0, text: "New idea." });
  live.push(tone(1));
  ws.say({ type: "update", turn: 1, text: "Water the tomatoes" });
  live.push(tone(1));
  ws.say({ type: "fallback", reason: "idle" });
  ws.hangUp();
  assert.deepEqual(await live.finish(), { text: "New idea. Water the tomatoes", from: 3 - LAG_MARGIN, exact: false, reason: "idle" });
});

test("live: whether any audio went to the server", async () => {
  // Never opened: nothing was sent.
  const a = session();
  a.live.push(tone(0.5));
  a.ws.fail();
  await a.live.finish();
  assert.equal(a.live.sentAudio, false);
  // Opened, refused before a whole frame was recorded: nothing was sent.
  const b = session();
  b.ws.open();
  b.ws.say({ type: "fallback", reason: "cap" });
  b.live.push(tone(1));
  await b.live.finish();
  assert.equal(b.live.sentAudio, false);
  // A frame went out before the refusal.
  const c = session();
  c.live.push(tone(0.1));
  c.ws.open();
  c.ws.say({ type: "fallback", reason: "cap" });
  await c.live.finish();
  assert.equal(c.live.sentAudio, true);
  // Only the part of a frame at stop.
  const d = session();
  d.ws.open();
  d.live.push(tone(0.01));
  assert.equal(d.live.sentAudio, false);
  const end = d.live.finish();
  d.ws.hangUp();
  await end;
  assert.equal(d.live.sentAudio, true);
});

test("live: no close after stop in time: the text so far is kept, and the in-browser model takes over a margin before the last words came", async () => {
  const { ws, live } = session();
  ws.open();
  live.push(tone(2));
  ws.say({ type: "update", turn: 0, text: "Water the tomatoes" });
  live.push(tone(1));
  const end = live.finish();
  mock.timers.tick(STOP_WAIT_MS);
  assert.ok(ws.closedBy !== null);
  assert.deepEqual(await end, { text: "Water the tomatoes", from: 2 - LAG_MARGIN, exact: false, reason: "error" });
});

test("live: a send that throws (the socket closing under it) is a fallback, not an exception", async () => {
  const { ws, live, seen } = session();
  ws.open();
  live.push(tone(0.5));
  ws.send = () => { throw new Error("closed"); };
  live.push(tone(0.5));
  assert.deepEqual(seen.fallbacks, ["error"]);
  assert.deepEqual(await live.finish(), { text: "", from: 0, exact: false, reason: "error" });
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
  assert.deepEqual(await live.finish(), { text: "", from: 0, exact: false, reason: "error" });
});

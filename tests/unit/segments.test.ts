import { test } from "node:test";
import assert from "node:assert/strict";
import { segments, silent, missing, PART_MAX, LONG_PAUSE, type Part } from "../../src/core/segments.ts";

const RATE = 16_000;
let seed = 7;
const noise = (n: number, level: number) =>
  Float32Array.from({ length: n }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * level);

/** A recording from a script: [kind, seconds] pieces, where "say" is loud noise standing in for speech and
 *  "hush" is the room (digital silence, or quiet noise with `room`). Returns the samples and where the speech is. */
function recording(script: ["say" | "hush", number][], room = 0) {
  const pieces: Float32Array[] = [];
  const said: [number, number][] = [];
  let at = 0;
  for (const [kind, seconds] of script) {
    const n = Math.round(seconds * RATE);
    pieces.push(noise(n, kind === "say" ? 0.6 : room));
    if (kind === "say") said.push([at, at + n]);
    at += n;
  }
  const x = new Float32Array(at);
  let o = 0;
  for (const p of pieces) (x.set(p, o), (o += p.length));
  return { x, said };
}

/** In order, never overlapping (no word in two parts), and every bit of speech inside a part (no word lost). */
function keepsEverySpokenSample(parts: Part[], said: [number, number][], length: number) {
  for (const p of parts) assert.ok(p.start >= 0 && p.start < p.end && p.end <= length, `part ${p.start}..${p.end}`);
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i]!.start >= parts[i - 1]!.end, "parts overlap");
  for (const [a, b] of said) {
    let covered = 0;
    for (const p of parts) covered += Math.max(0, Math.min(b, p.end) - Math.max(a, p.start));
    assert.equal(covered, b - a, `speech at ${a / RATE}..${b / RATE} s is not all in a part`);
  }
}
const seconds = (p: Part) => (p.end - p.start) / RATE;

test("parts are short enough for the model, and a long pause always ends one", () => {
  assert.ok(PART_MAX >= 6 && PART_MAX <= 12, `${PART_MAX} s`);
  assert.ok(LONG_PAUSE >= 0.5 && LONG_PAUSE <= 2, `${LONG_PAUSE} s`);
});

test("a short recording is one part", () => {
  const { x, said } = recording([["say", 5]]);
  const parts = segments(x, RATE);
  assert.equal(parts.length, 1);
  keepsEverySpokenSample(parts, said, x.length);
});

test("no part is longer than PART_MAX, even in two minutes of speech without a pause", () => {
  const { x, said } = recording([["say", 120]]);
  const parts = segments(x, RATE);
  keepsEverySpokenSample(parts, said, x.length);
  for (const p of parts) assert.ok(seconds(p) <= PART_MAX, `${seconds(p)} s`);
});

test("speech is cut in a short pause near the limit, not mid-word", () => {
  const gap = PART_MAX - 2;
  const { x, said } = recording([["say", gap], ["hush", 0.35], ["say", 6]], 0.002);
  const parts = segments(x, RATE);
  keepsEverySpokenSample(parts, said, x.length);
  assert.equal(parts.length, 2);
  const cut = parts[0]!.end / RATE;
  assert.ok(cut >= gap && cut <= gap + 0.35, `cut at ${cut} s`);
});

test("sentences between short pauses share a part, up to the limit", () => {
  const { x, said } = recording([["say", 2], ["hush", 0.4], ["say", 2], ["hush", 0.4], ["say", 2]]);
  const parts = segments(x, RATE);
  assert.equal(parts.length, 1);
  keepsEverySpokenSample(parts, said, x.length);
});

test("a long pause ends a part, and the silence in it is left out", () => {
  for (const room of [0, 0.002]) {
    const { x, said } = recording([["say", 3], ["hush", 3], ["say", 3]], room);
    const parts = segments(x, RATE);
    keepsEverySpokenSample(parts, said, x.length);
    assert.equal(parts.length, 2, `room ${room}`);
    // Only a short margin of the pause stays with each part.
    assert.ok(parts[0]!.end / RATE < 3.5, `first part ends at ${parts[0]!.end / RATE} s`);
    assert.ok(parts[1]!.start / RATE > 5.5, `second part starts at ${parts[1]!.start / RATE} s`);
  }
});

test("a pause just under LONG_PAUSE keeps the sentences together", () => {
  const { x, said } = recording([["say", 3], ["hush", LONG_PAUSE * 0.8], ["say", 3]], 0.002);
  const parts = segments(x, RATE);
  assert.equal(parts.length, 1);
  keepsEverySpokenSample(parts, said, x.length);
});

test("silence before the first word and after the last is left out", () => {
  const { x, said } = recording([["hush", 3], ["say", 4], ["hush", 3]], 0.002);
  const parts = segments(x, RATE);
  keepsEverySpokenSample(parts, said, x.length);
  assert.equal(parts.length, 1);
  assert.ok(parts[0]!.start / RATE > 2.5 && parts[0]!.end / RATE < 7.5, `${parts[0]!.start / RATE}..${parts[0]!.end / RATE} s`);
});

test("with no quiet stretch to tell speech from the room, nothing is left out", () => {
  const x = noise(30 * RATE, 0.3);
  const parts = segments(x, RATE);
  keepsEverySpokenSample(parts, [[0, x.length]], x.length);
  for (const p of parts) assert.ok(seconds(p) <= PART_MAX);
});

test("a tiny last bit of speech is not left on its own", () => {
  const { x, said } = recording([["say", PART_MAX + 0.3]]);
  const parts = segments(x, RATE);
  keepsEverySpokenSample(parts, said, x.length);
  for (const p of parts) assert.ok(seconds(p) >= 1, `${seconds(p)} s part`);
});

test("each part knows how much speech is in it", () => {
  const { x } = recording([["hush", 1], ["say", 4], ["hush", 3], ["say", 2]], 0.002);
  const [a, b] = segments(x, RATE);
  assert.ok(Math.abs(a!.speech - 4) < 0.5, `${a!.speech} s`);
  assert.ok(Math.abs(b!.speech - 2) < 0.5, `${b!.speech} s`);
});

test("no audio, no parts", () => {
  assert.deepEqual(segments(new Float32Array(0), RATE), []);
});

test("silent: a muted microphone's digital silence, not a quiet room", () => {
  assert.equal(silent(new Float32Array(RATE)), true);
  assert.equal(silent(new Float32Array(RATE).fill(0.00005)), true);
  assert.equal(silent(recording([["say", 1]]).x), false);
  const room = Float32Array.from({ length: RATE }, (_, i) => 0.003 * Math.sin(i));
  assert.equal(silent(room), false);
  assert.equal(silent(new Float32Array(0)), true);
});

test("missing: a part with speech that came back empty", () => {
  assert.equal(missing("", 4), true);
  assert.equal(missing("  ", 2), true);
});

test("missing: far fewer words than that much speech holds", () => {
  // People say two to three words a second; the model stopping early leaves a sentence for a whole part.
  assert.equal(missing("Ask Martin about the ladder.", 9), true);
  assert.equal(missing("Ask Martin whether he can lend us his ladder on Saturday.", 4), false);
  assert.equal(missing("Plant the carrots near the kitchen window, where the soil is soft.", 4.5), false);
});

test("missing: slow speech and short words are not flagged", () => {
  assert.equal(missing("Call mum. Buy milk. Book the vet.", 5), false);
  assert.equal(missing("Yes.", 0.8), false);
});

test("missing: a cough or a click with no words is not flagged", () => {
  assert.equal(missing("", 0.4), false);
});

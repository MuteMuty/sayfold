import { test } from "node:test";
import assert from "node:assert/strict";
import { segments, silent, SEGMENT_MAX } from "../../src/core/segments.ts";

const RATE = 16_000;
/** Loud noise with silent gaps at the given seconds (each 0.4 s long). */
function speech(seconds: number, gapsAt: number[] = []) {
  const x = new Float32Array(Math.round(seconds * RATE));
  let seed = 7;
  for (let i = 0; i < x.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] = (seed / 0x7fffffff - 0.5) * 0.6;
  }
  for (const g of gapsAt) x.fill(0, Math.round(g * RATE), Math.round((g + 0.4) * RATE));
  return x;
}

function covers(parts: [number, number][], length: number) {
  assert.equal(parts[0]![0], 0);
  assert.equal(parts.at(-1)![1], length);
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i]![0], parts[i - 1]![1], "parts touch, no gap or overlap");
}

test("a short recording is one part", () => {
  const x = speech(8);
  assert.deepEqual(segments(x, RATE), [[0, x.length]]);
});

test("a part is at most SEGMENT_MAX seconds", () => {
  assert.ok(SEGMENT_MAX <= 30, "the model is trained on clips up to 30 s");
  const x = speech(120);
  const parts = segments(x, RATE);
  covers(parts, x.length);
  for (const [a, b] of parts) assert.ok(b - a <= SEGMENT_MAX * RATE, `${(b - a) / RATE} s`);
});

test("long speech is cut in a pause, not mid-word", () => {
  const x = speech(40, [17]);
  const parts = segments(x, RATE);
  covers(parts, x.length);
  const cut = parts[0]![1] / RATE;
  assert.ok(cut > 17 && cut < 17.4, `cut at ${cut} s`);
});

test("the pause nearest the limit is used, so parts stay long", () => {
  const x = speech(30, [6, 18]);
  const cut = segments(x, RATE)[0]![1] / RATE;
  assert.ok(cut > 18 && cut < 18.4, `cut at ${cut} s`);
});

test("a tiny last part is not left on its own", () => {
  const x = speech(SEGMENT_MAX + 0.3);
  const parts = segments(x, RATE);
  covers(parts, x.length);
  for (const [a, b] of parts) assert.ok(b - a >= RATE, `${(b - a) / RATE} s part`);
});

test("no audio, no parts", () => {
  assert.deepEqual(segments(new Float32Array(0), RATE), []);
});

test("silent: a muted microphone's digital silence, not a quiet room", () => {
  assert.equal(silent(new Float32Array(RATE)), true);
  assert.equal(silent(new Float32Array(RATE).fill(0.00005)), true);
  assert.equal(silent(speech(1)), false);
  const room = Float32Array.from({ length: RATE }, (_, i) => 0.003 * Math.sin(i));
  assert.equal(silent(room), false);
  assert.equal(silent(new Float32Array(0)), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { toMono, resample, TARGET_RATE } from "../../src/core/resample.ts";

const sine = (hz: number, rate: number, seconds: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

/** Upward zero crossings per second, a cheap pitch check. */
function pitch(x: Float32Array, rate: number) {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) n++;
  return n / (x.length / rate);
}
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

test("the speech model wants 16 kHz", () => {
  assert.equal(TARGET_RATE, 16_000);
});

test("mono averages the channels", () => {
  const out = toMono([Float32Array.from([1, 0, -1]), Float32Array.from([0, 0, 1])]);
  assert.deepEqual([...out], [0.5, 0, 0]);
});

test("one channel comes back unchanged", () => {
  const ch = Float32Array.from([0.1, 0.2]);
  assert.deepEqual([...toMono([ch])], [...ch]);
});

test("no channels is silence", () => {
  assert.equal(toMono([]).length, 0);
});

test("16 kHz in is 16 kHz out, the same samples", () => {
  const x = sine(300, 16_000, 0.1);
  assert.deepEqual([...resample(x, 16_000)], [...x]);
});

test("48 kHz becomes a third as many samples", () => {
  assert.equal(resample(new Float32Array(48_000), 48_000).length, 16_000);
  assert.equal(resample(new Float32Array(4_800), 48_000).length, 1_600);
});

test("44.1 kHz rounds to the nearest sample count", () => {
  assert.equal(resample(new Float32Array(44_100 * 2), 44_100).length, 32_000);
  assert.equal(resample(new Float32Array(441), 44_100).length, 160);
});

test("a steady level stays steady", () => {
  const out = resample(new Float32Array(9_600).fill(0.25), 48_000);
  for (const v of out) assert.ok(Math.abs(v - 0.25) < 1e-6, String(v));
});

test("a voice-range tone keeps its pitch and loudness", () => {
  for (const rate of [48_000, 44_100, 22_050]) {
    const out = resample(sine(440, rate, 1), rate);
    assert.ok(Math.abs(pitch(out, TARGET_RATE) - 440) <= 2, `${rate}: ${pitch(out, TARGET_RATE)} Hz`);
    assert.ok(Math.abs(rms(out) - Math.SQRT1_2) < 0.03, `${rate}: rms ${rms(out)}`);
  }
});

test("a tone above 8 kHz is filtered out instead of folding back into speech", () => {
  const out = resample(sine(12_000, 48_000, 0.5), 48_000);
  assert.ok(rms(out) < 0.2, `rms ${rms(out)}`);
});

test("empty in, empty out", () => {
  assert.equal(resample(new Float32Array(0), 48_000).length, 0);
});

test("a rate below 16 kHz is stretched up to it", () => {
  const out = resample(sine(200, 8_000, 1), 8_000);
  assert.equal(out.length, 16_000);
  assert.ok(Math.abs(pitch(out, TARGET_RATE) - 200) <= 2);
});

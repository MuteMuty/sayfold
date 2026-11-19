import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SECONDS, clock, capReached, secondsLeft } from "../../src/core/time.ts";

test("a recording is capped at two minutes", () => {
  assert.equal(MAX_SECONDS, 120);
});

test("clock shows minutes and zero-padded seconds, rounded down", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(0.99), "0:00");
  assert.equal(clock(7.4), "0:07");
  assert.equal(clock(59.999), "0:59");
  assert.equal(clock(60), "1:00");
  assert.equal(clock(65), "1:05");
  assert.equal(clock(120), "2:00");
});

test("clock never shows a negative or broken time", () => {
  assert.equal(clock(-3), "0:00");
  assert.equal(clock(Number.NaN), "0:00");
});

test("the cap is reached at exactly 120 seconds of samples", () => {
  assert.equal(capReached(48_000 * 119.99, 48_000), false);
  assert.equal(capReached(48_000 * 120, 48_000), true);
  assert.equal(capReached(16_000 * 121, 16_000), true);
});

test("seconds left counts down to zero and never below", () => {
  assert.equal(secondsLeft(0), 120);
  assert.equal(secondsLeft(100.5), 19.5);
  assert.equal(secondsLeft(130), 0);
});

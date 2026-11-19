import { test } from "node:test";
import assert from "node:assert/strict";
import { LoadProgress, megabytes } from "../../src/core/progress.ts";

test("progress adds up every file the model loads, by bytes", () => {
  const p = new LoadProgress();
  assert.equal(p.fraction, 0);
  p.update("tokenizer.json", 1_000, 1_000);
  p.update("onnx/encoder.onnx", 1_000, 4_000);
  assert.equal(p.fraction, 2_000 / 5_000);
  p.update("onnx/encoder.onnx", 4_000, 4_000);
  assert.equal(p.fraction, 1);
  assert.deepEqual([p.loaded, p.total], [5_000, 5_000]);
});

test("progress never goes backwards, even when a later file adds to the total", () => {
  const p = new LoadProgress();
  p.update("a", 900, 1_000);
  const before = p.fraction;
  p.update("b", 0, 100_000);
  assert.ok(p.fraction >= before, `${p.fraction} < ${before}`);
  p.update("b", 100_000, 100_000);
  p.done("a");
  assert.equal(p.fraction, 1);
});

test("a file without a known size counts once it is done", () => {
  const p = new LoadProgress();
  p.update("config.json", 300, 0);
  assert.equal(p.fraction, 0);
  p.done("config.json");
  assert.equal(p.fraction, 1);
});

test("megabytes reads like '12.3 MB'", () => {
  assert.equal(megabytes(0), "0.0 MB");
  assert.equal(megabytes(12_345_678), "12.3 MB");
});

test("sizes known up front count from the start, when the server sends no length", () => {
  const p = new LoadProgress({ "onnx/encoder.onnx": 8_000, "runtime.wasm": 2_000 });
  assert.equal(p.total, 10_000);
  p.update("onnx/encoder.onnx", 4_000, 0);
  assert.equal(p.fraction, 0.4);
  p.done("onnx/encoder.onnx");
  p.done("runtime.wasm");
  assert.equal(p.fraction, 1);
});

test("a file's own reported size wins over the expected one", () => {
  const p = new LoadProgress({ a: 100 });
  p.update("a", 50, 200);
  assert.equal(p.total, 200);
});

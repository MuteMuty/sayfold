// Everything Sayfold serves comes from its own origin, as static files on Cloudflare Workers,
// where one file may be at most 25 MiB. The speech model is pinned: its files must match the
// checksums recorded in src/stt/model.ts, which are the ones Hugging Face lists for that revision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MODEL, MAX_FILE_BYTES, modelFile, modelUrl } from "../../src/stt/model.ts";
import { configure } from "../../src/stt/config.ts";

const root = join(import.meta.dirname, "../..");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

test("the limit is the Workers static-asset limit, 25 MiB", () => {
  assert.equal(MAX_FILE_BYTES, 25 * 1024 * 1024);
});

test("every model file is committed, matches its pinned checksum and fits", () => {
  const dir = join(root, "public/models", MODEL.id);
  for (const [file, sha] of Object.entries(MODEL.files)) {
    const path = join(dir, file);
    assert.ok(existsSync(path), `missing ${file}`);
    const bytes = readFileSync(path);
    assert.ok(bytes.length <= MAX_FILE_BYTES, `${file} is ${bytes.length} bytes`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha, `${file} doesn't match the pinned model`);
  }
  assert.deepEqual(walk(dir).map((p) => p.slice(dir.length + 1)).sort(), Object.keys(MODEL.files).sort(), "no stray files in the model folder");
});

test("every file in public/ and in a built dist/ fits the static-asset limit", () => {
  const dirs = ["public", "dist"].map((d) => join(root, d)).filter(existsSync);
  for (const path of dirs.flatMap(walk)) assert.ok(statSync(path).size <= MAX_FILE_BYTES, `${path} is ${statSync(path).size} bytes`);
});

test("the speech library is set up to load only from Sayfold's own origin, through Sayfold's own cache", () => {
  const env = {
    allowRemoteModels: true, allowLocalModels: false, localModelPath: "/x", remoteHost: "https://huggingface.co/",
    useBrowserCache: true, useWasmCache: true, useCustomCache: false, customCache: null as unknown,
  };
  const ortEnv = { wasm: {} as Record<string, unknown> };
  const cache = { match: async () => undefined, put: async () => {} };
  configure(env, ortEnv, "/assets/ort-abc.wasm", "https://sayfold.example/", cache);
  assert.equal(env.allowRemoteModels, false);
  assert.equal(env.allowLocalModels, true);
  assert.equal(env.localModelPath, "/models/", "a path on this origin (an absolute URL would skip the library's local-file checks)");
  assert.equal(env.remoteHost, "https://sayfold.example/models/", "even a remote lookup would stay on our origin");
  assert.equal(env.useCustomCache, true, "the library reads the files Sayfold downloaded and checked, and fetches nothing itself");
  assert.equal(env.customCache, cache);
  assert.equal(env.useBrowserCache, false);
  assert.equal(env.useWasmCache, false, "the runtime comes with the page's own files, no fetch of a separate loader script");
  assert.deepEqual(ortEnv.wasm.wasmPaths, { wasm: "https://sayfold.example/assets/ort-abc.wasm" });
  assert.equal(ortEnv.wasm.numThreads, 1, "no threads: the page isn't cross-origin isolated");
  assert.equal(ortEnv.wasm.proxy, false);
});

test("the model's recorded sizes match its files, so progress can be shown without a content-length", () => {
  const dir = join(root, "public/models", MODEL.id);
  for (const [file, bytes] of Object.entries(MODEL.bytes)) assert.equal(statSync(join(dir, file)).size, bytes, file);
  assert.deepEqual(Object.keys(MODEL.bytes).sort(), Object.keys(MODEL.files).sort());
});

test("model files live under /models/<id>/ on this site", () => {
  assert.equal(modelUrl("onnx/encoder_model_quantized.onnx", "https://sayfold.example"), `https://sayfold.example/models/${MODEL.id}/onnx/encoder_model_quantized.onnx`);
});

test("the cache answers the library's lookups for the pinned files, by path or URL, and nothing else", () => {
  const o = "https://sayfold.example";
  assert.equal(modelFile(`/models/${MODEL.id}/onnx/encoder_model_quantized.onnx`, o), "onnx/encoder_model_quantized.onnx");
  assert.equal(modelFile(`${o}/models/${MODEL.id}/tokenizer.json`, o), "tokenizer.json");
  assert.equal(modelFile(`/models/${MODEL.id}/processor_config.json`, o), null, "not a pinned file");
  assert.equal(modelFile(`/models/other-model/tokenizer.json`, o), null);
  assert.equal(modelFile(`https://huggingface.co/models/${MODEL.id}/tokenizer.json`, o), null, "another origin");
  assert.equal(modelFile("::not a url::", o), null);
});

// The speech worker: loads the model on first use and turns recordings into text, off the main thread.
// WebGPU where the browser has it (with onnxruntime's JSPI build), otherwise WebAssembly on the CPU.
// Every file comes from Sayfold's own origin (config.ts), and nothing leaves this worker but text for the page.
import { configureLibrary } from "./config.ts";
import { download, modelCache, type Progress } from "./store.ts";
import { MODEL } from "./model.ts";
import type { FromWorker, ToWorker } from "./messages.ts";
import type { Backend } from "../analytics-events.ts";
import { resample, TARGET_RATE } from "../core/resample.ts";
import { segments, silent } from "../core/segments.ts";
import { clip, transcript } from "../core/transcript.ts";

type Transcriber = (audio: Float32Array, options: { max_new_tokens: number }) => Promise<{ text: string } | { text: string }[]>;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

/** WebGPU needs an adapter and WebAssembly JSPI (the WebGPU build that fits the size limit uses it, see ort.ts). */
async function pickBackend(jspi: boolean): Promise<Backend> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu || !jspi) return "wasm";
  try {
    return (await gpu.requestAdapter()) ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

/** The runtime's .wasm, as the progress bar names it. */
const RUNTIME = "runtime.wasm";

const progress: Progress = (file, loaded, total, done) => post({ type: "progress", file, loaded, total, done });

let loading: Promise<{ asr: Transcriber; backend: Backend }> | null = null;

async function load(): Promise<{ asr: Transcriber; backend: Backend }> {
  // transformers.js imports its onnxruntime through ort.ts (see vite.config.ts), which sets it up first.
  const [runtime, { pipeline, env }] = await Promise.all([import("./ort.ts"), import("@huggingface/transformers")]);
  // The runtime's .wasm and the model's files are fetched here, once, on one progress bar.
  const wasm = await download(new URL(runtime.wasmUrl, self.location.origin).href, RUNTIME, runtime.wasmBytes, progress);
  runtime.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
  configureLibrary(env as never, self.location.origin, await modelCache(self.location.origin, progress));
  let backend = await pickBackend(runtime.jspi);
  const make = (device: Backend) =>
    pipeline("automatic-speech-recognition", MODEL.id, { device, dtype: MODEL.dtype }) as unknown as Promise<Transcriber>;
  let asr: Transcriber;
  try {
    asr = await make(backend);
  } catch (e) {
    if (backend !== "webgpu") throw e;
    console.warn("Sayfold: WebGPU didn't work here, using the CPU instead:", e);
    // A GPU that turned out not to work: the same files run on the CPU.
    backend = "wasm";
    asr = await make(backend);
  }
  post({ type: "ready", backend });
  return { asr, backend };
}

function ensureLoaded() {
  loading ??= load().catch((e) => {
    loading = null; // so Try again can start over
    throw e;
  });
  return loading;
}

async function transcribe(id: number, raw: Float32Array, rate: number) {
  const { asr, backend } = await ensureLoaded();
  const samples = resample(raw, rate, TARGET_RATE);
  if (silent(samples)) return post({ type: "result", id, text: "", backend, gaps: false });
  const parts = segments(samples, TARGET_RATE);
  const { text, gaps } = await transcript(
    parts,
    async (ps) => {
      const audio = clip(samples, ps);
      // About six tokens a second of speech, with room for a short clip.
      const out = await asr(audio, { max_new_tokens: Math.max(12, Math.ceil((audio.length / TARGET_RATE) * 6.5)) });
      return (Array.isArray(out) ? out[0]?.text : out.text) ?? "";
    },
    (done) => post({ type: "part", id, done, of: parts.length }),
  );
  post({ type: "result", id, text, backend, gaps });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "load") {
    ensureLoaded().catch((err: unknown) => post({ type: "error", stage: "load", message: String(err) }));
  } else if (m.type === "transcribe") {
    transcribe(m.id, m.samples, m.rate).catch((err: unknown) =>
      post({ type: "error", stage: loading ? "transcribe" : "load", id: m.id, message: String(err) }),
    );
  }
};

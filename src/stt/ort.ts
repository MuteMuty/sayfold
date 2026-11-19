// The onnxruntime that transformers.js gets. Its own choice, onnxruntime's default WebGPU build, has a
// WebAssembly file over the 25 MiB static-file limit, so vite.config.ts points that import here instead:
//   - where WebAssembly JSPI exists (current Chrome and Edge), the JSPI build: WebGPU and CPU, 16.8 MB;
//   - elsewhere, the plain WebAssembly build: CPU only, 14.3 MB.
// Either way its .wasm file comes from this site (config.ts), never from a CDN.
import jspiWasm from "onnxruntime-web/ort-wasm-simd-threaded.jspi.wasm?url";
import cpuWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { configureRuntime } from "./config.ts";

/** Each build's .wasm size, read at build time (vite.config.ts), for the progress bar. */
declare const __ORT_BYTES__: { jspi: number; cpu: number };

/** This runtime can use WebGPU (if the device has a GPU adapter too). */
export const jspi = typeof WebAssembly === "object" && "Suspending" in WebAssembly;
/** The runtime's .wasm file on this site, and its size. */
export const wasmUrl = jspi ? jspiWasm : cpuWasm;
export const wasmBytes = jspi ? __ORT_BYTES__.jspi : __ORT_BYTES__.cpu;

const ort = jspi ? await import("onnxruntime-web/jspi") : await import("onnxruntime-web/wasm");
configureRuntime(ort.env as unknown as { wasm: Record<string, unknown> }, wasmUrl, self.location.origin);

export const { InferenceSession, Tensor, env } = ort;

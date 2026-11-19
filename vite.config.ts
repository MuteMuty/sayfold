import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { CSP } from "./src/csp.ts";

const ortWasm = (name: string) => statSync(fileURLToPath(new URL(`./node_modules/onnxruntime-web/dist/${name}`, import.meta.url))).size;

export default defineConfig({
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  worker: { format: "es" },
  // The onnxruntime .wasm sizes, so the model's progress bar can count the runtime too (src/stt/ort.ts).
  define: { __ORT_BYTES__: JSON.stringify({ jspi: ortWasm("ort-wasm-simd-threaded.jspi.wasm"), cpu: ortWasm("ort-wasm-simd-threaded.wasm") }) },
  resolve: {
    // See src/stt/ort.ts: transformers.js gets an onnxruntime build whose files fit the static-file limit.
    alias: [{ find: /^onnxruntime-web\/webgpu$/, replacement: fileURLToPath(new URL("./src/stt/ort.ts", import.meta.url)) }],
  },
  // The playtest's usage-events run opens the local build as sayfold.playtest.brightloopapps.com (tests/playtest.ts).
  preview: { allowedHosts: ["sayfold.playtest.brightloopapps.com"] },
  // The Content-Security-Policy (src/csp.ts) goes into the built page only: the dev server's live reload needs more.
  plugins: [
    {
      name: "sayfold-csp",
      apply: "build",
      transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }],
    },
  ],
  optimizeDeps: { exclude: ["@huggingface/transformers", "onnxruntime-web"] },
});

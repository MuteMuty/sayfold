// Points the speech library at Sayfold's own origin and nowhere else: models from /models/, the
// onnxruntime WebAssembly file from the page's own build. Remote models are off, and the remote host is
// our origin too, so even a lookup that slipped through would never reach Hugging Face or a CDN.
// The model files themselves are downloaded and checked by the worker (store.ts), and the library
// reads them from that cache: it fetches nothing itself.

export interface LibraryEnv {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath: string;
  remoteHost: string;
  useBrowserCache: boolean;
  useWasmCache: boolean;
  useCustomCache: boolean;
  customCache: unknown;
}

/** The part of the Cache API the library uses. */
export interface ModelCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** onnxruntime, before transformers.js loads: once it sees a wasm path it never picks its CDN default. */
export function configureRuntime(ortEnv: { wasm: Record<string, unknown> }, wasmUrl: string, origin: string): void {
  ortEnv.wasm.wasmPaths = { wasm: new URL(wasmUrl, origin).href };
  // Threads need a cross-origin-isolated page; Sayfold isn't one, so say so instead of letting it probe.
  ortEnv.wasm.numThreads = 1;
  ortEnv.wasm.proxy = false;
}

export function configureLibrary(env: LibraryEnv, origin: string, cache: ModelCache): void {
  const models = new URL("/models/", origin).href;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  // A path, not a URL: transformers.js only looks for local files (such as the processor config) at paths.
  env.localModelPath = "/models/";
  env.remoteHost = models;
  // Sayfold's own cache (store.ts) instead of the library's: it holds the pinned files, already checked.
  env.useCustomCache = true;
  env.customCache = cache;
  env.useBrowserCache = false;
  // The onnxruntime build bundles its own loader, so only the .wasm is fetched (and HTTP-cached).
  env.useWasmCache = false;
}

export function configure(env: LibraryEnv, ortEnv: { wasm: Record<string, unknown> }, wasmUrl: string, origin: string, cache: ModelCache): void {
  configureRuntime(ortEnv, wasmUrl, origin);
  configureLibrary(env, origin, cache);
}

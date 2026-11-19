// The speech model's files, downloaded once from this site, checked against their pinned checksums and
// kept in the browser's Cache Storage, so every later visit loads them without the network. The library
// reads them from here (config.ts): it never fetches a model file itself. Only the model is kept, never
// anything recorded.
import { MODEL, modelFile, modelUrl } from "./model.ts";
import type { ModelCache } from "./config.ts";

const CACHE = `sayfold-${MODEL.id}`;

export type Progress = (file: string, loaded: number, total: number, done: boolean) => void;

/** Fetch a file from this site, reporting progress as it comes in. */
export async function download(url: string, file: string, expected: number, progress: Progress): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url}: ${response.status}`);
  const total = Number(response.headers.get("content-length")) || expected;
  const parts: Uint8Array[] = [];
  let loaded = 0;
  let told = 0;
  const reader = response.body.getReader();
  progress(file, 0, total, false);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (loaded - told > 256_000) {
      progress(file, loaded, total, false);
      told = loaded;
    }
  }
  progress(file, loaded, total, true);
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return bytes;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Every pinned model file, in the cache (downloading what's missing), as a cache the library can read. */
export async function modelCache(origin: string, progress: Progress): Promise<ModelCache> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    // A model Sayfold no longer uses is cleared out, so it doesn't sit in the browser's storage.
    for (const name of await caches.keys()) if (name.startsWith("sayfold-") && name !== CACHE) await caches.delete(name);
  } catch {
    // No Cache Storage (some private windows): the files are kept in memory for this visit.
  }
  const memory = new Map<string, Uint8Array>();
  for (const [file, sha256] of Object.entries(MODEL.files)) {
    const url = modelUrl(file, origin);
    const size = MODEL.bytes[file]!;
    if (await cache?.match(url)) {
      progress(file, size, size, true);
      continue;
    }
    const bytes = await download(url, file, size, progress);
    if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== sha256) throw new Error(`${file} didn't arrive intact`);
    const stored = await cache
      ?.put(url, new Response(bytes, { headers: { "content-length": String(bytes.length) } }))
      .then(() => true, () => false);
    if (!stored) memory.set(file, bytes);
  }
  return {
    async match(key) {
      const file = modelFile(key, origin);
      if (!file) return undefined;
      const kept = memory.get(file);
      if (kept) return new Response(kept.slice());
      return (await cache?.match(modelUrl(file, origin))) ?? undefined;
    },
    async put() {
      // Everything the library needs is already here.
    },
  };
}

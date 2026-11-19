// The speech model Sayfold serves from its own origin: Moonshine tiny (English), by Useful Sensors,
// MIT licence, as converted to ONNX by onnx-community and quantized to 8 bits. Pinned to one revision;
// the checksums are Hugging Face's for that revision (the .onnx ones are its LFS ids).
// Source: https://huggingface.co/onnx-community/moonshine-tiny-ONNX/tree/a6da1241cd305dcd64eab1edbd615f2bb9aabb95
// To fetch it again: node scripts/fetch-model.ts (checks every file against these sums).

export const MODEL = {
  /** The folder under public/models/, named with the revision so a new model never meets an old cache. */
  id: "moonshine-tiny-a6da124",
  repo: "onnx-community/moonshine-tiny-ONNX",
  revision: "a6da1241cd305dcd64eab1edbd615f2bb9aabb95",
  /** transformers.js dtype: the *_quantized.onnx files. */
  dtype: "q8",
  files: {
    "config.json": "558e1e02069137c796ace1e50c48d8fe451f04a295929138e6bea885517f0edb",
    "generation_config.json": "f9b3f711b57be7def2e50a8942f64f36ee0a55fad5b84ff93a687b6c5bcc1d44",
    "preprocessor_config.json": "fa43a7017ef85cd1d0fba0d9aae77c8adb16990ae6f11115631f41ec5d8aa679",
    "special_tokens_map.json": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
    "tokenizer.json": "7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f",
    "tokenizer_config.json": "edaee394565d428ea98a663ae7209cdcfeefc5585c42d7a570ff7c986df2cd15",
    "onnx/encoder_model_quantized.onnx": "c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a",
    "onnx/decoder_model_merged_quantized.onnx": "eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367",
  } as Record<string, string>,
  /** Sizes in bytes, for the progress bar when the server sends no content-length. */
  bytes: {
    "config.json": 921,
    "generation_config.json": 147,
    "preprocessor_config.json": 128,
    "special_tokens_map.json": 3,
    "tokenizer.json": 3761754,
    "tokenizer_config.json": 135735,
    "onnx/encoder_model_quantized.onnx": 7937661,
    "onnx/decoder_model_merged_quantized.onnx": 20243286,
  } as Record<string, number>,
} as const;

/** Cloudflare Workers serve static files up to 25 MiB each. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Where a model file is served on this site. */
export const modelUrl = (file: string, origin: string) => new URL(`/models/${MODEL.id}/${file}`, origin).href;

/** The pinned file a lookup (a path or a URL on this origin) asks for, or null for anything else. */
export function modelFile(key: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(key, origin);
  } catch {
    return null;
  }
  const prefix = `/models/${MODEL.id}/`;
  if (url.origin !== new URL(origin).origin || !url.pathname.startsWith(prefix)) return null;
  const file = url.pathname.slice(prefix.length);
  return Object.hasOwn(MODEL.files, file) ? file : null;
}

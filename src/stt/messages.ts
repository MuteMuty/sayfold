// What the page and the speech worker say to each other.
import type { Backend } from "../analytics-events.ts";

export type ToWorker =
  | { type: "load" }
  | { type: "transcribe"; id: number; samples: Float32Array; rate: number };

export type FromWorker =
  | { type: "progress"; file: string; loaded: number; total: number; done: boolean }
  | { type: "ready"; backend: Backend }
  | { type: "part"; id: number; done: number; of: number }
  /** `gaps`: a part with speech in it came back empty or far too short, so words may be missing. */
  | { type: "result"; id: number; text: string; backend: Backend; gaps: boolean }
  | { type: "error"; stage: "load" | "transcribe"; id?: number; message: string };

// What the page and the speech worker say to each other.
import type { Backend } from "../analytics-events.ts";

export type ToWorker =
  | { type: "load" }
  | { type: "transcribe"; id: number; samples: Float32Array; rate: number };

export type FromWorker =
  | { type: "progress"; file: string; loaded: number; total: number; done: boolean }
  | { type: "ready"; backend: Backend }
  | { type: "part"; id: number; done: number; of: number }
  | { type: "result"; id: number; text: string; backend: Backend }
  | { type: "error"; stage: "load" | "transcribe"; id?: number; message: string };

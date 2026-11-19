// The page's side of the speech worker. The worker (and the model with it) is only created on first
// use: when the first recording starts, never on page load.
import type { Backend } from "../analytics-events.ts";
import type { FromWorker, ToWorker } from "./messages.ts";

export interface SpeechEvents {
  progress(file: string, loaded: number, total: number, done: boolean): void;
  ready(backend: Backend): void;
  part(done: number, of: number): void;
}

export class Speech {
  private worker: Worker | null = null;
  private next = 0;
  private pending = new Map<number, { resolve(r: { text: string; backend: Backend }): void; reject(e: Error): void }>();
  ready = false;

  private readonly on: SpeechEvents;

  constructor(on: SpeechEvents) {
    this.on = on;
  }

  /** Start loading the model in the background. */
  load(): void {
    this.send({ type: "load" });
  }

  /** Mono samples at `rate`; the worker resamples, cuts long recordings in pauses and transcribes each part. */
  transcribe(samples: Float32Array, rate: number): Promise<{ text: string; backend: Backend }> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Copied, not transferred: the page keeps the recording so Try again needs no new one.
      this.send({ type: "transcribe", id, samples, rate });
    });
  }

  private send(m: ToWorker, transfer: Transferable[] = []) {
    if (!this.worker) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "sayfold-speech" });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
      this.worker.onerror = (e) => {
        e.preventDefault();
        this.fail(new Error(e.message || "The speech worker stopped"));
        this.worker?.terminate();
        this.worker = null;
        this.ready = false;
      };
    }
    this.worker.postMessage(m, transfer);
  }

  private receive(m: FromWorker) {
    if (m.type === "progress") this.on.progress(m.file, m.loaded, m.total, m.done);
    else if (m.type === "ready") {
      this.ready = true;
      this.on.ready(m.backend);
    } else if (m.type === "part") this.on.part(m.done, m.of);
    else if (m.type === "result") {
      this.pending.get(m.id)?.resolve({ text: m.text, backend: m.backend });
      this.pending.delete(m.id);
    } else if (m.type === "error") {
      // A failed background load is reported when a transcription asks for the model.
      if (m.id === undefined) return;
      this.pending.get(m.id)?.reject(Object.assign(new Error(m.message), { stage: m.stage }));
      this.pending.delete(m.id);
    }
  }

  private fail(e: Error) {
    for (const p of this.pending.values()) p.reject(Object.assign(e, { stage: "load" }));
    this.pending.clear();
  }
}

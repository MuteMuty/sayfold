// Runs on the audio thread: hands the microphone's raw samples to the page in batches of about
// 85 ms (4096 frames), one Float32Array per channel. Nothing is kept here.

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const BATCH = 4096;

class Capture extends AudioWorkletProcessor {
  private parts: Float32Array[][] = [];
  private frames = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (input && input.length > 0) {
      this.parts.push(input.map((ch) => ch.slice()));
      this.frames += input[0]!.length;
      if (this.frames >= BATCH) this.flush();
    }
    return true;
  }

  private flush() {
    const channels = this.parts[0]!.length;
    const out = Array.from({ length: channels }, () => new Float32Array(this.frames));
    let at = 0;
    for (const part of this.parts) {
      for (let c = 0; c < channels; c++) out[c]!.set(part[c] ?? part[0]!, at);
      at += part[0]!.length;
    }
    this.port.postMessage({ channels: out, sampleRate }, out.map((c) => c.buffer));
    this.parts = [];
    this.frames = 0;
  }
}

registerProcessor("sayfold-capture", Capture);

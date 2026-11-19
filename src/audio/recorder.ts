// The microphone, kept in memory only while recording: raw samples from an AudioWorklet, plus an
// AnalyserNode for the live waveform. Stopping releases the microphone and hands back the samples, in one channel.
import workletUrl from "./capture.worklet.ts?worker&url";
import { capReached, MAX_SECONDS } from "../core/time.ts";
import { toMono } from "../core/resample.ts";

export interface Recording {
  /** Mono, at the microphone's rate (the speech worker brings it to 16 kHz). */
  samples: Float32Array;
  rate: number;
  seconds: number;
}

export class Recorder {
  private chunks: Float32Array[] = [];
  private frames = 0;
  private stopped = false;
  private readonly level = new Float32Array(1024);

  private readonly ctx: AudioContext;
  private readonly stream: MediaStream;
  private readonly analyser: AnalyserNode;
  private readonly node: AudioWorkletNode;

  private constructor(ctx: AudioContext, stream: MediaStream, analyser: AnalyserNode, node: AudioWorkletNode, onCap: () => void) {
    this.ctx = ctx;
    this.stream = stream;
    this.analyser = analyser;
    this.node = node;
    node.port.onmessage = (e: MessageEvent<{ channels: Float32Array[] }>) => {
      if (this.stopped) return;
      const mono = toMono(e.data.channels);
      this.chunks.push(mono);
      this.frames += mono.length;
      if (capReached(this.frames, ctx.sampleRate)) onCap();
    };
  }

  /** Ask for the microphone and start recording. Call from a click or key press (browsers need the gesture for audio). */
  static async start(onCap: () => void): Promise<Recorder> {
    // Created before the permission prompt, while the gesture still counts.
    const ctx = new AudioContext();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      try {
        await ctx.audioWorklet.addModule(workletUrl);
        await ctx.resume();
      } catch {
        // Not the microphone's fault (its errors have names micProblem knows): the page's own audio setup failed.
        for (const t of stream.getTracks()) t.stop();
        throw new Error("The audio recorder didn't start");
      }
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const node = new AudioWorkletNode(ctx, "sayfold-capture", { numberOfOutputs: 0 });
      source.connect(analyser);
      source.connect(node);
      return new Recorder(ctx, stream, analyser, node, onCap);
    } catch (e) {
      void ctx.close().catch(() => {});
      throw e;
    }
  }

  /** Seconds recorded so far. */
  get seconds(): number {
    return this.frames / this.ctx.sampleRate;
  }

  /** How loud the microphone is right now, 0 to about 1. */
  loudness(): number {
    this.analyser.getFloatTimeDomainData(this.level);
    let sum = 0;
    for (const v of this.level) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.level.length) * 4);
  }

  /** Stop, release the microphone, and return the recording in one channel. */
  async stop(): Promise<Recording> {
    this.stopped = true;
    this.node.port.onmessage = null;
    for (const t of this.stream.getTracks()) t.stop();
    const rate = this.ctx.sampleRate;
    await this.ctx.close().catch(() => {});
    const all = new Float32Array(Math.min(this.frames, Math.ceil(MAX_SECONDS * rate)));
    let at = 0;
    for (const c of this.chunks) {
      if (at >= all.length) break;
      all.set(c.subarray(0, all.length - at), at);
      at += c.length;
    }
    this.chunks = [];
    return { samples: all, rate, seconds: all.length / rate };
  }
}

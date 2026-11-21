// Microphone audio to what the speech model takes: one channel at 16 kHz.
// Browsers record at 44.1 or 48 kHz. Going down, each output sample is a short windowed-sinc
// low-pass around its position, so sound above 8 kHz is filtered out instead of folding back
// into the speech band. Going up (rare), it's plain linear interpolation.

export const TARGET_RATE = 16_000;

/** The channels averaged into one. */
export function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const out = new Float32Array(Math.min(...channels.map((c) => c.length)));
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i]! += ch[i]! / channels.length;
  return out;
}

const HALF_WIDTH = 8; // taps either side, in output samples

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

export function resample(input: Float32Array, fromRate: number, toRate = TARGET_RATE): Float32Array {
  if (fromRate === toRate) return input;
  const f = new Filter(fromRate, toRate);
  const out = new Float32Array(Math.round((input.length * toRate) / fromRate));
  for (let i = 0; i < out.length; i++) out[i] = f.at(input, 0, i, input.length);
  return out;
}

/** The resampling filter: one output sample at a time, from input that may start part way through the recording. */
class Filter {
  /** Input samples per output sample. */
  readonly step: number;
  /** How far either side of an output sample the filter reads, in input samples. */
  readonly reach: number;
  private readonly cutoff: number;

  constructor(fromRate: number, toRate: number) {
    this.step = fromRate / toRate;
    // Low-pass just under the new Nyquist, with a Blackman window over ±HALF_WIDTH output samples.
    this.cutoff = 0.95 / this.step;
    this.reach = this.step < 1 ? 1 : Math.ceil(HALF_WIDTH * this.step);
  }

  /** Output sample `i`, from `input`, whose first sample is the recording's sample `offset`, of `total` so far. */
  at(input: Float32Array, offset: number, i: number, total: number): number {
    const centre = i * this.step;
    if (this.step < 1) {
      const a = Math.floor(centre);
      const b = Math.min(a + 1, total - 1);
      return input[a - offset]! + (input[b - offset]! - input[a - offset]!) * (centre - a);
    }
    const reach = this.reach;
    const lo = Math.max(0, Math.ceil(centre - reach));
    const hi = Math.min(total - 1, Math.floor(centre + reach));
    let sum = 0;
    let weight = 0;
    for (let j = lo; j <= hi; j++) {
      const d = j - centre;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / reach) + 0.08 * Math.cos((2 * Math.PI * d) / reach);
      const k = sinc(d * this.cutoff) * w;
      sum += input[j - offset]! * k;
      weight += k;
    }
    return weight === 0 ? 0 : sum / weight;
  }

  /** The first input sample output `i` reads. */
  first(i: number): number {
    return Math.max(0, this.step < 1 ? Math.floor(i * this.step) : Math.ceil(i * this.step - this.reach));
  }
}

/**
 * The same resampling, a batch at a time, for audio that is sent while it's recorded (lab#109). Each output
 * sample comes out once the filter has all the input it reads, so the joined output is exactly what
 * resample() gives for the whole recording, only a few input samples behind. flush() ends the recording.
 */
export class StreamResampler {
  private readonly from: number;
  private readonly to: number;
  private readonly filter: Filter;
  /** Input kept for the filter, starting at the recording's sample `offset`. */
  private kept = new Float32Array(0);
  private offset = 0;
  private received = 0;
  private produced = 0;

  constructor(fromRate: number, toRate = TARGET_RATE) {
    this.from = fromRate;
    this.to = toRate;
    this.filter = new Filter(fromRate, toRate);
  }

  push(chunk: Float32Array): Float32Array {
    if (this.from === this.to) return chunk;
    const kept = new Float32Array(this.kept.length + chunk.length);
    kept.set(this.kept);
    kept.set(chunk, this.kept.length);
    this.kept = kept;
    this.received += chunk.length;
    return this.emit(false);
  }

  /** The last samples, once the recording has ended. */
  flush(): Float32Array {
    return this.from === this.to ? new Float32Array(0) : this.emit(true);
  }

  private emit(end: boolean): Float32Array {
    const f = this.filter;
    const length = Math.round((this.received * this.to) / this.from);
    let last = length; // one past the last output sample that can be made now
    if (!end) {
      const ready = Math.floor((this.received - 1 - f.reach) / f.step) + 1;
      last = Math.max(this.produced, Math.min(length, ready));
    }
    const out = new Float32Array(last - this.produced);
    for (let n = 0; n < out.length; n++) out[n] = f.at(this.kept, this.offset, this.produced + n, this.received);
    this.produced = last;
    // Drop the input no later sample reads.
    const keepFrom = Math.min(this.received, f.first(this.produced));
    if (keepFrom > this.offset) {
      this.kept = this.kept.slice(keepFrom - this.offset);
      this.offset = keepFrom;
    }
    return out;
  }
}

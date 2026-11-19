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
  const length = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(length);
  const step = fromRate / toRate; // input samples per output sample
  if (step < 1) {
    for (let i = 0; i < length; i++) {
      const pos = i * step;
      const a = Math.floor(pos);
      const b = Math.min(a + 1, input.length - 1);
      out[i] = input[a]! + (input[b]! - input[a]!) * (pos - a);
    }
    return out;
  }
  // Low-pass just under the new Nyquist, with a Blackman window over ±HALF_WIDTH output samples.
  const cutoff = 0.95 / step;
  const reach = Math.ceil(HALF_WIDTH * step);
  for (let i = 0; i < length; i++) {
    const centre = i * step;
    const lo = Math.max(0, Math.ceil(centre - reach));
    const hi = Math.min(input.length - 1, Math.floor(centre + reach));
    let sum = 0;
    let weight = 0;
    for (let j = lo; j <= hi; j++) {
      const d = j - centre;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / reach) + 0.08 * Math.cos((2 * Math.PI * d) / reach);
      const k = sinc(d * cutoff) * w;
      sum += input[j]! * k;
      weight += k;
    }
    out[i] = weight === 0 ? 0 : sum / weight;
  }
  return out;
}

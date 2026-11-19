// Cutting a recording into parts the speech model handles well, and noticing a part it may have cut short.
//
// Moonshine tiny ends its text early when a clip holds long silences in a room's noise: a part that starts
// or pauses in it can come back empty, and a long clip with a few thinking pauses loses its last sentences
// (measured in lab#95). So Sayfold finds where someone is speaking, leaves the long silences out, and
// packs the speech into parts of at most PART_MAX seconds (10 kept the most sentences of the lengths
// measured, see the README). A pause of LONG_PAUSE or more always ends a
// part; a part that's still too long is cut in the quietest moment before its limit, between words.
// Parts never overlap, and every bit of speech is in one, so no word is lost or doubled at a cut.

export const PART_MAX = 10;
/** A pause at least this long ends a part, and the silence in it is left out (apart from MARGIN each side). */
export const LONG_PAUSE = 1;
const FRAME = 0.02; // seconds of audio per loudness reading
const JOIN = 0.3; // quiet shorter than this is inside speech (between words, or a soft consonant)
const MARGIN = 0.2; // seconds kept either side of speech, for the soft starts and ends of words
const RANGE = 10; // dB between the room and the speech below which they can't be told apart
const LOOK_BACK = 5; // seconds before a part's limit to search for the quietest moment
const WINDOW = 0.1; // seconds of audio per loudness reading when choosing a cut
const MIN_PART = 1; // seconds; a cut never leaves a shorter piece

export interface Part {
  /** [start, end) in samples. */
  start: number;
  end: number;
  /** Seconds of speech heard in it. */
  speech: number;
}

/** [start, end) sample ranges where someone is speaking: louder than the room's own quiet. */
function speaking(samples: Float32Array, rate: number): [number, number][] {
  const frame = Math.max(1, Math.round(FRAME * rate));
  const n = Math.floor(samples.length / frame);
  if (n === 0) return samples.length ? [[0, samples.length]] : [];
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i]! * samples[i]!;
    db[f] = 10 * Math.log10(sum / frame + 1e-10);
  }
  const sorted = Float32Array.from(db).sort();
  const room = sorted[Math.floor(n * 0.1)]!;
  const voice = sorted[Math.floor(n * 0.95)]!;
  // No quiet stretch to compare with: keep it all rather than risk leaving words out.
  if (voice - room < RANGE) return [[0, samples.length]];
  const threshold = room + Math.max(6, 0.25 * (voice - room));
  const join = Math.round(JOIN / FRAME);
  const spans: [number, number][] = [];
  for (let f = 0; f < n; f++) {
    if (db[f]! < threshold) continue;
    const last = spans.at(-1);
    if (last && f - last[1] <= join) last[1] = f + 1;
    else spans.push([f, f + 1]);
  }
  const spoken = spans.map(([a, b]): [number, number] => [a * frame, b * frame]);
  // The few samples after the last whole frame belong to whatever it was.
  if (spoken.length && spoken.at(-1)![1] === n * frame) spoken.at(-1)![1] = samples.length;
  return spoken;
}

/** Cuts [start, end) into pieces of at most PART_MAX seconds, each in the quietest moment before the limit. */
function cut(samples: Float32Array, rate: number, start: number, end: number): [number, number][] {
  const pieces: [number, number][] = [];
  const max = Math.floor(PART_MAX * rate);
  const min = Math.round(MIN_PART * rate);
  const win = Math.max(1, Math.round(WINDOW * rate));
  while (end - start > max) {
    const searchEnd = Math.min(start + max, end - min);
    const searchStart = Math.max(start + min, start + max - Math.round(LOOK_BACK * rate));
    let best = searchEnd;
    let quietest = Infinity;
    // Latest window first, so of equally quiet moments the one nearest the limit wins.
    for (let a = searchEnd - win; a >= searchStart; a -= Math.round(win / 2)) {
      let energy = 0;
      for (let i = a; i < a + win; i++) energy += samples[i]! * samples[i]!;
      if (energy < quietest * 0.999) {
        quietest = energy;
        best = a + Math.round(win / 2);
      }
    }
    pieces.push([start, best]);
    start = best;
  }
  pieces.push([start, end]);
  return pieces;
}

/** The parts to transcribe, in order: every bit of speech, none of the long silences. */
export function segments(samples: Float32Array, rate: number): Part[] {
  const spoken = speaking(samples, rate);
  const margin = Math.round(MARGIN * rate);
  const max = Math.floor(PART_MAX * rate);
  const longPause = Math.round(LONG_PAUSE * rate);
  // Speech with its margins, joined across short pauses while it fits in one part.
  const runs: [number, number][] = [];
  let prevEnd = 0; // where the previous run's speech ended
  for (const [a, b] of spoken) {
    const run = runs.at(-1);
    if (run && a - prevEnd < longPause && Math.min(samples.length, b + margin) - run[0] <= max) {
      run[1] = Math.min(samples.length, b + margin);
    } else {
      // Margins of neighbouring runs meet in the middle of the pause between them.
      const start = run ? Math.max(a - margin, Math.round((prevEnd + a) / 2)) : Math.max(0, a - margin);
      if (run) run[1] = Math.min(run[1], start);
      runs.push([start, Math.min(samples.length, b + margin)]);
    }
    prevEnd = b;
  }
  return runs
    .flatMap(([a, b]) => cut(samples, rate, a, b))
    .map(([start, end]) => {
      let speech = 0;
      for (const [a, b] of spoken) speech += Math.max(0, Math.min(b, end) - Math.max(a, start));
      return { start, end, speech: speech / rate };
    });
}

/** Nothing at all came through (a muted or dead microphone): no point asking the model. A quiet room is not silent. */
export function silent(samples: Float32Array): boolean {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return samples.length === 0 || Math.sqrt(sum / samples.length) < 1e-4;
}

const MIN_WORDS = 0.8; // per second of speech: people say two to three
const MIN_SPEECH = 1; // seconds; less could be a cough or a click

/** The text for a part with `speech` seconds of speech is far shorter than that much speech holds: words may be missing. */
export function missing(text: string, speech: number): boolean {
  if (speech < MIN_SPEECH) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  return words < speech * MIN_WORDS;
}

// The parts of a recording, turned into one text without losing any of it.
//
// In a noisy room Moonshine tiny sometimes can't start on a sentence cold and gives back nothing, though
// it carries on into the same sentence from the one before it (lab#95). So a part that comes back far
// too short is tried once more, joined to its neighbour, and the joined text replaces both when it
// holds more words. Each word is in exactly one text, so none is doubled. If a part is still short,
// `gaps` says so, and the review screen tells you.
import { missing, type Part } from "./segments.ts";

/** Turns the audio of these parts, put end to end, into text. */
export type Transcribe = (parts: Part[]) => Promise<string>;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The samples of these parts, end to end (one part's are used as they are). */
export function clip(samples: Float32Array, parts: Part[]): Float32Array {
  if (parts.length === 1) return samples.subarray(parts[0]!.start, parts[0]!.end);
  const out = new Float32Array(parts.reduce((n, p) => n + p.end - p.start, 0));
  let at = 0;
  for (const p of parts) {
    out.set(samples.subarray(p.start, p.end), at);
    at += p.end - p.start;
  }
  return out;
}

export async function transcript(parts: Part[], transcribe: Transcribe, progress?: (done: number) => void): Promise<{ text: string; gaps: boolean }> {
  const texts: string[] = [];
  for (const [i, part] of parts.entries()) {
    progress?.(i);
    texts.push((await transcribe([part])).trim());
  }
  let gaps = false;
  const merged = new Set<number>(); // parts whose words are now in the part before them
  for (const [i, part] of parts.entries()) {
    if (merged.has(i) || !missing(texts[i]!, part.speech)) continue;
    const j = i > 0 ? i - 1 : i + 1;
    // Nothing to join it to, or a neighbour whose words are already in another text.
    if (j >= parts.length || merged.has(j)) {
      gaps = true;
      continue;
    }
    const [a, b] = j < i ? [j, i] : [i, j];
    const joined = (await transcribe([parts[a]!, parts[b]!])).trim();
    if (words(joined) > words(texts[a]!) + words(texts[b]!)) {
      texts[a] = joined;
      texts[b] = "";
      merged.add(b);
      if (missing(joined, parts[a]!.speech + parts[b]!.speech)) gaps = true;
    } else gaps = true;
  }
  return { text: texts.filter(Boolean).join(" "), gaps };
}

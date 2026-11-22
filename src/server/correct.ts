// Spoken corrections (lab#109, slice 3). On each finished turn, Workers AI's text model (FIX_MODEL) gets the text
// so far and the newest turn, and gives back the whole text: with a spoken edit made ("no, Tuesday", "scratch
// that") instead of typed out, and a spoken list as "- " lines. The prompt and its rules come from the lab#109
// spike (30 written cases and Erik's 6 spoken clips), tuned for its one miss: "scratch that" said in the same
// breath as the sentence it takes back.
//
// The model can fail, be slow or write junk. Then the turn's plain text is kept (joinTurn), so dictation always
// works. The text and the reply pass through memory only: nothing here stores, logs or throws them.
import { withoutBareItems } from "../core/list.ts";
import { joinTurn } from "../listen/protocol.ts";
import {
  CHARS_PER_TOKEN, FIX_INPUT_NEURONS_PER_M_TOKENS, FIX_MAX_TOKENS, FIX_MODEL, FIX_OUTPUT_NEURONS_PER_M_TOKENS, FIX_TIMEOUT_MS,
} from "./config.ts";
import { isQuotaRefusal } from "./quota.ts";

/** The AI binding's text generation (`env.AI.run(model, { messages, … })`). */
export interface TextAi {
  run(model: string, inputs: object): Promise<unknown>;
}

export const SYSTEM = `You are the typist behind a dictation box. The person speaks; you keep their text.
You get TEXT (what is written so far) and SAID (the newest thing they said, from speech-to-text).
Decide what SAID is:
- More dictation: add it to the end of TEXT, as written (fix only obvious punctuation).
- An instruction to change TEXT, such as "no, Tuesday", "I mean Hannah", "sorry, green", "make that eleven", "not the phone, the tablet", "scratch that", "delete that", "delete the last sentence", "change five to ten", "replace X with Y", "remove X", "new line", "make that a list": apply it to TEXT and do not write the instruction itself, or a word like "wait" or "oh" that leads into it.
- Both ("scratch that, call him on Friday"): apply the change, then add the new words.
SAID can also correct its own earlier words ("meet on Monday, no, Tuesday"): apply that too.
A short correction like "no, Tuesday" replaces the word it corrects and keeps the rest of the sentence.
"Scratch that" and "delete that" remove one sentence only: the last one before them. When they come in the middle of a sentence, with no full stop before them ("it takes ten seconds to load scratch that"), they remove only that unfinished sentence, back to the last full stop, and every sentence before it stays.
If SAID announces a list ("shopping list, milk, bread", "to do list. Buy milk. Call mom.") or asks for one, write a short heading line ending in ":" when a heading was said, then each item on its own line starting with "- ". Use no other formatting: no "*", no numbers, no bold, no headings.
Words like "no", "not", "replace", "scratch", "delete" or "list" that are simply part of what they mean to write stay as text ("No, I don't think the old design was better", "make the list view load faster", "she likes to scratch the sofa"). When unsure, treat SAID as dictation.
Reply with the full updated text inside <text></text> and nothing else.`;

export function fixPrompt(doc: string, said: string): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `TEXT:\n${doc || "(empty)"}\n\nSAID:\n${said}` },
  ];
}

/** Words in a turn that may take text away, so a reply that drops most of it can be an edit. */
const TAKES_AWAY = /\b(?:scratch|delete|remove|erase|cancel|forget|drop|clear|undo|start over|strike|get rid|never ?mind|cut|take (?:that|it) out)\b/i;
/** Markdown the reply mustn't add: only "- " lines are wanted. */
const MARKDOWN = ["*", "_", "`", "#", ">", "[", "]", "|", "~", "<"];
/** A line that is some other kind of list item: "+ x", "1. x", or a "- " item indented under another. */
const OTHER_ITEM = /^(?:\s*(?:[+*]|\d+[.)])|\s+-)\s/;
/** How much longer than the text and the turn together a reply may be: lists add a few marks, nothing adds more. */
const LONGER = 1.5;

const wordsOf = (s: string): string[] => s.toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];
const count = (s: string, c: string) => s.split(c).length - 1;

/**
 * The model's new text, or null when its reply is junk: not the text inside <text></text> and nothing else;
 * much longer than the text and the turn; adding markdown other than "- " lines; words of its own (a
 * preamble, an explanation); or dropping most of the text, or all of it, with no command like "scratch that".
 */
export function readFix(raw: string, doc: string, said: string): string | null {
  const m = /^\s*<text>([\s\S]*)<\/text>\s*$/.exec(raw);
  if (!m || /<\/?text>/.test(m[1])) return null;
  // An empty item ("-" alone, or with only punctuation) is never wanted, and a reply of nothing else is an empty one.
  const text = withoutBareItems(m[1]).trim();
  const input = `${doc}\n${said}`;
  if (text.length > LONGER * input.length + 40) return null;
  if (MARKDOWN.some((c) => count(text, c) > count(input, c))) return null;
  if (text.split("\n").some((line) => OTHER_ITEM.test(line))) return null;
  const known = new Set(wordsOf(input));
  const out = wordsOf(text);
  const fresh = out.map((w) => !known.has(w));
  if (fresh.filter(Boolean).length > Math.max(3, out.length / 5)) return null;
  if (fresh[0] && fresh[1]) return null; // "Sure, here…", "I have…"
  const takesAway = TAKES_AWAY.test(said);
  if (!text && !takesAway) return null;
  if (out.length < (wordsOf(doc).length + wordsOf(said).length) / 2 - 2 && !takesAway) return null;
  return text;
}

/** The neurons a correction cost: from Workers AI's token usage when the reply has it, otherwise an estimate. */
export function fixNeurons(usage: unknown, promptChars: number, replyChars: number): number {
  const u = (usage ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const [input, output] = ok(u.prompt_tokens) && ok(u.completion_tokens)
    ? [u.prompt_tokens, u.completion_tokens]
    : [Math.ceil(promptChars / CHARS_PER_TOKEN), Math.ceil(replyChars / CHARS_PER_TOKEN)];
  return (input * FIX_INPUT_NEURONS_PER_M_TOKENS + output * FIX_OUTPUT_NEURONS_PER_M_TOKENS) / 1e6;
}

/**
 * The turn's outcome: Workers AI's daily refusal (`quota`, which closes the day), or the new text, `fixed` when
 * it's the model's and otherwise the turn's plain text after the text so far, with the neurons it cost.
 */
export type Fix = { quota: true } | { quota: false; text: string; fixed: boolean; neurons: number };

/** Asks the correction model once, within FIX_TIMEOUT_MS. Never throws. */
export async function correct(ai: TextAi, doc: string, said: string): Promise<Fix> {
  const plain = joinTurn(doc, said);
  const messages = fixPrompt(doc, said);
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<"late">((done) => (timer = setTimeout(() => done("late"), FIX_TIMEOUT_MS)));
  const inputs = { messages, temperature: 0, max_tokens: Math.min(FIX_MAX_TOKENS, Math.ceil(plain.length / 2) + 64) };
  let reply: unknown;
  try {
    reply = await Promise.race([Promise.resolve().then(() => ai.run(FIX_MODEL, inputs)), late]);
  } catch (error) {
    // Failed or refused: nothing was written, and the error (which may quote the prompt) goes no further.
    if (isQuotaRefusal(error)) return { quota: true };
    return { quota: false, text: plain, fixed: false, neurons: 0 };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  // Too slow: the model may still do the work, so it's counted as if it wrote the whole text.
  if (reply === "late") return { quota: false, text: plain, fixed: false, neurons: fixNeurons(null, promptChars, plain.length) };
  const r = (typeof reply === "object" && reply !== null ? reply : {}) as { response?: unknown; usage?: unknown };
  const raw = typeof r.response === "string" ? r.response : "";
  const neurons = fixNeurons(r.usage, promptChars, raw.length);
  const text = readFix(raw, doc, said);
  return text === null ? { quota: false, text: plain, fixed: false, neurons } : { quota: false, text, fixed: true, neurons };
}

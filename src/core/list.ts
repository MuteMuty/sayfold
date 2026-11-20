// Saying "list" turns what follows into a GitHub task list in the issue's body (lab#80).
// Speech has no line breaks, and the speech model puts in its own punctuation: the same words come back as
// "Groceries. List. Milk. Bread. End list." or as "Groceries, list, milk, bread, and list," (see
// tests/fixtures/list-transcripts.json). So the transcript is read sentence by sentence and line by line,
// and each sentence part by part between its commas:
// - "list" standing alone, as a sentence, a line or a part between commas, or "list:" anywhere, starts a list;
// - "end list", "and list" (as the model often hears it) or "end of list", standing alone or ending a part
//   while a list is open, ends it. With no list open they're just words.
// The editable transcript stays the one source: this turns it into the body when it's sent or copied.

export type Block = { kind: "text"; text: string } | { kind: "list"; items: string[] };

const LIST = /^list[.!?]*$/i;
const COLON = /\blist:/i;
const ENDS = ["end of list", "end list", "and list"];
/** What's trimmed from the end of the words before a list: spaces, and the marks that led into it. */
const LEAD_END = /[\s,;:–—-]/;
/** What's trimmed from the end of an item: spaces, full stops and commas. */
const ITEM_END = /[\s.,;]/;

/** `s` without any characters matching `one` (a one-character pattern) at its end. A plain loop, not a regex
 *  like `/[\s.]+$/`, which takes seconds on a long run of spaces or dots pasted into the text. */
export function trimEndOf(s: string, one: RegExp): string {
  let end = s.length;
  while (end > 0 && one.test(s[end - 1])) end--;
  return s.slice(0, end);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One part of the transcript: between commas (or semicolons), full stops (or ! and ?) and line breaks. A comma
 *  or a sentence's end mark counts when a space or the end follows, so "2.5" or "1,000" stay whole.
 *  `start` and `end` are where it is in the text (`end` after its comma or end mark), `upTo` where its words
 *  end (before a comma), `said` its words trimmed, with a sentence's end mark. `unit` numbers its sentence or
 *  line, and `whole` says it's all of it. */
type Part = { start: number; end: number; upTo: number; said: string; unit: number; whole: boolean };

function parts(text: string): Part[] {
  const out: Part[] = [];
  let start = 0;
  let unit = 0;
  /** Where this sentence's parts start in `out`. */
  let first = 0;
  for (let i = 0; i <= text.length; i++) {
    const line = i === text.length || text[i] === "\n";
    const spaced = i + 1 === text.length || /\s/.test(text[i + 1] ?? "");
    const stop = !line && spaced && /[.!?]/.test(text[i]);
    const comma = !line && spaced && (text[i] === "," || text[i] === ";");
    if (!line && !stop && !comma) continue;
    const end = line ? i : i + 1;
    const upTo = comma ? i : end;
    const said = text.slice(start, upTo).trim();
    if (said) out.push({ start, end, upTo, said, unit, whole: false });
    start = i + 1;
    if (comma) continue;
    if (out.length - first === 1 && out[first].unit === unit) out[first].whole = true;
    unit++;
    first = out.length;
  }
  return out;
}

/** The words before "end list" (or "and list", "end of list") when a part ends with it, or null. */
function endOf(said: string): string | null {
  const s = trimEndOf(said, /[.!?]/);
  for (const e of ENDS) {
    if (s.length < e.length || s.slice(-e.length).toLowerCase() !== e) continue;
    if (s.length === e.length) return "";
    if (/\s/.test(s[s.length - e.length - 1])) return s.slice(0, -e.length).trim();
  }
  return null;
}

/** One task: trimmed, without a list marker typed by hand, a leading "and" or the full stop, starting with a capital. */
function item(s: string) {
  const t = s.trim().replace(/^[-*]\s+(?:\[ \]\s*)?/, "").replace(/^and\s+/i, "");
  return capital(trimEndOf(t, ITEM_END));
}

/** The text as paragraphs and lists, or null when nothing in it says "list". */
export function parseList(text: string): Block[] | null {
  const blocks: Block[] = [];
  let found = false;
  /** Where the paragraph now going on starts in the text, and whether it follows a list (so it starts with a capital). */
  let from = 0;
  let afterList = false;
  /** The list being said: its parts, each with its sentence, and whether every part is an item (after
   *  "list," or "list:") or every sentence is (after "list" as a sentence of its own). */
  let list = null as { byPart: boolean; said: { unit: number; raw: string; said: string }[] } | null;

  const para = (s: string) => {
    const t = s.trim();
    if (t) blocks.push({ kind: "text", text: afterList ? capital(t) : t });
    afterList = false;
  };
  /** The words before the list. After "list" as a part of a sentence, they lead into it: "Things to try:". */
  const lead = (at: number, part: boolean) => {
    if (!part) return para(text.slice(from, at));
    const t = trimEndOf(text.slice(from, at), LEAD_END);
    para(t && !/[.!?]/.test(t[t.length - 1]) ? `${t}:` : t);
  };
  const open = (byPart: boolean) => {
    list = { byPart, said: [] };
    found = true;
  };
  const close = () => {
    const { byPart, said } = list!;
    // A list said as one sentence ("List. Milk, bread, eggs.") is split at its commas too.
    const one = said.every((p) => p.unit === said[0].unit);
    const raw: string[] = [];
    if (byPart || one) raw.push(...said.map((p) => p.said));
    else said.forEach((p, i) => (i > 0 && p.unit === said[i - 1].unit ? (raw[raw.length - 1] += p.raw) : raw.push(p.raw)));
    const tasks = raw.map(item).filter(Boolean);
    if (tasks.length) blocks.push({ kind: "list", items: tasks });
    list = null;
    afterList = true;
  };

  for (const p of parts(text)) {
    if (list) {
      const before = endOf(p.said);
      if (before !== null) {
        if (before) list.said.push({ unit: p.unit, raw: before, said: before });
        close();
        from = p.end;
      } else if (!LIST.test(p.said)) list.said.push({ unit: p.unit, raw: text.slice(p.start, p.end), said: p.said });
      continue;
    }
    if (LIST.test(p.said)) {
      lead(p.start, !p.whole);
      open(!p.whole);
      continue;
    }
    const m = COLON.exec(text.slice(p.start, p.upTo));
    if (!m) continue;
    const at = p.start + m.index;
    lead(at, true);
    open(true);
    const rest = text.slice(at + 5, p.upTo).trim();
    if (rest) list!.said.push({ unit: p.unit, raw: rest, said: rest });
  }
  if (list) close();
  else para(text.slice(from));
  return found ? blocks : null;
}

/** What the review screen previews: the paragraphs and lists, or null when there's no list with anything in it. */
export function blocksFrom(text: string): Block[] | null {
  const blocks = parseList(text);
  return blocks?.some((b) => b.kind === "list") ? blocks : null;
}

/** The issue's body, and what Copy copies: the transcript with its spoken lists as GitHub task lists. Without
 *  "list", the text exactly as it was, trimmed. */
export function bodyFrom(text: string): string {
  const blocks = parseList(text);
  if (!blocks) return text.trim();
  return blocks.map((b) => (b.kind === "text" ? b.text : b.items.map((i) => `- [ ] ${i}`).join("\n"))).join("\n\n");
}

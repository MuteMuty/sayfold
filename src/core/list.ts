// Lines that start with "- " are sent as a GitHub task list in the issue's body. With live text, the correction
// model writes a spoken list that way ("Shopping list:\n- Milk\n- Bread", lab#109), and anyone can type one in the
// review. Nothing else in the text makes a list: "list" is just a word (lab#102), and the in-browser model,
// which has no spoken edits, types what was said. The editable transcript stays the one source: this turns it
// into the body when it's sent or copied.

export type Block = { kind: "text"; text: string } | { kind: "list"; items: string[] };

/** A list item's line: "- " (after any spaces), and its words, without a task box typed by hand. A dash alone on
 *  its line (a "- " whose space was trimmed) is an item too, with no words. */
const ITEM = /^\s*-(?:\s+|$)(?:\[ \]\s*)?/;

/** A line that's only a list mark ("- ", "-" or "- [ ]"): an empty item, which is never a title or a task. Trimmed
 *  first, not one regex with two runs of spaces, which takes seconds on a long run of them. */
export function isBareItem(line: string): boolean {
  const t = line.trim();
  return t === "-" || /^-\s*\[ \]$/.test(t);
}

/** `text` without its bare item lines, or `text` itself when it has none. */
export function withoutBareItems(text: string): string {
  const lines = text.split("\n");
  return lines.some(isBareItem) ? lines.filter((l) => !isBareItem(l)).join("\n") : text;
}
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

/** The text as paragraphs and lists, or null when no line is a "- " item with words. Blank lines end a paragraph. */
export function parseList(text: string): Block[] | null {
  const blocks: Block[] = [];
  let found = false;
  let para: string[] = [];
  let list: string[] | null = null;
  const endPara = () => {
    const t = para.join("\n").trim();
    if (t) blocks.push({ kind: "text", text: t });
    para = [];
  };
  const endList = () => {
    if (list?.length) blocks.push({ kind: "list", items: list });
    list = null;
  };
  for (const line of text.split("\n")) {
    const m = ITEM.exec(line);
    const item = m && capital(trimEndOf(line.slice(m[0].length), ITEM_END));
    if (item) {
      found = true;
      endPara();
      (list ??= []).push(item);
    } else if (!m) {
      endList();
      if (line.trim()) para.push(line);
      else endPara();
    }
  }
  endList();
  endPara();
  return found ? blocks : null;
}

/** What the review screen previews: the paragraphs and lists, or null when there's no list with anything in it. */
export function blocksFrom(text: string): Block[] | null {
  const blocks = parseList(text);
  return blocks?.some((b) => b.kind === "list") ? blocks : null;
}

/** The issue's body, and what Copy copies: the transcript with its "- " lines as GitHub task lists. Without them,
 *  the text exactly as it was, trimmed. An empty item ("- " alone on its line) is left out either way. */
export function bodyFrom(text: string): string {
  const blocks = parseList(text);
  if (!blocks) return withoutBareItems(text).trim();
  return blocks.map((b) => (b.kind === "text" ? b.text : b.items.map((i) => `- [ ] ${i}`).join("\n"))).join("\n\n");
}

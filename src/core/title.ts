// The title filled in from the transcript, and what Copy puts on the clipboard.
import { bodyFrom, parseList, trimEndOf } from "./list.ts";

export const TITLE_MAX = 72;
const MIN_CLAUSE = 6;

/** The first line, or its first sentence when the transcript is one paragraph, capitalised; a long one ends at a clause break or a word.
 * With a spoken list, the words before it ("Things to try, list, dark mode" gives "Things to try"), or its first item when it's said first. */
export function titleFrom(text: string): string {
  const blocks = parseList(text);
  if (!blocks) return firstTitle(text);
  const first = blocks[0];
  if (!first) return "";
  return firstTitle(first.kind === "text" ? trimEndOf(first.text, /:/) : first.items[0]);
}

function firstTitle(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  // A sentence ends at . ! or ? followed by a space. A full stop is dropped; ! and ? are kept.
  const end = line.search(/[.!?](\s|$)/);
  let t = end < 0 ? line : line[end] === "." ? line.slice(0, end) : line.slice(0, end + 1);
  t = t.replace(/\s+/g, " ").trim();
  // Too long: end at the first clause break (a comma, semicolon, colon or dash) that leaves a real title.
  if (t.length > TITLE_MAX) {
    const clause = [...t.matchAll(/\s*(?:[,;:]|\s[-–—])\s/g)].find((m) => m.index >= MIN_CLAUSE && m.index <= TITLE_MAX);
    if (clause) t = t.slice(0, clause.index);
  }
  if (t.length > TITLE_MAX) {
    const room = t.slice(0, TITLE_MAX - 1);
    const space = room.lastIndexOf(" ");
    t = `${(space > TITLE_MAX / 2 ? room.slice(0, space) : room).trimEnd()}…`;
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** For comparing a title with the text: case, spacing and the end mark don't count. */
const plain = (s: string) => trimEndOf(s.replace(/\s+/g, " ").trim(), /[.!?…]/).toLowerCase();

/** What Copy puts on the clipboard (the title, a blank line, then the text as Send sends it, with any spoken list as a
 *  task list; either may be empty), and what it says. A title that's the whole text is copied once. */
export function copyNote(title: string, text: string): { text: string; message: string } {
  const t = title.trim();
  const x = bodyFrom(text);
  if (t && x && plain(t) === plain(x)) return { text: x, message: "Copied the text" };
  if (t && x) return { text: `${t}\n\n${x}`, message: "Copied the title and text" };
  if (x) return { text: x, message: "Copied the text" };
  if (t) return { text: t, message: "Copied the title" };
  return { text: "", message: "There's nothing to copy yet" };
}

export const clipboardText = (title: string, text: string) => copyNote(title, text).text;

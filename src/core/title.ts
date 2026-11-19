// The title filled in from the transcript, and what Copy puts on the clipboard.

export const TITLE_MAX = 72;
const MIN_CLAUSE = 6;

/** The first line, or its first sentence when the transcript is one paragraph, capitalised; a long one ends at a clause break or a word. */
export function titleFrom(text: string): string {
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

/** Title, a blank line, then the text; either may be empty. */
export const clipboardText = (title: string, text: string) => [title.trim(), text.trim()].filter(Boolean).join("\n\n");

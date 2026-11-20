// Saying "list" turns what follows into a GitHub task list in the issue's body (lab#80).
// Speech has no line breaks, so the transcript is read sentence by sentence (and line by line, for lines typed
// by hand): "list" as its own sentence, or "list:" anywhere, starts a list, and "end list" as its own sentence
// ends it. The editable transcript stays the one source: this turns it into the body when it's sent.

export type Block = { kind: "text"; text: string } | { kind: "list"; items: string[] };

const LIST = /^list[.!?]*$/i;
const END = /^end (?:of )?list[.!?]*$/i;
const COLON = /\blist:/i;

/** The transcript's sentences and lines, each with where it is in the text. A sentence ends at . ! or ? and a space, as for the title. */
function units(text: string) {
  const out: { start: number; end: number; said: string }[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const line = i === text.length || text[i] === "\n";
    const stop = !line && /[.!?]/.test(text[i]) && (i + 1 === text.length || /\s/.test(text[i + 1]));
    if (!line && !stop) continue;
    const end = stop ? i + 1 : i;
    const said = text.slice(start, end).trim();
    if (said) out.push({ start, end, said });
    start = i + 1;
  }
  return out;
}

/** One task: trimmed, without a list marker typed by hand or the full stop, starting with a capital. */
function item(s: string) {
  const t = s.trim().replace(/^[-*]\s+(?:\[ \]\s*)?/, "").replace(/\.+$/, "").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The body as paragraphs and lists, or null when nothing in it says "list". */
function parse(text: string): Block[] | null {
  const blocks: Block[] = [];
  const para = (s: string) => {
    const t = s.trim();
    if (t) blocks.push({ kind: "text", text: t });
  };
  let found = false;
  /** Where the paragraph now going on starts in the text. */
  let from = 0;
  let list: string[] | null = null;
  let colon = false;
  const close = (items: string[]) => {
    // "list: dark mode, offline send", with nothing after it: one item per part.
    const tasks = (colon && items.length === 1 ? items[0].split(",") : items).map(item).filter(Boolean);
    if (tasks.length) blocks.push({ kind: "list", items: tasks });
    list = null;
  };
  for (const u of units(text)) {
    if (list) {
      if (END.test(u.said)) {
        close(list);
        from = u.end;
      } else if (!LIST.test(u.said)) list.push(u.said);
      continue;
    }
    if (LIST.test(u.said)) {
      para(text.slice(from, u.start));
      [list, colon, found] = [[], false, true];
      continue;
    }
    const m = COLON.exec(text.slice(u.start, u.end));
    if (!m) continue;
    const at = u.start + m.index;
    // The words before "list:" stay a paragraph, and lead into the list.
    const lead = text.slice(from, at).trim().replace(/[\s,;:–—-]+$/, "");
    if (lead) para(/[.!?]$/.test(lead) ? lead : `${lead}:`);
    const rest = text.slice(at + 5, u.end).trim();
    [list, colon, found] = [rest ? [rest] : [], true, true];
  }
  if (list) close(list);
  else para(text.slice(from));
  return found ? blocks : null;
}

/** What the review screen previews: the paragraphs and lists, or null when there's no list with anything in it. */
export function blocksFrom(text: string): Block[] | null {
  const blocks = parse(text);
  return blocks?.some((b) => b.kind === "list") ? blocks : null;
}

/** The issue's body: the transcript with its spoken lists as GitHub task lists. Without "list", the text exactly as it was, trimmed. */
export function bodyFrom(text: string): string {
  const blocks = parse(text);
  if (!blocks) return text.trim();
  return blocks.map((b) => (b.kind === "text" ? b.text : b.items.map((i) => `- [ ] ${i}`).join("\n"))).join("\n\n");
}

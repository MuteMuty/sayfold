import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bodyFrom, blocksFrom } from "../../src/core/list.ts";
import { titleFrom, copyNote } from "../../src/core/title.ts";

test("\"list\" as its own sentence turns the sentences after it into task-list items", () => {
  assert.equal(bodyFrom("Groceries. List. Milk. Bread. Eggs."), "Groceries.\n\n- [ ] Milk\n- [ ] Bread\n- [ ] Eggs");
});

test("\"list:\" with commas gives one item per part, and the words before it stay a paragraph", () => {
  assert.equal(bodyFrom("Things to try, list: dark mode, offline send"), "Things to try:\n\n- [ ] Dark mode\n- [ ] Offline send");
  assert.equal(bodyFrom("List: dark mode, offline send."), "- [ ] Dark mode\n- [ ] Offline send");
});

test("after \"list:\" or \"list,\", every part between commas or full stops is an item", () => {
  assert.equal(bodyFrom("List: milk, bread. Eggs."), "- [ ] Milk\n- [ ] Bread\n- [ ] Eggs");
  assert.equal(bodyFrom("List, milk; bread. Eggs"), "- [ ] Milk\n- [ ] Bread\n- [ ] Eggs");
});

test("after \"list\" as its own sentence, each sentence is an item, commas and all, unless the list is one sentence", () => {
  assert.equal(bodyFrom("List. Call Ann, then Bob. Eggs."), "- [ ] Call Ann, then Bob\n- [ ] Eggs");
  assert.equal(bodyFrom("Things to try. List. Dark mode, offline send, and a shortcut. End list."), "Things to try.\n\n- [ ] Dark mode\n- [ ] Offline send\n- [ ] A shortcut");
});

test("\"end list\" ends the list, and what follows is a paragraph again", () => {
  assert.equal(
    bodyFrom("Groceries. List. Milk. Bread. End list. Then the bank before it shuts."),
    "Groceries.\n\n- [ ] Milk\n- [ ] Bread\n\nThen the bank before it shuts.",
  );
  assert.equal(bodyFrom("To try, list: dark mode, offline send. End list. Soon."), "To try:\n\n- [ ] Dark mode\n- [ ] Offline send\n\nSoon.");
});

test("a second list can follow the first", () => {
  assert.equal(bodyFrom("List. A. End list. Then. List. B."), "- [ ] A\n\nThen.\n\n- [ ] B");
});

test("lines typed by hand inside a list are items too", () => {
  assert.equal(bodyFrom("Groceries. List. Milk.\nbread\n  oat milk  \n\nEggs"), "Groceries.\n\n- [ ] Milk\n- [ ] Bread\n- [ ] Oat milk\n- [ ] Eggs");
  // A typed list marker is not doubled.
  assert.equal(bodyFrom("List\n- milk\n- [ ] bread\n* eggs"), "- [ ] Milk\n- [ ] Bread\n- [ ] Eggs");
});

test("lines typed by hand before a list keep their line breaks", () => {
  assert.equal(bodyFrom("Weekend\nat the cabin\nlist\nwood\nmatches"), "Weekend\nat the cabin\n\n- [ ] Wood\n- [ ] Matches");
});

test("items are trimmed, keep their words, lose the full stop and start with a capital", () => {
  assert.equal(bodyFrom("List.   call the plumber on Friday.  is the gate fixed? fix it!"), "- [ ] Call the plumber on Friday\n- [ ] Is the gate fixed?\n- [ ] Fix it!");
});

test("\"list\" inside a sentence does nothing, and the text is sent exactly as it was", () => {
  for (const text of ["My shopping list is long. Milk. Bread.", "  Make a list of the plants.\nWater them.  ", "Listen. Listing. Enlist."]) {
    assert.equal(bodyFrom(text), text.trim());
    assert.equal(blocksFrom(text), null);
  }
});

test("an empty list adds nothing: no empty items, and no stray \"List\"", () => {
  assert.equal(bodyFrom("Groceries. List."), "Groceries.");
  assert.equal(bodyFrom("List."), "");
  assert.equal(bodyFrom("Groceries. List. End list. Later."), "Groceries.\n\nLater.");
  assert.equal(bodyFrom("Ideas, list:"), "Ideas:");
  assert.equal(bodyFrom("List. . ."), "");
});

test("transcripts from the speech model without punctuation", () => {
  // No full stops at all: "list" can't be its own sentence, so nothing changes.
  for (const text of ["groceries list milk bread eggs", "list milk bread eggs"]) assert.equal(bodyFrom(text), text);
  // Lowercase, and no full stop at the very end.
  assert.equal(bodyFrom("groceries. list. milk. bread"), "groceries.\n\n- [ ] Milk\n- [ ] Bread");
  // "list" said last, with no mark after it.
  assert.equal(bodyFrom("Groceries. List"), "Groceries.");
  // "end list" without its full stop at the end.
  assert.equal(bodyFrom("List. Milk. End list"), "- [ ] Milk");
});

test("\"list\" and \"end list\" may be said in any case, with any end mark", () => {
  assert.equal(bodyFrom("LIST! milk? END LIST. ok"), "- [ ] Milk?\n\nOk");
});

test("\"end list\" outside a list is left alone", () => {
  assert.equal(bodyFrom("End list. Then milk."), "End list. Then milk.");
});

test("the blocks say what the preview shows: paragraphs and the items", () => {
  assert.deepEqual(blocksFrom("Groceries. List. Milk. Bread. End list. Later."), [
    { kind: "text", text: "Groceries." },
    { kind: "list", items: ["Milk", "Bread"] },
    { kind: "text", text: "Later." },
  ]);
  assert.equal(blocksFrom("Groceries. List."), null, "an empty list is no list");
});

// --- what the speech model really writes (tests/fixtures/list-transcripts.json, and how it was made) ------

const fixtures: { from: string; text: string; title: string; body: string }[] = JSON.parse(
  readFileSync(new URL("../fixtures/list-transcripts.json", import.meta.url), "utf8"),
).transcripts;

test("every real transcript gives the body and the title it should", () => {
  assert.ok(fixtures.length >= 15);
  for (const f of fixtures) {
    assert.equal(bodyFrom(f.text), f.body, f.from);
    assert.equal(titleFrom(f.text), f.title, f.from);
  }
});

test("the model's commas: \"list,\" marks the list, \"and list\" ends it, and what follows is a paragraph with a capital", () => {
  assert.deepEqual(blocksFrom("Groceries for the weekend, list, milk, bread, eggs, and list, then call the bank."), [
    { kind: "text", text: "Groceries for the weekend:" },
    { kind: "list", items: ["Milk", "Bread", "Eggs"] },
    { kind: "text", text: "Then call the bank." },
  ]);
  assert.equal(bodyFrom("List, milk, bread, end list, done."), "- [ ] Milk\n- [ ] Bread\n\nDone.");
  assert.equal(bodyFrom("Trip, list, passport, end of list."), "Trip:\n\n- [ ] Passport");
  // "list" closing a sentence of its own words.
  assert.equal(bodyFrom("Groceries, list. Milk. Bread."), "Groceries:\n\n- [ ] Milk\n- [ ] Bread");
});

test("a last item said with \"and\" loses it", () => {
  assert.equal(bodyFrom("Things to try, list, dark mode, offline send, and a shortcut."), "Things to try:\n\n- [ ] Dark mode\n- [ ] Offline send\n- [ ] A shortcut");
  assert.equal(bodyFrom("List. Milk. And bread."), "- [ ] Milk\n- [ ] Bread");
  // "and" inside an item stays: it can't be told from "bread and butter".
  assert.equal(bodyFrom("List, salt and pepper, bread and butter."), "- [ ] Salt and pepper\n- [ ] Bread and butter");
});

test("\"and list\" or \"end list\" at the end of an item's words ends the list there", () => {
  assert.equal(bodyFrom("Groceries for the weekend. List, Milk, Bread eggs And list, Then called a bank."), "Groceries for the weekend.\n\n- [ ] Milk\n- [ ] Bread eggs\n\nThen called a bank.");
});

test("\"and list\" or \"end list\" with no list open does nothing, and the text is sent exactly as it was", () => {
  for (const text of [
    "Bread, and list.",
    "Read the report and list the costs.",
    "Milk, eggs, and list, then the bank.",
    "And list. Then milk.",
    "Read the report and list the costs, then make a list of the plants, my shopping list is long.",
    "A list of things, my shopping list, the guest list.",
    "Enlist, listen, listing, list-making, lists.",
  ]) {
    assert.equal(bodyFrom(text), text);
    assert.equal(blocksFrom(text), null);
  }
});

/** A small seeded random number generator, so every run sees the same transcripts. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

test("fuzz: any transcript without \"list\" said on its own (or \"list:\") is sent byte for byte as it was, trimmed", () => {
  const words = ["list", "and", "end", "of", "List", "LIST", "milk", "the", "a", "Listen", "enlist", "lists", "list-making", "my", "shopping", "is", "long", "9", "2.5", "e.g."];
  const gaps = [" ", " ", " ", ", ", ". ", "? ", "! ", "; ", "\n", "  ", " - ", "\n\n", ".\n", ": "];
  // A marker is "list" standing alone between punctuation or line breaks, or "list:" anywhere.
  const marker = /(?:^|[,;.!?\n])\s*list\s*(?:[,;:.!?\n]|$)|list:/i;
  const next = rng(80);
  const pick = <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)];
  let checked = 0;
  for (let n = 0; n < 20000; n++) {
    let text = next() < 0.3 ? " " : "";
    const len = 1 + Math.floor(next() * 14);
    for (let i = 0; i < len; i++) text += pick(words) + (i < len - 1 ? pick(gaps) : pick(["", ".", "!", " ", "\n"]));
    if (marker.test(text)) continue;
    checked++;
    assert.equal(bodyFrom(text), text.trim(), JSON.stringify(text));
    assert.equal(blocksFrom(text), null, JSON.stringify(text));
    assert.equal(copyNote("", text).text, text.trim(), JSON.stringify(text));
  }
  assert.ok(checked > 5000, `only ${checked} transcripts without a list`);
});

// --- long pasted text: everything that runs on each keystroke stays linear -----------------------------

test("50,000 spaces, dots, commas or the like format in well under 100 ms", () => {
  const n = 50000;
  const inputs = [
    " ".repeat(n),
    ".".repeat(n),
    `a${" ".repeat(n)}b`,
    `a${".".repeat(n)}b`,
    `List. ${".".repeat(n)}x`,
    `List. a${" ".repeat(n)}.x`,
    `Ideas${" ".repeat(n)}, list: milk`,
    `Ideas,${" ".repeat(n)}x list: milk`,
    `List, milk${",".repeat(n)}x`,
    `List, milk${", ".repeat(n / 2)}x`,
    `List, a${" ".repeat(n)}and list`,
    `List, ${"and ".repeat(n / 4)}x`,
    `${"list ".repeat(n / 5)}`,
    `${"list, ".repeat(n / 6)}`,
    `${"list. ".repeat(n / 6)}`,
    `${"end list, ".repeat(n / 10)}`,
    `${"- ".repeat(n / 2)}x`,
    `List\n-${" ".repeat(n)}x`,
    `${"!?".repeat(n / 2)}x`,
    "\n".repeat(n),
    `a${"\t \n".repeat(n / 3)}b`,
    `${"…".repeat(n)}x`,
  ];
  for (const text of inputs) {
    const t0 = performance.now();
    bodyFrom(text);
    blocksFrom(text);
    const title = titleFrom(text);
    copyNote(title, text);
    copyNote(text, text);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `${ms.toFixed(0)} ms for ${JSON.stringify(text.slice(0, 20))}… (${text.length} characters)`);
  }
});

// Lines that start with "- " become a GitHub task list (src/core/list.ts): the correction model writes a spoken
// list that way (lab#109), and they can be typed in the review. Nothing else makes a list: "list" is a word (lab#102).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyFrom, blocksFrom } from "../../src/core/list.ts";
import { titleFrom, copyNote } from "../../src/core/title.ts";

test("\"- \" lines become a task list, and the lines before and after it stay paragraphs", () => {
  assert.equal(bodyFrom("Shopping list:\n- Milk\n- Bread\n- Eggs\n- Butter"), "Shopping list:\n\n- [ ] Milk\n- [ ] Bread\n- [ ] Eggs\n- [ ] Butter");
  assert.deepEqual(blocksFrom("The login page is slow.\nTo do list:\n- By milk\n- Call mom\nThen call the bank."), [
    { kind: "text", text: "The login page is slow.\nTo do list:" },
    { kind: "list", items: ["By milk", "Call mom"] },
    { kind: "text", text: "Then call the bank." },
  ]);
  assert.equal(bodyFrom("- A\n- B\n\nThen.\n\n- C"), "- [ ] A\n- [ ] B\n\nThen.\n\n- [ ] C");
});

test("the correction model's lists (Erik's clips c3 and c5) give the body and title they should", () => {
  assert.equal(bodyFrom("Shopping list:\n- milk\n- bread\n- eggs\n- butter"), "Shopping list:\n\n- [ ] Milk\n- [ ] Bread\n- [ ] Eggs\n- [ ] Butter");
  assert.equal(titleFrom("Shopping list:\n- milk\n- bread\n- eggs\n- butter"), "Shopping list");
  assert.equal(bodyFrom("To do list:\n- Buy milk\n- Call mom"), "To do list:\n\n- [ ] Buy milk\n- [ ] Call mom");
  assert.equal(titleFrom("To do list:\n- Buy milk\n- Call mom"), "To do list");
  assert.equal(titleFrom("- Login\n- Sign up"), "Login", "a list with no heading takes its first item");
});

test("items are trimmed, lose a full stop or comma, start with a capital, and a typed task box isn't doubled", () => {
  assert.equal(bodyFrom("-   oat milk.  \n  - bread,\n- [ ] eggs"), "- [ ] Oat milk\n- [ ] Bread\n- [ ] Eggs");
  assert.deepEqual(blocksFrom("Groceries\n- milk\n- \n- bread"), [{ kind: "text", text: "Groceries" }, { kind: "list", items: ["Milk", "Bread"] }]);
  assert.equal(blocksFrom("Groceries\n- "), null, "an empty item is no list");
});

test("a bare \"- \" line, first or anywhere, is never the title or an empty task-list item: it's left out", () => {
  // Spoken (the correction model's reply) or typed: a line that is only "- " (or "-", or "- [ ]"), with or without words after.
  for (const [text, title, body] of [
    ["- \nBuy milk.", "Buy milk", "Buy milk."],
    ["- \n- milk\n- bread", "Milk", "- [ ] Milk\n- [ ] Bread"],
    ["-\nCall the bank. Then lunch.", "Call the bank", "Call the bank. Then lunch."],
    ["  - [ ]  \nShopping list:\n- milk", "Shopping list", "Shopping list:\n\n- [ ] Milk"],
    ["Groceries\n- ", "Groceries", "Groceries"],
    ["Groceries\n-", "Groceries", "Groceries"],
    ["Groceries\n- \n- milk\n- \n- bread\n- ", "Groceries", "Groceries\n\n- [ ] Milk\n- [ ] Bread"],
    ["Weekend\n- \nat the cabin", "Weekend", "Weekend\nat the cabin"],
  ] as const) {
    assert.equal(titleFrom(text), title, JSON.stringify(text));
    assert.equal(bodyFrom(text), body, JSON.stringify(text));
    assert.doesNotMatch(bodyFrom(text), /^\s*-\s*(?:\[ \])?\s*$/m, `an empty item in ${JSON.stringify(text)}`);
    assert.equal(copyNote("", text).text, body, JSON.stringify(text));
  }
  // Nothing but bare lines: no title, nothing to send.
  for (const text of ["- ", "-", "- \n- \n", "- [ ]"]) {
    assert.equal(titleFrom(text), "", JSON.stringify(text));
    assert.equal(bodyFrom(text), "", JSON.stringify(text));
  }
  // Other dashes are still words.
  assert.equal(titleFrom("-5 degrees tonight."), "-5 degrees tonight");
  assert.equal(titleFrom("---\nNotes"), "---");
});

test("only a dash and a space start an item: other dashes are just text", () => {
  for (const text of ["-5 degrees tonight.", "Well -- maybe.", "---\nNotes", "A well-known bug - in the header.", "Bread – and butter."]) {
    assert.equal(bodyFrom(text), text);
    assert.equal(blocksFrom(text), null, text);
  }
});

test("lab#102: \"list:\" inside a sentence stays plain text, and the spoken \"list\" rule is gone", () => {
  for (const text of [
    "My shopping list: milk, eggs",
    "Tell me the list: ",
    "Things to try, list: dark mode, offline send",
    // What the in-browser model wrote for spoken lists (sayfold#4): it has no spoken edits, so they stay as said.
    "Groceries for the weekend, list, milk, bread, eggs, and list, then call the bank.",
    "Groceries for the weekend. List. Milk. Bread. Eggs. End list. Then call the bank.",
    "Packing for the trip. List. Passport. Phone charger. Rain jacket. End of list. Leave at nine.",
    "Read the report and list the costs, then make a list of the plants. My shopping list is long.",
    "List.",
  ]) {
    assert.equal(bodyFrom(text), text.trim(), text);
    assert.equal(blocksFrom(text), null, text);
    assert.equal(copyNote("", text).text, text.trim(), text);
  }
  assert.equal(titleFrom("My shopping list: milk, eggs"), "My shopping list: milk, eggs");
});

/** A small seeded random number generator, so every run sees the same transcripts. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

test("fuzz: any text without a \"- \" item line, or an empty one, is sent byte for byte as it was, trimmed", () => {
  const words = ["list", "and", "end", "of", "List", "LIST:", "milk", "the", "a", "-", "--", "-5", "e.g.", "[ ]", "*", "2.5", "list:", "well-known"];
  const gaps = [" ", " ", " ", ", ", ". ", "? ", "! ", "; ", "\n", "  ", " - ", "\n\n", ".\n", ": ", "\n "];
  const item = /^\s*-\s+(?:\[ \]\s*)?[^\s.,;]/m;
  // A line that's only a dash (an empty item) is left out, as the test above checks.
  const bare = /^[^\S\n]*-[^\S\n]*(?:\[ \][^\S\n]*)?$/m;
  const next = rng(80);
  const pick = <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)];
  let checked = 0;
  for (let n = 0; n < 20000; n++) {
    let text = next() < 0.3 ? " " : "";
    const len = 1 + Math.floor(next() * 14);
    for (let i = 0; i < len; i++) text += pick(words) + (i < len - 1 ? pick(gaps) : pick(["", ".", "!", " ", "\n"]));
    if (item.test(text) || bare.test(text)) continue;
    checked++;
    assert.equal(bodyFrom(text), text.trim(), JSON.stringify(text));
    assert.equal(blocksFrom(text), null, JSON.stringify(text));
    assert.equal(copyNote("", text).text, text.trim(), JSON.stringify(text));
  }
  assert.ok(checked > 5000, `only ${checked} texts without a list`);
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
    `List\n-${" ".repeat(n)}\nx`,
    `${"-\n".repeat(n / 2)}x`,
    `${"- [ ]\n".repeat(n / 6)}x`,
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

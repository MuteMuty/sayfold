import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyFrom, blocksFrom } from "../../src/core/list.ts";

test("\"list\" as its own sentence turns the sentences after it into task-list items", () => {
  assert.equal(bodyFrom("Groceries. List. Milk. Bread. Eggs."), "Groceries.\n\n- [ ] Milk\n- [ ] Bread\n- [ ] Eggs");
});

test("\"list:\" with commas gives one item per part, and the words before it stay a paragraph", () => {
  assert.equal(bodyFrom("Things to try, list: dark mode, offline send"), "Things to try:\n\n- [ ] Dark mode\n- [ ] Offline send");
  assert.equal(bodyFrom("List: dark mode, offline send."), "- [ ] Dark mode\n- [ ] Offline send");
});

test("after \"list:\", more than one sentence gives one item per sentence, commas and all", () => {
  assert.equal(bodyFrom("List: milk, bread. Eggs."), "- [ ] Milk, bread\n- [ ] Eggs");
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
  assert.equal(bodyFrom("LIST! milk? END LIST. ok"), "- [ ] Milk?\n\nok");
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

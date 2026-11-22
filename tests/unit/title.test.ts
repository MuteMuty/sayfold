import { test } from "node:test";
import assert from "node:assert/strict";
import { titleFrom, TITLE_MAX, clipboardText, copyNote } from "../../src/core/title.ts";
import { issueFrom } from "../../src/core/github.ts";

test("the title is the first line", () => {
  assert.equal(titleFrom("Buy oat milk\nand bread too"), "Buy oat milk");
});

test("blank lines and spaces before the first words are skipped", () => {
  assert.equal(titleFrom("\n\n   Fix the gate  \nlater"), "Fix the gate");
});

test("a one-paragraph transcript gives its first sentence, without the full stop", () => {
  assert.equal(titleFrom("New idea. Water the tomatoes every morning."), "New idea");
  assert.equal(titleFrom("Call the plumber on Friday! Then pay him."), "Call the plumber on Friday!");
  assert.equal(titleFrom("Is it raining? Take a coat."), "Is it raining?");
});

test("a decimal point or abbreviation-like dot inside a word doesn't end the sentence", () => {
  assert.equal(titleFrom("Version 2.5 ships soon"), "Version 2.5 ships soon");
});

test("a long first line with no clause break is cut at a word boundary with an ellipsis", () => {
  const long = "Turn the old garden shed into a small workshop with a bench and a vice and good light and shelves for every jar";
  const t = titleFrom(long);
  assert.ok(t.length <= TITLE_MAX, `${t.length} > ${TITLE_MAX}`);
  assert.ok(t.endsWith("…"));
  assert.ok(long.startsWith(t.slice(0, -1)), t);
  assert.ok(!t.slice(0, -1).endsWith(" "), "no space before the ellipsis");
});

test("one very long word is still cut to fit", () => {
  const t = titleFrom("x".repeat(200));
  assert.equal(t.length, TITLE_MAX);
});

test("no words gives an empty title", () => {
  assert.equal(titleFrom(""), "");
  assert.equal(titleFrom("  \n \t "), "");
});

test("the first letter is capitalised", () => {
  assert.equal(titleFrom("remember the keys"), "Remember the keys");
});

test("copy puts the title, a blank line, then the text; either may be missing", () => {
  assert.equal(clipboardText(" Groceries ", "Milk\nBread "), "Groceries\n\nMilk\nBread");
  assert.equal(clipboardText("", "Just text"), "Just text");
  assert.equal(clipboardText("Just a title", "  "), "Just a title");
});

test("a long first sentence is cut at its first clause break that leaves a real title", () => {
  assert.equal(
    titleFrom("New idea, water the tomatoes every morning, and call the plumber on Friday."),
    "New idea",
  );
  assert.equal(
    titleFrom("Turn the shed into a workshop; a bench, a vice, good light and shelves for every single jar we own"),
    "Turn the shed into a workshop",
  );
});

test("a clause break too early to make a title is passed over", () => {
  const t = titleFrom("So, the plan is to turn the old garden shed into a small workshop with a bench and good light");
  assert.ok(t.startsWith("So, the plan is"), t);
});

test("a short first sentence keeps its commas", () => {
  assert.equal(titleFrom("Milk, eggs and bread. Then the bank."), "Milk, eggs and bread");
});

test("copy with nothing in either field says there's nothing to copy", () => {
  assert.deepEqual(copyNote("", ""), { text: "", message: "There's nothing to copy yet" });
  assert.deepEqual(copyNote("  ", " \n "), { text: "", message: "There's nothing to copy yet" });
});

test("copy says what it copied", () => {
  assert.deepEqual(copyNote("Groceries", "Milk"), { text: "Groceries\n\nMilk", message: "Copied the title and text" });
  assert.deepEqual(copyNote("", "Milk"), { text: "Milk", message: "Copied the text" });
  assert.deepEqual(copyNote("Groceries", ""), { text: "Groceries", message: "Copied the title" });
});

test("when the title is the whole transcript, copy gives it once", () => {
  assert.deepEqual(copyNote("Buy oat milk", "Buy oat milk"), { text: "Buy oat milk", message: "Copied the text" });
  // As the title is made from it: capitalised, without the full stop.
  assert.deepEqual(copyNote(titleFrom("buy oat milk."), "buy oat milk."), { text: "buy oat milk.", message: "Copied the text" });
  assert.equal(clipboardText("Call  the plumber!", "call the plumber! "), "call the plumber!");
  // A title that's only the first sentence is still copied with the rest.
  assert.equal(clipboardText("Buy oat milk", "Buy oat milk. And bread."), "Buy oat milk\n\nBuy oat milk. And bread.");
});

test("with a task list, the title is the words before it, or its first item when the list comes first", () => {
  assert.equal(titleFrom("Shopping list:\n- Milk\n- Bread"), "Shopping list");
  assert.equal(titleFrom("Things to try:\n- Dark mode\n- Offline send"), "Things to try");
  assert.equal(titleFrom("- milk\n- bread"), "Milk");
  assert.equal(titleFrom("Weekend\nat the cabin\n- wood"), "Weekend");
  // "list" is just a word now.
  assert.equal(titleFrom("List. Milk. Bread."), "List");
  assert.equal(titleFrom("Listen to this. Then go."), "Listen to this");
});

test("copy copies the text as Send sends it: \"- \" lines as a task list, and any other text exactly as it is", () => {
  assert.deepEqual(copyNote("Shopping list", "Shopping list:\n- Milk\n- Bread\nThen call the bank."), {
    text: "Shopping list\n\nShopping list:\n\n- [ ] Milk\n- [ ] Bread\n\nThen call the bank.",
    message: "Copied the title and text",
  });
  assert.deepEqual(copyNote("", "- Milk\n- Bread"), { text: "- [ ] Milk\n- [ ] Bread", message: "Copied the text" });
  for (const text of ["  My shopping list: milk, eggs.\nMilk  ", "Groceries, list, milk, and list.", " \tx\n\n y "]) {
    assert.equal(clipboardText("T", text), `T\n\n${text.trim()}`);
  }
});

test("copy is the same text part Send sends", () => {
  for (const text of ["Groceries:\n- Milk", "Things to try, list, dark mode.", "Just an idea.", "- "]) {
    const issue = issueFrom("", text, []);
    assert.equal(copyNote("", text).text, issue?.body ?? "");
  }
});

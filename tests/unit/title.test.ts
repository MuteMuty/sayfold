import { test } from "node:test";
import assert from "node:assert/strict";
import { titleFrom, TITLE_MAX, clipboardText } from "../../src/core/title.ts";

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

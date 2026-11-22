// Spoken corrections (lab#109, slice 3): the correction model's prompt, the checks on its reply, its neurons
// and its timeout (src/server/correct.ts). The model is always a stand-in here: nothing reaches Workers AI.
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM, correct, fixNeurons, fixPrompt, readFix, type TextAi } from "../../src/server/correct.ts";
import {
  FIX_INPUT_NEURONS_PER_M_TOKENS, FIX_MODEL, FIX_OUTPUT_NEURONS_PER_M_TOKENS, FIX_TIMEOUT_MS, SPEECH_MODEL,
} from "../../src/server/config.ts";
import { AI_ERRORS } from "./server-fakes.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

/** A stand-in model that answers with `reply` (or throws it, when it's an Error), and records each call. */
function model(reply: unknown | ((inputs: { messages: { role: string; content: string }[] }) => unknown)) {
  const calls: { model: string; inputs: Record<string, unknown> }[] = [];
  const ai: TextAi = {
    async run(m, inputs) {
      calls.push({ model: m, inputs: inputs as Record<string, unknown> });
      const r = typeof reply === "function" ? (reply as (i: unknown) => unknown)(inputs) : reply;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { ai, calls };
}
const says = (text: string, usage?: object) => ({ response: `<text>${text}</text>`, ...(usage && { usage }) });

// --- the model and its prompt ------------------------------------------------------------------------

test("config: the correction model is Llama 3.3 70B fp8-fast on Workers AI, next to the speech model", () => {
  assert.equal(FIX_MODEL, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(SPEECH_MODEL, "@cf/deepgram/flux");
  // Workers AI's published price for it (checked 22 Nov 2026): 26,668 neurons per M input tokens, 204,805 per M output.
  assert.equal(FIX_INPUT_NEURONS_PER_M_TOKENS, 26668);
  assert.equal(FIX_OUTPUT_NEURONS_PER_M_TOKENS, 204805);
  assert.ok(FIX_TIMEOUT_MS >= 2000 && FIX_TIMEOUT_MS <= 6000, "a few seconds");
});

test("prompt: the system rules, then the text so far and the newest turn", () => {
  assert.deepEqual(fixPrompt("Let's meet on Monday at ten.", "No, Tuesday."), [
    { role: "system", content: SYSTEM },
    { role: "user", content: "TEXT:\nLet's meet on Monday at ten.\n\nSAID:\nNo, Tuesday." },
  ]);
  assert.equal(fixPrompt("", "Hello there.")[1].content, "TEXT:\n(empty)\n\nSAID:\nHello there.");
});

test("prompt: it holds the rules the clips and test cases rely on", () => {
  for (const rule of [
    // c1, c4, c6: short corrections replace the words they correct, and aren't typed out.
    '"no, Tuesday"', '"I mean Hannah"', '"not the phone, the tablet"', '"change five to ten"', "do not write the instruction itself",
    // c6 as Flux heard it: "Wait. Not the phone. The tablet."
    '"wait"',
    // "scratch that" removes one sentence; said in one breath, only the unfinished one (the spike's miss).
    '"Scratch that" and "delete that" remove one sentence only',
    "in the middle of a sentence",
    "only that unfinished sentence",
    "every sentence before it stays",
    // lists: a heading, then "- " lines, and no other formatting.
    'starting with "- "', 'ending in ":"', "no other formatting",
    // plain sentences that only sound like commands stay as text.
    '"No, I don\'t think the old design was better"', '"make the list view load faster"', '"she likes to scratch the sofa"',
    "When unsure, treat SAID as dictation",
    // the reply's form, which readFix checks.
    "inside <text></text> and nothing else",
  ]) assert.ok(SYSTEM.includes(rule), `the prompt lacks ${rule}`);
});

test("correct: asks the configured model at temperature 0, with room for the whole text and no more", async () => {
  const { ai, calls } = model(says("Let's meet on Tuesday at ten."));
  await correct(ai, "Let's meet on Monday at ten.", "No, Tuesday.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, FIX_MODEL);
  assert.deepEqual(calls[0].inputs.messages, fixPrompt("Let's meet on Monday at ten.", "No, Tuesday."));
  assert.equal(calls[0].inputs.temperature, 0);
  const max = calls[0].inputs.max_tokens as number;
  assert.ok(max >= 64 && max <= 2048, String(max));
});

// --- Erik's clips and the spike's cases, with the replies Llama gave -------------------------------------

/**
 * One case, as its own test: what Flux wrote so far, the newest turn, Llama's reply (the stand-in's), and the text
 * that should come of it. Each checks the reply is taken as the new text, so the checks in readFix never throw
 * away a good edit.
 */
function clip(name: string, doc: string, said: string, reply: string, want: string) {
  test(`clip: ${name}`, async () => {
    const { ai, calls } = model(says(reply));
    const r = await correct(ai, doc, said);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].inputs.messages, fixPrompt(doc, said));
    assert.equal(r.quota, false);
    assert.deepEqual(r.quota === false && { text: r.text, fixed: r.fixed }, { text: want, fixed: true });
  });
}

// Erik's clips (lab#109 spike).
clip('c1 (Tuesday): "Let\'s meet on Monday at ten." then "No, Tuesday." gives Tuesday, not both',
  "Let's meet on Monday at ten.", "No, Tuesday.", "Let's meet on Tuesday at ten.", "Let's meet on Tuesday at ten.");
// Flux heard "Hannah" as "Henna".
clip('c4 (Hannah): "Send the report to Anna." then "I mean Hannah." (heard as "Henna") takes Anna\'s place',
  "Send the report to Anna.", "I mean Henna.", "Send the report to Henna.", "Send the report to Henna.");
// As Flux heard it: "Wait. Not the phone. The tablet."
clip('c6 (tablet): "…when I rotate the phone." then "Wait. Not the phone, the tablet." swaps the word',
  "The app crashes when I rotate the phone.", "Wait. Not the phone. The tablet.", "The app crashes when I rotate the tablet.", "The app crashes when I rotate the tablet.");
clip('c3 (spoken list): "Shopping list: milk, bread, eggs and butter." becomes a heading and "- " lines',
  "", "Shopping list: milk, bread, eggs and butter.", "Shopping list:\n- Milk\n- Bread\n- Eggs\n- Butter", "Shopping list:\n- Milk\n- Bread\n- Eggs\n- Butter");
clip('c5 (spoken list): "To do list. By milk. Call mom." becomes a heading and "- " lines',
  "", "To do list. By milk. Call mom.", "To do list:\n- By milk\n- Call mom", "To do list:\n- By milk\n- Call mom");

// "Scratch that".
clip('scratch that in one breath: "…ten seconds to load scratch that." takes only the unfinished sentence',
  "", "The login page is slow. It takes ten seconds to load scratch that.", "The login page is slow.", "The login page is slow.");
clip('scratch that, then new words: "Scratch that. Call him on Friday." replaces the last sentence',
  "Call Mark tomorrow.", "Scratch that. Call him on Friday.", "Call him on Friday.", "Call him on Friday.");
clip('scratch everything: "Buy milk." then "Scratch that." leaves nothing, and that\'s a real answer',
  "Buy milk.", "Scratch that.", "", "");
clip('delete that: "Add a dark mode." then "Delete that." leaves nothing',
  "Add a dark mode.", "Delete that.", "", "");
clip('change five to ten: the number changes, and the instruction isn\'t typed',
  "Users can't upload photos larger than five megabytes.", "Change five to ten.", "Users can't upload photos larger than ten megabytes.", "Users can't upload photos larger than ten megabytes.");

// Plain sentences that only sound like commands stay as they were said.
clip('sounds like a command: "No, I don\'t think the old design was better." stays as said',
  "", "No, I don't think the old design was better.", "No, I don't think the old design was better.", "No, I don't think the old design was better.");
clip('sounds like a command: "Make the list view load faster." stays as said, and isn\'t a list',
  "", "Make the list view load faster.", "Make the list view load faster.", "Make the list view load faster.");
clip('sounds like a command: "She likes to scratch the sofa." is added, and scratches nothing',
  "Our cat has a habit.", "She likes to scratch the sofa.", "Our cat has a habit. She likes to scratch the sofa.", "Our cat has a habit. She likes to scratch the sofa.");
clip('sounds like a command: "No more than three, though." is added, and corrects nothing',
  "We should add filters.", "No more than three, though.", "We should add filters. No more than three, though.", "We should add filters. No more than three, though.");
clip('sounds like a command: "Replace it with something easier to read." is added, and replaces nothing',
  "Change the default font.", "Replace it with something easier to read.", "Change the default font. Replace it with something easier to read.", "Change the default font. Replace it with something easier to read.");

test("sounds like a command: a reply that took a plain sentence for an edit, and dropped the text, is junk", async () => {
  // "No more than three, though." isn't a correction: had the model cut the text to it, the plain text is kept.
  const r = await correct(model(says("No more than three.")).ai, "We should add filters to the search page and the list view.", "No more than three, though.");
  assert.deepEqual(r.quota === false && { text: r.text, fixed: r.fixed }, { text: "We should add filters to the search page and the list view. No more than three, though.", fixed: false });
});

// --- junk keeps the turn's plain text ------------------------------------------------------------------

const DOC = "The login page is slow. It takes ten seconds to load on my phone.";
const SAID = "It also logs me out.";
const PLAIN = `${DOC} ${SAID}`;

test("readFix: a reply that isn't the whole text inside <text></text>, and only that, is junk", () => {
  assert.equal(readFix(`<text>${PLAIN}</text>`, DOC, SAID), PLAIN);
  assert.equal(readFix(`  <text>\n${PLAIN}\n</text>\n`, DOC, SAID), PLAIN, "spaces around it are fine");
  for (const raw of [
    "",
    "   ",
    PLAIN, // no tags
    `<text>${PLAIN}`, // cut off before the end (max_tokens)
    `Here is the updated text: <text>${PLAIN}</text>`,
    `<text>${PLAIN}</text>\nI added the new sentence at the end.`,
    `<text>${DOC}</text><text>${SAID}</text>`,
  ]) assert.equal(readFix(raw, DOC, SAID), null, JSON.stringify(raw));
});

test("readFix: chatty words inside the tags are junk", () => {
  for (const text of [
    `Sure! Here is the updated text with your new sentence added: ${PLAIN}`,
    `I have added the sentence. ${PLAIN}`,
    "I'm sorry, I can't help with that request because it isn't clear what you mean.",
  ]) assert.equal(readFix(`<text>${text}</text>`, DOC, SAID), null, text);
});

test("readFix: markdown other than \"- \" lines is junk", () => {
  for (const text of [
    "* The modal should close on escape.",
    "**The login page is slow.** It takes ten seconds to load on my phone. It also logs me out.",
    "# The login page\nIt takes ten seconds to load on my phone. It also logs me out.",
    "Login issues:\n1. Slow to load\n2. Logs me out",
    "Login issues:\n+ Slow to load\n+ Logs me out",
    "Login issues:\n- [ ] Slow to load\n- [ ] Logs me out",
    "Login issues:\n- Slow\n  - to load on my phone\n- Logs me out",
    "`The login page` is slow. It takes ten seconds to load on my phone. It also logs me out.",
    "> The login page is slow. It takes ten seconds to load on my phone. It also logs me out.",
  ]) assert.equal(readFix(`<text>${text}</text>`, DOC, SAID), null, text);
  // Plain "- " lines are the one formatting that's wanted.
  assert.equal(readFix("<text>Login issues:\n- Slow to load\n- Logs me out</text>", DOC, SAID), "Login issues:\n- Slow to load\n- Logs me out");
});

test("readFix: a reply much longer than the text and the turn together is junk", () => {
  assert.equal(readFix(`<text>${PLAIN} ${PLAIN} ${PLAIN}</text>`, DOC, SAID), null);
  assert.equal(readFix(`<text>${PLAIN}</text>`, DOC, SAID), PLAIN);
});

test("readFix: dropping most of the text without a command like \"scratch that\" is junk; with one it's an edit", () => {
  assert.equal(readFix("<text>The login page is slow.</text>", DOC, SAID), null);
  assert.equal(readFix("<text></text>", DOC, SAID), null, "nothing at all");
  assert.equal(readFix("<text></text>", "", "Hello there."), null, "a short plain turn that came back empty");
  assert.equal(readFix("<text>The login page is slow.</text>", DOC, "Scratch that."), "The login page is slow.");
  assert.equal(readFix("<text>The login page is slow.</text>", DOC, "Delete the last sentence."), "The login page is slow.");
  assert.equal(readFix("<text></text>", "Add a dark mode.", "Delete that."), "");
  // A short edit on a short text isn't "most of it".
  assert.equal(readFix("<text>Tuesday.</text>", "Monday.", "No, Tuesday."), "Tuesday.");
});

test("correct: junk, a reply that isn't text, and an empty turn's reply all keep the plain text of the turn", async () => {
  for (const reply of [
    { response: "" },
    { response: `Here you go: <text>${PLAIN}</text>` },
    { response: "<text>* It also logs me out.</text>" },
    { response: { text: PLAIN } },
    { response: null },
    {},
    null,
    "not an object",
  ]) {
    const r = await correct(model(reply).ai, DOC, SAID);
    assert.deepEqual(r.quota === false && { text: r.text, fixed: r.fixed }, { text: PLAIN, fixed: false }, JSON.stringify(reply));
  }
});

test("correct: after a list, the plain text of a turn starts on a new line, so it isn't taken for the last item", async () => {
  const r = await correct(model({ response: "" }).ai, "Shopping list:\n- Milk\n- Bread", "Then call the bank.");
  assert.deepEqual(r.quota === false && r.text, "Shopping list:\n- Milk\n- Bread\nThen call the bank.");
});

test("correct: when the model fails, the turn's plain text is kept", async () => {
  for (const message of [AI_ERRORS.capacity, AI_ERRORS.throws, "AiError: 5000: timeout after 3036 ms"]) {
    const r = await correct(model(new Error(message)).ai, DOC, SAID);
    assert.deepEqual(r, { quota: false, text: PLAIN, fixed: false, neurons: 0 }, message);
  }
  // Even when the binding throws before it returns a promise.
  const sync: TextAi = { run: () => { throw new Error("boom"); } };
  assert.deepEqual(await correct(sync, DOC, SAID), { quota: false, text: PLAIN, fixed: false, neurons: 0 });
});

test("correct: Workers AI's daily refusal (3036) is told apart, so the day closes", async () => {
  assert.deepEqual(await correct(model(new Error(AI_ERRORS.quota)).ai, DOC, SAID), { quota: true });
  const coded = Object.assign(new Error("refused"), { code: 3036 });
  assert.deepEqual(await correct(model(coded).ai, DOC, SAID), { quota: true });
});

test("correct: a reply slower than the timeout keeps the plain text, and its late answer is never used", async () => {
  let answer!: (v: unknown) => void;
  const ai: TextAi = { run: () => new Promise((r) => (answer = r)) };
  const pending = correct(ai, DOC, SAID);
  await Promise.resolve();
  mock.timers.tick(FIX_TIMEOUT_MS - 1);
  let done = false;
  void pending.then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, "gave up before the timeout");
  mock.timers.tick(1);
  const r = await pending;
  assert.equal(r.quota, false);
  assert.deepEqual(r.quota === false && { text: r.text, fixed: r.fixed }, { text: PLAIN, fixed: false });
  // The model may still have done the work, so it's counted, as an estimate.
  assert.ok(r.quota === false && r.neurons > 0);
  answer(says("Something else entirely."));
});

// --- neurons -------------------------------------------------------------------------------------------

test("neurons: from the reply's token usage at Workers AI's price, when it gives it", async () => {
  assert.equal(fixNeurons({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 0, 0), 26668);
  assert.equal(fixNeurons({ prompt_tokens: 0, completion_tokens: 1_000_000 }, 0, 0), 204805);
  const r = await correct(model(says(PLAIN, { prompt_tokens: 600, completion_tokens: 40, total_tokens: 640 })).ai, DOC, SAID);
  assert.ok(r.quota === false);
  assert.ok(Math.abs(r.neurons - (600 * 26668 + 40 * 204805) / 1e6) < 1e-9, String(r.neurons));
});

test("neurons: estimated from the prompt and the reply (about 4 characters a token) without usage", async () => {
  assert.equal(fixNeurons(undefined, 4000, 400), (1000 * 26668 + 100 * 204805) / 1e6);
  assert.equal(fixNeurons({ prompt_tokens: "lots" }, 4000, 400), fixNeurons(undefined, 4000, 400), "usage that isn't numbers");
  const reply = says(PLAIN);
  const r = await correct(model(reply).ai, DOC, SAID);
  const prompt = fixPrompt(DOC, SAID).reduce((n, m) => n + m.content.length, 0);
  assert.ok(r.quota === false);
  assert.equal(r.neurons, fixNeurons(undefined, prompt, reply.response.length));
  // Junk is counted too: the model did the work.
  const junk = await correct(model({ response: "* nope" }).ai, DOC, SAID);
  assert.ok(junk.quota === false && junk.neurons > 0);
});

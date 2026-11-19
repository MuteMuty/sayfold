import { test } from "node:test";
import assert from "node:assert/strict";
import { transcript, clip } from "../../src/core/transcript.ts";
import type { Part } from "../../src/core/segments.ts";

const RATE = 16_000;
/** Parts of 4 s with 3.5 s of speech each, one after another. */
const parts = (n: number): Part[] => Array.from({ length: n }, (_, i) => ({ start: i * 4 * RATE, end: (i + 1) * 4 * RATE, speech: 3.5 }));
const SAID = ["Order compost from the farm shop today.", "Ask Martin whether he can lend us his ladder.", "Paint the fence green instead of brown."];

/** A stand-in model: says each part's sentence, except for parts it "can't start" on alone. Joined, it hears all of them. */
function model(cantStart: number[] = [], joinedToo = true) {
  const calls: number[][] = [];
  const all = parts(SAID.length);
  const fn = async (ps: Part[]) => {
    const idx = ps.map((p) => all.findIndex((q) => q.start === p.start));
    calls.push(idx);
    if (idx.length === 1) return cantStart.includes(idx[0]!) ? "" : SAID[idx[0]!]!;
    return joinedToo ? idx.map((i) => SAID[i]).join(" ") : SAID[idx[0]!]!;
  };
  return { fn, calls };
}

test("every part's text, in order, each part asked once", async () => {
  const m = model();
  const done: number[] = [];
  const r = await transcript(parts(3), m.fn, (i) => done.push(i));
  assert.equal(r.text, SAID.join(" "));
  assert.equal(r.gaps, false);
  assert.deepEqual(m.calls, [[0], [1], [2]]);
  assert.deepEqual(done, [0, 1, 2]);
});

test("a part that came back empty is tried again joined to the one before, and its words come back once", async () => {
  const m = model([1]);
  const r = await transcript(parts(3), m.fn);
  assert.equal(r.text, SAID.join(" "));
  assert.equal(r.gaps, false);
  assert.deepEqual(m.calls, [[0], [1], [2], [0, 1]]);
});

test("the first part, with none before it, is joined to the one after", async () => {
  const m = model([0]);
  const r = await transcript(parts(3), m.fn);
  assert.equal(r.text, SAID.join(" "));
  assert.equal(r.gaps, false);
  assert.deepEqual(m.calls.at(-1), [0, 1]);
});

test("when joining doesn't help, the text is kept as it was and the gap is reported", async () => {
  const m = model([1], false);
  const r = await transcript(parts(3), m.fn);
  assert.equal(r.text, `${SAID[0]} ${SAID[2]}`);
  assert.equal(r.gaps, true);
});

test("a neighbour already joined to the part before it isn't joined again, so no words come twice", async () => {
  const m = model([1, 2]);
  const r = await transcript(parts(3), m.fn);
  assert.equal(r.text, `${SAID[0]} ${SAID[1]}`);
  assert.equal(r.gaps, true);
  assert.deepEqual(m.calls, [[0], [1], [2], [0, 1]]);
});

test("one part that came back empty, with nothing to join it to, is reported", async () => {
  const m = model([0]);
  const r = await transcript(parts(1), m.fn);
  assert.equal(r.text, "");
  assert.equal(r.gaps, true);
  assert.deepEqual(m.calls, [[0]]);
});

test("a short recording that came through is asked once, so it's as quick as before", async () => {
  const m = model();
  const r = await transcript(parts(1), m.fn);
  assert.equal(r.text, SAID[0]);
  assert.deepEqual(m.calls, [[0]]);
});

test("clip: one part is its own samples; several are put end to end", () => {
  const x = Float32Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual([...clip(x, [{ start: 2, end: 5, speech: 0 }])], [2, 3, 4]);
  assert.deepEqual([...clip(x, [{ start: 0, end: 2, speech: 0 }, { start: 7, end: 9, speech: 0 }])], [0, 1, 7, 8]);
});

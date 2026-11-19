// Sayfold's usage events (lab#71): when the lab's shared script may load (src/analytics.ts), and the
// allow-list and the play events (src/analytics-events.ts). Nothing anyone said or typed may ever be
// sent: no transcript, title, audio, word counts or anything derived from them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isProduction, optedOut, shouldLoad, SCRIPT } from "../../src/analytics.ts";
import { EVENTS, playEvents, PROJECT, secondsBucket } from "../../src/analytics-events.ts";

const none = { nav: {}, win: {} };

test("the shared script comes from the hub, by its absolute address", () => {
  assert.equal(SCRIPT, "https://lab.brightloopapps.com/analytics/v1.js");
});

test("only *.brightloopapps.com counts as production", () => {
  assert.equal(isProduction("sayfold.brightloopapps.com"), true);
  assert.equal(isProduction("localhost"), false);
  assert.equal(isProduction("127.0.0.1"), false);
  assert.equal(isProduction("sayfold.erik.workers.dev"), false);
  assert.equal(isProduction("brightloopapps.com.example.org"), false);
  assert.equal(isProduction("evilbrightloopapps.com"), false);
});

test("Do Not Track (either spelling) and Global Privacy Control opt out", () => {
  assert.equal(optedOut({}, {}), false);
  assert.equal(optedOut({ doNotTrack: "1" }, {}), true);
  assert.equal(optedOut({ doNotTrack: "yes" }, {}), true);
  assert.equal(optedOut({}, { doNotTrack: "1" }), true);
  assert.equal(optedOut({ globalPrivacyControl: true }, {}), true);
  assert.equal(optedOut({ doNotTrack: "0", globalPrivacyControl: false }, { doNotTrack: null }), false);
});

test("the script loads only in production for a visitor who didn't opt out", () => {
  assert.equal(shouldLoad("sayfold.brightloopapps.com", none.nav, none.win), true);
  assert.equal(shouldLoad("localhost", none.nav, none.win), false);
  assert.equal(shouldLoad("sayfold.erik.workers.dev", none.nav, none.win), false);
  assert.equal(shouldLoad("sayfold.brightloopapps.com", { doNotTrack: "1" }, {}), false);
  assert.equal(shouldLoad("sayfold.brightloopapps.com", { globalPrivacyControl: true }, {}), false);
});

test("the allow-list: a pageview, a recording started, a transcript ready with only its length bucket and backend, and an idea sent with nothing at all", () => {
  assert.equal(PROJECT, "sayfold");
  assert.deepEqual(Object.keys(EVENTS).sort(), ["$pageview", "idea_sent", "play_finished", "play_started"]);
  // Sending says only that an idea went: never the repo, token, labels, title or text.
  assert.deepEqual(EVENTS.idea_sent, {});
  assert.deepEqual(EVENTS.$pageview, {});
  assert.deepEqual(EVENTS.play_started, {});
  assert.deepEqual(EVENTS.play_finished, {
    seconds_bucket: ["0-9", "10-29", "30-59", "60-119", "120+"],
    backend: ["webgpu", "wasm"],
  });
});

test("seconds_bucket: labels the recording's length, using the hub's bucket format", () => {
  assert.equal(secondsBucket(0), "0-9");
  assert.equal(secondsBucket(9.99), "0-9");
  assert.equal(secondsBucket(10), "10-29");
  assert.equal(secondsBucket(45), "30-59");
  assert.equal(secondsBucket(60), "60-119");
  assert.equal(secondsBucket(119.9), "60-119");
  assert.equal(secondsBucket(120), "120+");
  assert.equal(secondsBucket(-1), "0-9");
  assert.equal(secondsBucket(Number.NaN), "0-9");
});

test("each recording sends one play_started, and its transcript one play_finished", () => {
  const sent: [string, Record<string, unknown>][] = [];
  const plays = playEvents((name, props) => sent.push([name, props]));
  plays.started();
  plays.finished(12.4, "wasm");
  plays.finished(12.4, "wasm"); // the same transcript again: not sent twice
  plays.started(); // Record again
  plays.finished(130, "webgpu");
  assert.deepEqual(sent, [
    ["play_started", {}],
    ["play_finished", { seconds_bucket: "10-29", backend: "wasm" }],
    ["play_started", {}],
    ["play_finished", { seconds_bucket: "120+", backend: "webgpu" }],
  ]);
  for (const [name, props] of sent) {
    const spec = EVENTS[name as keyof typeof EVENTS] as Record<string, readonly unknown[]>;
    for (const [k, v] of Object.entries(props)) assert.ok(spec[k]?.includes(v), `${name}.${k} = ${JSON.stringify(v)} isn't allow-listed`);
  }
});

test("a finish without a recording started (a failed one, for instance) is not sent", () => {
  const sent: string[] = [];
  const plays = playEvents((name) => sent.push(name));
  plays.finished(5, "wasm");
  plays.started();
  plays.abandoned(); // the recording failed or was empty
  plays.finished(5, "wasm");
  assert.deepEqual(sent, ["play_started"]);
});

test("a sender that throws never breaks recording", () => {
  const plays = playEvents(() => {
    throw new Error("blocked");
  });
  assert.doesNotThrow(() => {
    plays.started();
    plays.finished(3, "webgpu");
  });
});

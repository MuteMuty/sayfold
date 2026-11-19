import { test } from "node:test";
import assert from "node:assert/strict";
import { micProblem, unsupported, MESSAGES } from "../../src/core/mic.ts";

const err = (name: string) => Object.assign(new Error(name), { name });

test("a refused permission is 'denied'", () => {
  assert.equal(micProblem(err("NotAllowedError")), "denied");
  assert.equal(micProblem(err("PermissionDeniedError")), "denied");
  assert.equal(micProblem(err("SecurityError")), "denied");
});

test("no microphone at all is 'no-mic'", () => {
  assert.equal(micProblem(err("NotFoundError")), "no-mic");
  assert.equal(micProblem(err("DevicesNotFoundError")), "no-mic");
  assert.equal(micProblem(err("OverconstrainedError")), "no-mic");
});

test("a microphone another app holds is 'busy'", () => {
  assert.equal(micProblem(err("NotReadableError")), "busy");
  assert.equal(micProblem(err("TrackStartError")), "busy");
  assert.equal(micProblem(err("AbortError")), "busy");
});

test("anything else is 'other', even a non-error", () => {
  assert.equal(micProblem(err("TypeError")), "other");
  assert.equal(micProblem("nope"), "other");
  assert.equal(micProblem(null), "other");
});

const full = {
  isSecureContext: true,
  getUserMedia: true,
  AudioContext: true,
  AudioWorklet: true,
  Worker: true,
  WebAssembly: true,
};

test("a browser with everything is supported", () => {
  assert.equal(unsupported(full), null);
});

test("an insecure page, or a browser missing any piece, is unsupported, with the reason", () => {
  assert.equal(unsupported({ ...full, isSecureContext: false }), "insecure");
  for (const k of ["getUserMedia", "AudioContext", "AudioWorklet", "Worker", "WebAssembly"] as const) {
    assert.equal(unsupported({ ...full, [k]: false }), "browser", k);
  }
});

test("every problem has a friendly message that says what to do", () => {
  for (const k of ["denied", "no-mic", "busy", "other", "insecure", "browser"] as const) {
    const m = MESSAGES[k];
    assert.ok(m.title.length > 0 && m.body.length > 20, k);
    assert.ok(!/error|exception|undefined/i.test(m.title + m.body), `${k} reads like a stack trace`);
  }
});

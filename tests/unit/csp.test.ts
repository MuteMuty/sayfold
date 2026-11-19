// The page's Content-Security-Policy (src/csp.ts), added to the built page by vite.config.ts. The
// visitor's token and text may only ever go to api.github.com; the page may otherwise talk only to
// itself and the lab hub (likes and the shared analytics script, which sends to PostHog's EU host).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CSP, directives } from "../../src/csp.ts";

const policy = (csp: string) => new Map(csp.split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k!, v]));

test("connect-src allows only Sayfold itself, GitHub's API and the hub's likes and analytics", () => {
  assert.deepEqual(policy(CSP).get("connect-src"), ["'self'", "https://api.github.com", "https://lab.brightloopapps.com", "https://eu.i.posthog.com"]);
});

test("everything else defaults to Sayfold itself, with nothing to embed and no forms to post", () => {
  const p = policy(CSP);
  assert.deepEqual(p.get("default-src"), ["'self'"]);
  // WebAssembly may compile (the speech runtime), in case a browser hands the page's policy to its worker.
  assert.deepEqual(p.get("script-src"), ["'self'", "'wasm-unsafe-eval'", "https://lab.brightloopapps.com"]);
  assert.deepEqual(p.get("img-src"), ["'self'", "data:"]);
  assert.deepEqual(p.get("object-src"), ["'none'"]);
  assert.deepEqual(p.get("base-uri"), ["'none'"]);
  assert.deepEqual(p.get("form-action"), ["'none'"]);
});

test("no wildcards, no inline scripts or styles, no JavaScript eval", () => {
  for (const [name, values] of Object.entries(directives)) {
    for (const v of values) assert.ok(!/\*|unsafe-inline|(?<!wasm-)unsafe-eval|unsafe-hashes/.test(v), `${name} ${v}`);
  }
});

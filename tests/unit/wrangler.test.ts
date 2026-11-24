// The Worker's deploy config: a TypeScript entry, the AI binding, one SQLite Durable Object on the free
// plan, the page's files as before, and nothing that could keep what a visitor says (no logs, no
// analytics, no other storage).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
/** wrangler.jsonc, with its whole-line comments dropped. */
const config = JSON.parse(
  readFileSync(join(root, "wrangler.jsonc"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"),
);

test("wrangler.jsonc: a TypeScript Worker that serves dist/ on workers.dev and on its launch address", () => {
  assert.equal(config.name, "sayfold");
  assert.match(config.main, /\.ts$/);
  assert.ok(existsSync(join(root, config.main)));
  assert.match(readFileSync(join(root, config.main), "utf8"), /export class Meter extends DurableObject/);
  assert.deepEqual(config.assets, { directory: "./dist", binding: "ASSETS" });
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.routes, [{ pattern: "sayfold.brightloopapps.com", custom_domain: true }], "exactly one route: the custom domain");
  assert.equal(config.route, undefined);
});

test("wrangler.jsonc: the AI binding and one SQLite-backed Durable Object, declared by migration", () => {
  assert.deepEqual(config.ai, { binding: "AI" }, "no remote dev binding: tests mock it");
  assert.deepEqual(config.durable_objects, { bindings: [{ name: "METER", class_name: "Meter" }] });
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["Meter"] }]);
});

test("wrangler.jsonc: no logs, analytics, secrets or other storage to set up", () => {
  assert.deepEqual(config.observability, { enabled: false });
  for (const key of ["kv_namespaces", "d1_databases", "r2_buckets", "analytics_engine_datasets", "logpush", "tail_consumers", "vars", "secrets_store_secrets", "queues"]) {
    assert.equal(config[key], undefined, key);
  }
});

test("lab.json points at the launch address", () => {
  const lab = JSON.parse(readFileSync(join(root, "lab.json"), "utf8"));
  assert.equal(lab.url, "https://sayfold.brightloopapps.com");
  assert.equal(lab.worker, config.name);
});

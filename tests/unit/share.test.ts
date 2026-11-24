// Share previews for the launch address (lab#74): the tags in index.html, and the 1200 by 630 card in public/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
const html = readFileSync(join(root, "index.html"), "utf8");
const head = html.slice(0, html.indexOf("</head>"));
const URL = "https://sayfold.brightloopapps.com/";

/** The content of a <meta> in the head, by property or name. */
const meta = (key: string) => head.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`))?.[1];

test("the head names the launch address as canonical and as og:url", () => {
  assert.match(head, new RegExp(`<link rel="canonical" href="${URL}" />`));
  assert.equal(meta("og:url"), URL);
  assert.equal(meta("og:type"), "website");
});

test("the share card: title, description, a 1200 by 630 image on the launch address with alt text, large on X", () => {
  assert.equal(meta("og:title"), "Sayfold");
  assert.ok(meta("og:description"));
  assert.equal(meta("og:image"), `${URL}og.png`);
  assert.equal(meta("og:image:width"), "1200");
  assert.equal(meta("og:image:height"), "630");
  assert.match(meta("og:image:alt") ?? "", /^Sayfold/);
  assert.equal(meta("twitter:card"), "summary_large_image");
});

test("no tag says speech stays on the device: with live text on, it doesn't", () => {
  const said = [...head.matchAll(/<meta (?:property|name)="(?!viewport")[^"]+" content="([^"]*)"/g)].map((m) => m[1]).join(" ");
  assert.doesNotMatch(said, /device|never leaves|no server|in your browser|private/i, said);
});

test("public/og.png is a 1200 by 630 PNG, small enough to share", () => {
  const png = readFileSync(join(root, "public/og.png"));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "not a PNG");
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length < 300 * 1024, `${png.length} bytes`);
});

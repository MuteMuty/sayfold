// Fetches the pinned speech model from Hugging Face into public/models/<id>/ and checks every file against
// the checksums in src/stt/model.ts. Only for setting up or changing the model: the files are committed,
// so install, build and the site itself never contact Hugging Face.
//
// Usage: node scripts/fetch-model.ts    (files already present and intact are left alone)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL } from "../src/stt/model.ts";

const dir = join(import.meta.dirname, "../public/models", MODEL.id);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let fetched = 0;

for (const [file, want] of Object.entries(MODEL.files)) {
  const path = join(dir, file);
  if (existsSync(path) && sha(readFileSync(path)) === want) continue;
  const url = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha(bytes) !== want) throw new Error(`${file}: checksum ${sha(bytes)} isn't the pinned ${want}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  fetched++;
  console.log(`${file}: ${bytes.length} bytes`);
}
console.log(fetched ? `fetched ${fetched} file(s) into ${dir}` : `all ${Object.keys(MODEL.files).length} files present and intact`);

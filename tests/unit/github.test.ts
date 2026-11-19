// Sending an idea to the visitor's own GitHub repo (src/core/github.ts): reading the repo they typed,
// the requests (only ever to api.github.com, with their token), GitHub's answers in plain words, and
// where the token is kept (src/core/token.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API, parseRepo, repoName, tokenProblem, repoRequest, labelsRequest, issueRequest, issueFrom, labelsFrom,
  preselected, problemFor, networkProblem, connect, send, sendButton, type Repo,
} from "../../src/core/github.ts";
import { GitHubLink, TOKEN_KEY } from "../../src/core/token.ts";

const REPO: Repo = { owner: "ada", name: "ideas" };
const TOKEN = "github_pat_11FAKEFAKEFAKE_0123456789abcdef";

// --- the repo -------------------------------------------------------------------------------------

test("a repo as owner/name", () => {
  assert.deepEqual(parseRepo("ada/ideas"), REPO);
  assert.deepEqual(parseRepo("  ada/ideas  "), REPO);
  assert.deepEqual(parseRepo("Some-Org/my.repo_2"), { owner: "Some-Org", name: "my.repo_2" });
});

test("a repo as a github.com link, with or without the scheme, www, .git, a slash or a deeper page", () => {
  for (const link of [
    "https://github.com/ada/ideas",
    "https://github.com/ada/ideas/",
    "http://github.com/ada/ideas",
    "github.com/ada/ideas",
    "https://www.github.com/ada/ideas",
    "https://github.com/ada/ideas.git",
    "https://github.com/ada/ideas/issues",
    "https://github.com/ada/ideas/tree/main/docs",
    "https://github.com/ada/ideas?tab=readme#top",
    "git@github.com:ada/ideas.git",
  ]) assert.deepEqual(parseRepo(link), REPO, link);
});

test("anything else isn't a repo", () => {
  for (const bad of [
    "", "   ", "ada", "ada/", "/ideas", "ada/ideas/extra", "ada ideas", "https://gitlab.com/ada/ideas",
    "https://github.com/ada", "https://github.com.evil.example/ada/ideas", "-ada/ideas", "ada-/ideas",
    "ada/..", "ada/.", `${"a".repeat(40)}/ideas`, "ada/id eas", "ada/ide$as",
  ]) assert.equal(parseRepo(bad), null, bad);
});

test("repoName gives owner/name", () => {
  assert.equal(repoName(REPO), "ada/ideas");
});

test("the token must be pasted, in one piece", () => {
  assert.equal(tokenProblem(TOKEN), null);
  assert.match(tokenProblem("")!, /Paste/);
  assert.match(tokenProblem("   ")!, /Paste/);
  assert.match(tokenProblem("github_pat_ abc")!, /without spaces/);
});

// --- requests: only api.github.com, the token only in the Authorization header ----------------------

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

test("checking the repo: GET /repos/{owner}/{repo} with the token", () => {
  const [url, init] = repoRequest(REPO, TOKEN);
  assert.equal(url, "https://api.github.com/repos/ada/ideas");
  assert.equal(init.method ?? "GET", "GET");
  assert.equal(header(init, "authorization"), `Bearer ${TOKEN}`);
  assert.equal(header(init, "accept"), "application/vnd.github+json");
  assert.equal(init.credentials, "omit");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.equal(init.cache, "no-store");
});

test("the labels: GET /repos/{owner}/{repo}/labels, up to 100", () => {
  const [url, init] = labelsRequest(REPO, TOKEN);
  assert.equal(url, "https://api.github.com/repos/ada/ideas/labels?per_page=100");
  assert.equal(header(init, "authorization"), `Bearer ${TOKEN}`);
});

test("the issue: POST /repos/{owner}/{repo}/issues with the title, the text as its body, and the labels", () => {
  const [url, init] = issueRequest(REPO, TOKEN, { title: "Water the tomatoes", body: "Every morning.", labels: ["idea"] });
  assert.equal(url, "https://api.github.com/repos/ada/ideas/issues");
  assert.equal(init.method, "POST");
  assert.equal(header(init, "authorization"), `Bearer ${TOKEN}`);
  assert.equal(header(init, "content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(init.body)), { title: "Water the tomatoes", body: "Every morning.", labels: ["idea"] });
  assert.ok(!String(init.body).includes(TOKEN), "the token is in the body");
});

test("every request goes to api.github.com, whatever the repo's name holds", () => {
  assert.equal(API, "https://api.github.com");
  for (const [url] of [repoRequest(REPO, TOKEN), labelsRequest(REPO, TOKEN), issueRequest(REPO, TOKEN, { title: "t", body: "", labels: [] })]) {
    assert.equal(new URL(url).origin, API);
  }
});

test("the issue: trimmed title and text; an empty title falls back to one from the text; nothing to send gives null", () => {
  assert.deepEqual(issueFrom(" Groceries ", " Milk\nBread \n", ["idea"]), { title: "Groceries", body: "Milk\nBread", labels: ["idea"] });
  assert.deepEqual(issueFrom("", "new idea. water the tomatoes.", []), { title: "New idea", body: "new idea. water the tomatoes.", labels: [] });
  assert.deepEqual(issueFrom("Just a title", "  ", []), { title: "Just a title", body: "", labels: [] });
  assert.equal(issueFrom("  ", " \n ", ["idea"]), null);
});

// --- labels -----------------------------------------------------------------------------------

test("labels from GitHub's answer: names and colours, anything odd skipped", () => {
  const got = labelsFrom([
    { id: 1, name: "idea", color: "a2eeef", description: "x" },
    { name: "bug", color: "D73A4A" },
    { name: "no colour" },
    { name: "bad colour", color: "url(x)" },
    { name: "" },
    { color: "ffffff" },
    null,
    "idea",
  ]);
  assert.deepEqual(got, [
    { name: "idea", color: "#a2eeef" },
    { name: "bug", color: "#d73a4a" },
    { name: "no colour", color: "" },
    { name: "bad colour", color: "" },
  ]);
  assert.deepEqual(labelsFrom({ message: "Not Found" }), []);
  assert.deepEqual(labelsFrom(null), []);
});

test("`idea` is chosen at first when the repo has it, in whatever case it's spelt", () => {
  assert.deepEqual(preselected([{ name: "bug", color: "" }, { name: "idea", color: "" }]), ["idea"]);
  assert.deepEqual(preselected([{ name: "Idea", color: "" }]), ["Idea"]);
  assert.deepEqual(preselected([{ name: "ideas", color: "" }, { name: "bug", color: "" }]), []);
  assert.deepEqual(preselected([]), []);
});

// --- GitHub's answers in plain words --------------------------------------------------------------

const h = (o: Record<string, string> = {}) => new Headers(o);
const NOW = Date.parse("2026-11-19T03:00:00Z");

test("401: the token wasn't accepted, at any step, and connecting again helps", () => {
  for (const step of ["connect", "labels", "send"] as const) {
    const p = problemFor(step, 401, h(), "ada/ideas", NOW);
    assert.equal(p.kind, "token");
    assert.equal(p.reconnect, true);
    assert.match(p.message, /didn't accept this token/);
  }
});

test("403 and 404: no access, said for what was being done", () => {
  const c403 = problemFor("connect", 403, h({ "x-ratelimit-remaining": "4999" }), "ada/ideas", NOW);
  assert.equal(c403.kind, "access");
  assert.match(c403.message, /ada\/ideas/);
  const c404 = problemFor("connect", 404, h(), "ada/ideas", NOW);
  assert.equal(c404.kind, "missing");
  assert.match(c404.message, /can't find ada\/ideas/);
  const l = problemFor("labels", 403, h(), "ada/ideas", NOW);
  assert.equal(l.kind, "access");
  assert.match(l.message, /Issues.*Read and write/);
  const s403 = problemFor("send", 403, h(), "ada/ideas", NOW);
  assert.equal(s403.kind, "access");
  assert.match(s403.message, /can't create issues in ada\/ideas/);
  assert.match(s403.message, /Issues.*Read and write/);
  assert.equal(s403.reconnect, true);
  const s404 = problemFor("send", 404, h(), "ada/ideas", NOW);
  assert.equal(s404.kind, "missing");
  assert.equal(s404.reconnect, true);
});

test("410: issues are turned off in the repo", () => {
  const p = problemFor("send", 410, h(), "ada/ideas", NOW);
  assert.equal(p.kind, "issues-off");
  assert.match(p.message, /Issues are turned off in ada\/ideas/);
  assert.equal(p.reconnect, false);
});

test("422: GitHub didn't accept the issue", () => {
  const p = problemFor("send", 422, h(), "ada/ideas", NOW);
  assert.equal(p.kind, "invalid");
  assert.match(p.message, /didn't accept this issue/);
});

test("rate limits: 429, or 403 with none left or a retry-after, with how long to wait", () => {
  const reset = String(Math.floor(NOW / 1000) + 9 * 60 + 5);
  const a = problemFor("send", 403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), "ada/ideas", NOW);
  assert.equal(a.kind, "rate");
  assert.match(a.message, /about 10 minutes/);
  const b = problemFor("send", 429, h({ "retry-after": "30" }), "ada/ideas", NOW);
  assert.equal(b.kind, "rate");
  assert.match(b.message, /about a minute/);
  const c = problemFor("connect", 403, h({ "retry-after": "120" }), "ada/ideas", NOW);
  assert.equal(c.kind, "rate");
  assert.match(c.message, /about 2 minutes/);
  const d = problemFor("send", 429, h(), "ada/ideas", NOW);
  assert.match(d.message, /in a few minutes/);
  assert.equal(d.reconnect, false);
});

test("GitHub's own trouble, and anything else", () => {
  assert.equal(problemFor("send", 502, h(), "ada/ideas", NOW).kind, "server");
  const other = problemFor("send", 418, h(), "ada/ideas", NOW);
  assert.equal(other.kind, "other");
  assert.match(other.message, /418/);
});

test("no connection, or offline", () => {
  assert.equal(networkProblem(true).kind, "network");
  assert.match(networkProblem(true).message, /Couldn't reach GitHub/);
  assert.equal(networkProblem(false).kind, "offline");
  assert.match(networkProblem(false).message, /offline/);
});

test("no message holds the token", () => {
  for (const s of [401, 403, 404, 410, 422, 429, 500, 418]) {
    for (const step of ["connect", "labels", "send"] as const) assert.ok(!problemFor(step, s, h(), "ada/ideas", NOW).message.includes("github_pat"));
  }
});

// --- connecting and sending, with a stand-in fetch ------------------------------------------------

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
type Answer = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(answers: Answer[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request ${url}`);
    return answer(url, init);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

test("connect: checks the repo, then reads its labels; GitHub's own spelling of the name is kept", async () => {
  const f = fakeFetch([
    () => json(200, { full_name: "Ada/Ideas", has_issues: true }),
    () => json(200, [{ name: "idea", color: "a2eeef" }, { name: "bug", color: "d73a4a" }]),
  ]);
  const r = await connect(f.fetch, REPO, TOKEN);
  assert.deepEqual(r, { ok: true, repo: { owner: "Ada", name: "Ideas" }, labels: [{ name: "idea", color: "#a2eeef" }, { name: "bug", color: "#d73a4a" }] });
  assert.deepEqual(f.calls.map((c) => c.url), ["https://api.github.com/repos/ada/ideas", "https://api.github.com/repos/Ada/Ideas/labels?per_page=100"]);
});

test("connect: a repo with issues turned off says so, without reading labels", async () => {
  const f = fakeFetch([() => json(200, { full_name: "ada/ideas", has_issues: false })]);
  const r = await connect(f.fetch, REPO, TOKEN);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.problem.kind, "issues-off");
  assert.equal(f.calls.length, 1);
});

test("connect: each failing answer becomes its problem", async () => {
  const cases: [Answer[], string][] = [
    [[() => json(401, { message: "Bad credentials" })], "token"],
    [[() => json(404, { message: "Not Found" })], "missing"],
    [[() => json(200, { full_name: "ada/ideas", has_issues: true }), () => json(403, { message: "Resource not accessible" })], "access"],
    [[() => { throw new TypeError("Failed to fetch"); }], "network"],
  ];
  for (const [answers, kind] of cases) {
    const r = await connect(fakeFetch(answers).fetch, REPO, TOKEN);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.problem.kind, kind);
  }
});

test("send: creates the issue and hands back its number and page", async () => {
  const f = fakeFetch([() => json(201, { number: 42, html_url: "https://github.com/ada/ideas/issues/42" })]);
  const r = await send(f.fetch, REPO, TOKEN, { title: "T", body: "B", labels: ["idea"] });
  assert.deepEqual(r, { ok: true, number: 42, url: "https://github.com/ada/ideas/issues/42" });
  assert.equal(f.calls[0].init.method, "POST");
});

test("send: a link that isn't on github.com is replaced by the repo's issue address", async () => {
  const f = fakeFetch([() => json(201, { number: 7, html_url: "https://evil.example/x" })]);
  const r = await send(f.fetch, REPO, TOKEN, { title: "T", body: "", labels: [] });
  assert.deepEqual(r, { ok: true, number: 7, url: "https://github.com/ada/ideas/issues/7" });
});

test("send: failures become problems", async () => {
  const cases: [Answer, string][] = [
    [() => json(401, {}), "token"],
    [() => json(403, {}), "access"],
    [() => json(404, {}), "missing"],
    [() => json(410, {}), "issues-off"],
    [() => json(422, { message: "Validation Failed" }), "invalid"],
    [() => json(403, {}, { "x-ratelimit-remaining": "0" }), "rate"],
    [() => json(503, {}), "server"],
    [() => { throw new TypeError("Failed to fetch"); }, "network"],
  ];
  for (const [answer, kind] of cases) {
    const r = await send(fakeFetch([answer]).fetch, REPO, TOKEN, { title: "T", body: "", labels: [] });
    assert.equal(!r.ok && r.problem.kind, kind, kind);
  }
});

// --- the Send button, online and off -----------------------------------------------------------------

test("the Send button waits while offline and while sending", () => {
  assert.deepEqual(sendButton({ online: true, busy: false }), { label: "Send to GitHub", disabled: false });
  assert.deepEqual(sendButton({ online: false, busy: false }), { label: "Waiting for a connection…", disabled: true });
  assert.deepEqual(sendButton({ online: true, busy: true }), { label: "Sending…", disabled: true });
});

// --- where the token is kept ---------------------------------------------------------------------------

function memoryStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}
const denied = {
  getItem(): string | null { throw new Error("denied"); },
  setItem() { throw new Error("denied"); },
  removeItem() { throw new Error("denied"); },
};

test("the token is kept in memory only, unless remembered", () => {
  const s = memoryStorage();
  const link = new GitHubLink(s);
  assert.equal(link.current, null);
  link.set({ repo: REPO, token: TOKEN }, false);
  assert.deepEqual(link.current, { repo: REPO, token: TOKEN });
  assert.equal(link.remembered, false);
  assert.equal(s.map.size, 0, "stored without being asked to");
});

test("Remember on this device keeps it in localStorage, and a later visit finds it", () => {
  const s = memoryStorage();
  new GitHubLink(s).set({ repo: REPO, token: TOKEN }, true);
  assert.deepEqual(JSON.parse(s.map.get(TOKEN_KEY)!), { repo: "ada/ideas", token: TOKEN });
  const later = new GitHubLink(s);
  assert.deepEqual(later.current, { repo: REPO, token: TOKEN });
  assert.equal(later.remembered, true);
});

test("connecting again without Remember takes away what was remembered", () => {
  const s = memoryStorage();
  const link = new GitHubLink(s);
  link.set({ repo: REPO, token: TOKEN }, true);
  link.set({ repo: REPO, token: TOKEN }, false);
  assert.equal(s.map.size, 0);
  assert.equal(link.remembered, false);
});

test("Forget token clears memory and storage in one go", () => {
  const s = memoryStorage();
  const link = new GitHubLink(s);
  link.set({ repo: REPO, token: TOKEN }, true);
  link.forget();
  assert.equal(link.current, null);
  assert.equal(link.remembered, false);
  assert.equal(s.map.has(TOKEN_KEY), false);
  assert.equal(new GitHubLink(s).current, null);
});

test("something odd in storage is ignored (and nothing throws without storage)", () => {
  for (const raw of ["not json", "{}", JSON.stringify({ repo: "nope", token: TOKEN }), JSON.stringify({ repo: "ada/ideas", token: "" }), JSON.stringify({ repo: "ada/ideas", token: 5 })]) {
    assert.equal(new GitHubLink(memoryStorage({ [TOKEN_KEY]: raw })).current, null, raw);
  }
  const blocked = new GitHubLink(denied);
  assert.equal(blocked.current, null);
  blocked.set({ repo: REPO, token: TOKEN }, true);
  assert.deepEqual(blocked.current, { repo: REPO, token: TOKEN }, "kept in memory when storage is blocked");
  blocked.forget();
  assert.equal(blocked.current, null);
  const none = new GitHubLink(null);
  none.set({ repo: REPO, token: TOKEN }, true);
  none.forget();
  assert.equal(none.current, null);
});

test("an answer that takes too long: for a send, a warning that it may have got there", async () => {
  const late = () => { throw new DOMException("timed out", "TimeoutError"); };
  const s = await send(fakeFetch([late]).fetch, REPO, TOKEN, { title: "T", body: "", labels: [] });
  assert.equal(!s.ok && s.problem.kind, "timeout");
  assert.match(!s.ok ? s.problem.message : "", /may have got there/);
  const c = await connect(fakeFetch([late]).fetch, REPO, TOKEN);
  assert.equal(!c.ok && c.problem.kind, "timeout");
});

test("offline when the request failed: says so", async () => {
  const r = await send(fakeFetch([() => { throw new TypeError("Failed to fetch"); }]).fetch, REPO, TOKEN, { title: "T", body: "", labels: [] }, { online: () => false });
  assert.equal(!r.ok && r.problem.kind, "offline");
});

test("every request carries a time limit", async () => {
  const f = fakeFetch([() => json(201, { number: 1 })]);
  await send(f.fetch, REPO, TOKEN, { title: "T", body: "", labels: [] });
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
});

// Sending an idea to the visitor's own GitHub repo as an issue. GitHub is the API: each person uses their
// own fine-grained token, limited to one repo, and everything goes straight from the browser to
// api.github.com. Sayfold has no server. Plain logic: the page hands in fetch, so `node --test` can run it.
import { titleFrom } from "./title.ts";

export const API = "https://api.github.com";
/** Where to make a token, and the one permission it needs. */
export const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";

export interface Repo { owner: string; name: string }
export const repoName = (r: Repo) => `${r.owner}/${r.name}`;

// GitHub's rules: an owner is 1 to 39 letters, digits and single dashes, not starting or ending with one;
// a repo name is letters, digits, dots, dashes and underscores, but not "." or "..".
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** owner/name, a github.com link (with or without https://, www., .git or a deeper page) or an SSH address, or null. */
export function parseRepo(input: string): Repo | null {
  let s = input.trim();
  const ssh = /^git@github\.com:(.+)$/.exec(s);
  let path: string[];
  if (ssh) path = ssh[1]!.split("/");
  else if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return null;
    path = url.pathname.split("/").filter(Boolean).slice(0, 2);
  } else {
    path = s.split("/");
  }
  if (path.length !== 2) return null;
  const owner = path[0]!;
  const name = path[1]!.replace(/\.git$/, "");
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

/** What's wrong with a pasted token, in plain words, or null. */
export function tokenProblem(token: string): string | null {
  const t = token.trim();
  if (!t) return "Paste your token here.";
  if (/\s/.test(t)) return "That doesn't look like a token. Paste it again, without spaces.";
  return null;
}

// --- requests ---------------------------------------------------------------------------------------

const path = (r: Repo) => `${API}/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;

function init(token: string, extra: RequestInit = {}): RequestInit {
  return {
    ...extra,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, ...(extra.body ? { "content-type": "application/json" } : {}) },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  };
}

export const repoRequest = (r: Repo, token: string): [string, RequestInit] => [path(r), init(token)];
export const labelsRequest = (r: Repo, token: string): [string, RequestInit] => [`${path(r)}/labels?per_page=100`, init(token)];

export interface Issue { title: string; body: string; labels: string[] }
export const issueRequest = (r: Repo, token: string, issue: Issue): [string, RequestInit] =>
  [`${path(r)}/issues`, init(token, { method: "POST", body: JSON.stringify({ title: issue.title, body: issue.body, labels: issue.labels }) })];

/** The issue to create: the title (or one from the text when it's empty), and the text as its body. Null when there's nothing to send. */
export function issueFrom(title: string, text: string, labels: string[]): Issue | null {
  const body = text.trim();
  const t = title.trim() || titleFrom(body);
  if (!t) return null;
  return { title: t, body, labels };
}

// --- labels ---------------------------------------------------------------------------------------

export interface Label { name: string; color: string }

/** The repo's labels from GitHub's answer: each name, and its colour as #rrggbb (or "" when it has none). */
export function labelsFrom(json: unknown): Label[] {
  if (!Array.isArray(json)) return [];
  const out: Label[] = [];
  for (const l of json) {
    if (!l || typeof l !== "object") continue;
    const { name, color } = l as { name?: unknown; color?: unknown };
    if (typeof name !== "string" || !name) continue;
    out.push({ name, color: typeof color === "string" && /^[0-9a-f]{6}$/i.test(color) ? `#${color.toLowerCase()}` : "" });
  }
  return out;
}

/** The labels chosen at first: `idea`, when the repo has it. */
export const preselected = (labels: Label[]) => labels.filter((l) => l.name.toLowerCase() === "idea").slice(0, 1).map((l) => l.name);

// --- GitHub's answers in plain words -----------------------------------------------------------------

export type Step = "connect" | "labels" | "send";
export type ProblemKind = "token" | "access" | "missing" | "issues-off" | "invalid" | "rate" | "server" | "network" | "offline" | "timeout" | "other";
export interface GitHubProblem {
  kind: ProblemKind;
  message: string;
  /** Connecting again (a new token, or another repo) is what helps. */
  reconnect: boolean;
}

const problem = (kind: ProblemKind, message: string): GitHubProblem =>
  ({ kind, message, reconnect: kind === "token" || kind === "access" || kind === "missing" });

type HeaderReader = { get(name: string): string | null };

function waitFor(headers: HeaderReader, now: number): string {
  const after = Number(headers.get("retry-after"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  const seconds = after > 0 ? after : reset > 0 ? reset - now / 1000 : NaN;
  if (!(seconds > 0)) return "in a few minutes";
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "in about a minute" : `in about ${minutes} minutes`;
}

const issuesOff = (repo: string) => problem("issues-off", `Issues are turned off in ${repo}. Turn them on in the repo's settings, then try again.`);

/** GitHub answered `status` while connecting, reading labels or sending: what went wrong, in plain words. */
export function problemFor(step: Step, status: number, headers: HeaderReader, repo: string, now = Date.now()): GitHubProblem {
  if (status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after")))) {
    return problem("rate", `GitHub's limit on requests was reached. Try again ${waitFor(headers, now)}.`);
  }
  if (status === 401) return problem("token", "GitHub didn't accept this token. It may be mistyped, expired or revoked. Make a new one and connect again.");
  if (step === "labels" && (status === 403 || status === 404)) {
    return problem("access", `This token can see ${repo} but not its issues. Set Issues to Read and write for it.`);
  }
  if (status === 403) {
    return step === "send"
      ? problem("access", `This token can't create issues in ${repo}. Set Issues to Read and write for it, on that repo.`)
      : problem("access", `This token isn't allowed to see ${repo}. Give it access to that repo, with Issues set to Read and write.`);
  }
  if (status === 404) {
    return step === "send"
      ? problem("missing", `GitHub can't find ${repo} with this token any more. Check that the token still has access to it.`)
      : problem("missing", `GitHub can't find ${repo} with this token. Check the name, and that the token has access to that repo.`);
  }
  if (status === 410) return issuesOff(repo);
  if (status === 422) return problem("invalid", "GitHub didn't accept this issue. Check the title and labels, then send again.");
  if (status >= 500) return problem("server", "GitHub isn't answering properly right now. Try again in a moment.");
  return problem("other", `GitHub said no (error ${status}). Try again in a moment.`);
}

/** The request never got an answer: offline, or GitHub couldn't be reached. */
export const networkProblem = (online: boolean): GitHubProblem =>
  online
    ? problem("network", "Couldn't reach GitHub. Check your connection, then try again.")
    : problem("offline", "You're offline. Sending waits until you're back online.");

function thrown(e: unknown, step: Step, online: boolean): GitHubProblem {
  if ((e as { name?: string })?.name === "TimeoutError") {
    return problem("timeout", step === "send"
      ? "GitHub took too long to answer. The issue may have got there: look at the repo's issues before you send it again."
      : "GitHub took too long to answer. Try again in a moment.");
  }
  return networkProblem(online);
}

// --- connecting and sending ------------------------------------------------------------------------

type Fetch = typeof fetch;
type Options = { online?: () => boolean; timeoutMs?: number };
const signal = (ms: number) => (typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined);

async function call(fetchFn: Fetch, [url, req]: [string, RequestInit], timeoutMs: number) {
  return fetchFn(url, { ...req, signal: signal(timeoutMs) });
}

export type Connected = { ok: true; repo: Repo; labels: Label[] } | { ok: false; problem: GitHubProblem };

/** Check the token can see the repo and its issues, and read its labels. */
export async function connect(fetchFn: Fetch, repo: Repo, token: string, { online = () => true, timeoutMs = 20_000 }: Options = {}): Promise<Connected> {
  let step: Step = "connect";
  try {
    const res = await call(fetchFn, repoRequest(repo, token), timeoutMs);
    if (!res.ok) return { ok: false, problem: problemFor("connect", res.status, res.headers, repoName(repo)) };
    const info = (await res.json().catch(() => ({}))) as { full_name?: unknown; has_issues?: unknown };
    // GitHub's own spelling of the name (owner/name are case-insensitive).
    const canonical = (typeof info.full_name === "string" && parseRepo(info.full_name)) || repo;
    if (info.has_issues === false) return { ok: false, problem: issuesOff(repoName(canonical)) };
    step = "labels";
    const labels = await call(fetchFn, labelsRequest(canonical, token), timeoutMs);
    if (!labels.ok) return { ok: false, problem: problemFor("labels", labels.status, labels.headers, repoName(canonical)) };
    return { ok: true, repo: canonical, labels: labelsFrom(await labels.json().catch(() => [])) };
  } catch (e) {
    return { ok: false, problem: thrown(e, step, online()) };
  }
}

export type Sent = { ok: true; number: number | null; url: string } | { ok: false; problem: GitHubProblem };

/** Create the issue. On success, its number and its page on github.com. */
export async function send(fetchFn: Fetch, repo: Repo, token: string, issue: Issue, { online = () => true, timeoutMs = 20_000 }: Options = {}): Promise<Sent> {
  try {
    const res = await call(fetchFn, issueRequest(repo, token, issue), timeoutMs);
    if (!res.ok) return { ok: false, problem: problemFor("send", res.status, res.headers, repoName(repo)) };
    const made = (await res.json().catch(() => ({}))) as { number?: unknown; html_url?: unknown };
    const number = Number.isInteger(made.number) ? (made.number as number) : null;
    const issues = `https://github.com/${repoName(repo)}/issues`;
    const url = typeof made.html_url === "string" && made.html_url.startsWith("https://github.com/") ? made.html_url : number ? `${issues}/${number}` : issues;
    return { ok: true, number, url };
  } catch (e) {
    return { ok: false, problem: thrown(e, "send", online()) };
  }
}

/** The Send button: it waits while the browser is offline, and while an idea is on its way. */
export function sendButton({ online, busy }: { online: boolean; busy: boolean }): { label: string; disabled: boolean } {
  if (busy) return { label: "Sending…", disabled: true };
  if (!online) return { label: "Waiting for a connection…", disabled: true };
  return { label: "Send to GitHub", disabled: false };
}

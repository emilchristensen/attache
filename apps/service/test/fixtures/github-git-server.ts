/**
 * TEST-ONLY stand-in for GitHub: git's smart HTTP protocol (served by the
 * Machine's own `git http-backend`) behind token authentication, and the
 * one REST call Replication makes, `GET /repos/{owner}/{name}`, with a
 * visibility the test controls. Tests send `https://github.com/` here with
 * git's `url.<base>.insteadOf`, set through the environment.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitHubGitServer {
  /** Base address; git paths are under `/git/`, the REST API under `/api`. */
  readonly url: string;
  readonly gitBase: string;
  readonly apiBase: string;
  /** Every request git or Attache made, with the address and the credentials it sent. */
  readonly requests: Array<{ method: string; url: string; authorization: string | null }>;
  /** Create an empty repository `owner/name`. */
  createRepo(owner: string, name: string): void;
  setVisibility(owner: string, name: string, visibility: "public" | "private"): void;
  /** The tokens git and the API accept; any other token is rejected with 401. */
  acceptTokens(...tokens: string[]): void;
  /** `git` inside the bare repository, for checking what was pushed. */
  git(owner: string, name: string, ...args: string[]): string;
  close(): Promise<void>;
}

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

function tokenOf(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const bearer = /^(?:Bearer|token) (.+)$/i.exec(authorization);
  if (bearer) return bearer[1]!;
  const basic = /^Basic (.+)$/i.exec(authorization);
  if (!basic) return null;
  const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1);
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Run `git http-backend` as CGI and relay its answer. */
function serveGit(root: string, path: string, req: IncomingMessage, input: Buffer, res: ServerResponse, query: string): void {
  const child = spawn("git", ["http-backend"], {
    env: {
      ...gitEnv,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: path,
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: query,
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(input.length),
      REMOTE_USER: "x-access-token",
      REMOTE_ADDR: "127.0.0.1",
      ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
      ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
    },
  });
  const out: Buffer[] = [];
  let stdinError: Error | null = null;
  child.stdout.on("data", (c: Buffer) => out.push(c));
  // git http-backend may answer and exit before it has read the whole request body; its answer still
  // arrives on stdout, so a pipe it closed early (EPIPE) is not a failure. Any other error is answered below.
  child.stdin.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") stdinError = e;
  });
  child.stdin.end(input);
  child.on("close", () => {
    if (stdinError) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`The fixture could not pass the request to git http-backend: ${stdinError.message}`);
      return;
    }
    const all = Buffer.concat(out);
    const split = all.indexOf("\r\n\r\n");
    const head = all.subarray(0, split).toString("utf8");
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head.split("\r\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[key] = value;
    }
    res.writeHead(status, headers);
    res.end(all.subarray(split + 4));
  });
}

export async function startGitHubGitServer(): Promise<GitHubGitServer> {
  const root = mkdtempSync(join(tmpdir(), "attache-it-github-"));
  const visibility = new Map<string, "public" | "private">();
  let accepted = new Set<string>();
  const requests: GitHubGitServer["requests"] = [];
  const repoDir = (owner: string, name: string) => join(root, owner, `${name}.git`);

  const server = createServer(async (req, res) => {
    const input = await body(req);
    const url = new URL(req.url ?? "/", "http://fixture");
    requests.push({ method: req.method ?? "GET", url: req.url ?? "/", authorization: req.headers.authorization ?? null });
    const token = tokenOf(req.headers.authorization);
    const authorized = token !== null && accepted.has(token);
    if (url.pathname.startsWith("/git/")) {
      if (!authorized) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"', "content-type": "text/plain" });
        res.end("Invalid username or token.");
        return;
      }
      serveGit(root, url.pathname.slice("/git".length), req, input, res, url.search.slice(1));
      return;
    }
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (token !== null && !authorized) return json(401, { message: "Bad credentials" });
    if (url.pathname === "/api/user") return json(200, { login: "owner" });
    const repo = /^\/api\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const seen = repo ? visibility.get(`${repo[1]}/${repo[2]}`) : undefined;
    // Like GitHub: a private repository is invisible without a token that can see it.
    if (!repo || !seen || (seen === "private" && !authorized)) return json(404, { message: "Not Found" });
    return json(200, { full_name: `${repo[1]}/${repo[2]}`, private: seen === "private", visibility: seen });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    gitBase: `${url}/git/`,
    apiBase: `${url}/api`,
    requests,
    createRepo(owner, name) {
      execFileSync("git", ["init", "--bare", "--quiet", "-b", "main", repoDir(owner, name)], { env: gitEnv, stdio: "pipe" });
      execFileSync("git", ["-C", repoDir(owner, name), "config", "http.receivepack", "true"], { env: gitEnv, stdio: "pipe" });
      visibility.set(`${owner}/${name}`, "private");
    },
    setVisibility(owner, name, v) {
      visibility.set(`${owner}/${name}`, v);
    },
    acceptTokens(...tokens) {
      accepted = new Set(tokens);
    },
    git: (owner, name, ...args) => execFileSync("git", ["-C", repoDir(owner, name), ...args], { env: gitEnv, encoding: "utf8", stdio: "pipe" }).trim(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * What `scripts/ci-failures.mjs` asks the GitHub CLI about a run.
 */
import { execFileSync } from "node:child_process";

const RUN_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:[/?#].*)?$/;
// Job logs of a long test run are several megabytes.
const MAX_OUTPUT = 256 * 1024 * 1024;

/** The run a command-line argument names: a run id, or a run or job URL (which also names the repository). */
export function parseRunRef(arg) {
  if (/^\d+$/.test(arg ?? "")) return { runId: arg, repo: null };
  const m = RUN_URL.exec(arg ?? "");
  if (!m) throw new Error(`Expected a run id or a run URL (https://github.com/<owner>/<repo>/actions/runs/<id>), got ${JSON.stringify(arg ?? "")}.`);
  return { runId: m[2], repo: m[1] };
}

function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", maxBuffer: MAX_OUTPUT, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("The GitHub CLI (gh) is not installed or not on PATH.");
    throw new Error(`gh ${args.join(" ")} failed: ${(e.stderr || e.message).trim()}`);
  }
}

/** The repository of the current folder's checkout, as owner/name. */
export const currentRepo = () => gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();

/** The run with its jobs and their steps. */
export const fetchRun = (repo, runId) => JSON.parse(gh(["run", "view", runId, "--repo", repo, "--json", "databaseId,displayTitle,headBranch,status,conclusion,url,jobs"]));

/** A job's whole log, escape sequences included (gh refuses to print them otherwise). */
export const fetchJobLog = (repo, jobId) => gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${jobId}/logs`]);

/** A job's check-run annotations: where GitHub says why a job never started. */
export const fetchAnnotations = (repo, jobId) => JSON.parse(gh(["api", `repos/${repo}/check-runs/${jobId}/annotations`]));

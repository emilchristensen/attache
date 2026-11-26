/**
 * Whether the full CI run passed for one exact commit.
 *
 * `.github/workflows/ci.yml` splits its jobs by event: a push runs only the
 * Linux jobs, and a pull request runs the macOS and Windows jobs on the commit
 * it would merge, not on its own head. Only a run started by hand
 * (`workflow_dispatch`) runs every job, the install test on all three
 * platforms included, on the commit itself. So a commit passed the full CI
 * run when a run started by hand for it succeeded with every job below
 * passing: none failed, none skipped.
 */

const PLATFORMS = ["ubuntu-latest", "macos-latest", "windows-latest"];

/** The jobs a release needs, as ci.yml names them. A run started by hand also has the `current Node` jobs; they must pass too. */
export const REQUIRED_JOBS = PLATFORMS.flatMap((os) => [`checks (${os})`, `journeys (${os})`, `install (${os})`]);

/** Read a GitHub REST API path for this repository, failing with what GitHub answered. */
async function getJson(api, path) {
  const url = `${api.url}/repos/${api.repo}${path}`;
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(api.token ? { authorization: `Bearer ${api.token}` } : {}) } });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** What keeps one run from counting as the full CI run, or null when it counts. */
function runShortfall(run, jobs) {
  if (run.status !== "completed") return `it is still ${run.status.replace("_", " ")}`;
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const problems = [];
  for (const name of REQUIRED_JOBS) if (!byName.has(name)) problems.push(`it has no ${name} job`);
  for (const j of jobs) if (j.conclusion !== "success") problems.push(`${j.name} ${j.conclusion === null ? "did not finish" : j.conclusion === "failure" ? "failed" : `ended ${j.conclusion}`}`);
  if (!problems.length && run.conclusion !== "success") problems.push(`it ended ${run.conclusion}`);
  return problems.length ? problems.join("; ") : null;
}

/**
 * The full CI run that passed for `commit`, as `{ run }`, or `{ problem }` saying why there is none and what to do.
 * @param {{ url: string, repo: string, token?: string }} api  GitHub's REST API address, `owner/name` and a token that can read Actions
 * @param {string} commit  the full commit SHA
 * @param {string} ref  the tag or branch to suggest a run on
 */
export async function fullCiRun(api, commit, ref) {
  const { workflow_runs: runs } = await getJson(api, `/actions/workflows/ci.yml/runs?head_sha=${commit}&event=workflow_dispatch&per_page=100`);
  const howTo = `Only a CI run started by hand runs every job, the install test on Linux, macOS and Windows included: run "gh workflow run ci.yml --ref ${ref}", wait for it to pass, then re-run this workflow.`;
  if (!runs.length) return { problem: `No CI run started by hand has run on commit ${commit}. ${howTo}` };
  const shortfalls = [];
  for (const run of runs) {
    const { jobs } = await getJson(api, `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    const shortfall = runShortfall(run, jobs);
    if (!shortfall) return { run };
    shortfalls.push(`${run.html_url}: ${shortfall}`);
  }
  return { problem: `No full CI run passed on commit ${commit}. ${shortfalls.join(". ")}. ${howTo}` };
}

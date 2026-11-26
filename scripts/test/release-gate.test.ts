// The release workflow's gate (scripts/release-gate.mjs), run as the workflow runs it:
// against a checkout and a local stand-in for GitHub's Actions API.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "../../apps/service/test/fixtures/fixture-server.ts";
import { generateReleaseKeyPair } from "../../apps/service/src/release/signature.ts";

const GATE = join(import.meta.dirname, "..", "release-gate.mjs");
const REPO = "emilchristensen/attache";
const COMMIT = "4f2a9c1e0b7d3a6f5e8c2b1a0d9e8f7c6b5a4d3e";
const OS = ["ubuntu-latest", "macos-latest", "windows-latest"];
/** The jobs a CI run started by hand has, as `.github/workflows/ci.yml` names them. */
const FULL_RUN_JOBS = [...OS.flatMap((os) => [`checks (${os})`, `journeys (${os})`, `install (${os})`]), "checks (ubuntu-latest, current Node)", "journeys (ubuntu-latest, current Node)"];

const CHANGELOG = `# Changelog

What changed in each version of Attache, newest first.

## 0.7.0-beta.1

Attache keeps itself current.
Install this release by hand once.

## 0.6.0

Saves write without asking by default.
`;

interface Run {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  jobs: Array<{ name: string; conclusion: string | null }>;
}

/** A checkout holding the version in the code, the changelog and the committed public key. */
function checkout({ version = "0.7.0-beta.1", changelog = CHANGELOG, publicKey = generateReleaseKeyPair().publicKey as string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "attache-gate-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "attache", version }));
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  mkdirSync(join(root, ".github"));
  if (publicKey) writeFileSync(join(root, ".github", "release-public-key.pem"), publicKey);
  return root;
}

const fullRun = (id: number, over: Partial<Run> = {}): Run => ({ id, event: "workflow_dispatch", status: "completed", conclusion: "success", jobs: FULL_RUN_JOBS.map((name) => ({ name, conclusion: "success" })), ...over });

let api: FixtureServer | null = null;

/** GitHub's Actions API for this repository, knowing these CI runs of COMMIT. */
async function actionsApi(runs: Run[]) {
  api = await startFixtureServer();
  api.route("GET", `/repos/${REPO}/actions/workflows/ci.yml/runs`, (req) => {
    const matching = runs.filter((r) => req.query.get("head_sha") === COMMIT && (!req.query.get("event") || req.query.get("event") === r.event));
    return { json: { total_count: matching.length, workflow_runs: matching.map((r) => ({ id: r.id, head_sha: COMMIT, event: r.event, status: r.status, conclusion: r.conclusion, html_url: `https://github.com/${REPO}/actions/runs/${r.id}` })) } };
  });
  api.route("GET", /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/jobs$/, (req) => {
    const run = runs.find((r) => req.path.endsWith(`/runs/${r.id}/jobs`))!;
    return { json: { total_count: run.jobs.length, jobs: run.jobs.map((j, i) => ({ id: run.id * 100 + i, name: j.name, status: j.conclusion ? "completed" : "in_progress", conclusion: j.conclusion })) } };
  });
  return api.url;
}

afterEach(async () => {
  await api?.close();
  api = null;
});

/** Run the gate as the workflow does; `args` names the tag or the dry run. */
async function gate(root: string, apiUrl: string, args: string[]) {
  const out = join(root, "github-output");
  const notes = join(root, "notes.md");
  writeFileSync(out, "");
  const child = spawn(process.execPath, [GATE, "--root", root, "--commit", COMMIT, "--notes-out", notes, ...args], {
    env: { ...process.env, GITHUB_API_URL: apiUrl, GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "test-token", GITHUB_OUTPUT: out },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const outputs = Object.fromEntries(
    readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("=", 2) as [string, string]),
  );
  const readNotes = () => readFileSync(notes, "utf8");
  return { status, stdout, stderr, all: stdout + stderr, outputs, notes: readNotes };
}

describe("the release gate for a pushed tag", () => {
  it("lets a Beta tag through when the code, the changelog and a full CI run of the commit agree", async () => {
    const r = await gate(checkout(), await actionsApi([fullRun(7)]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status, r.all).toBe(0);
    expect(r.outputs).toEqual({ version: "0.7.0-beta.1", prerelease: "true" });
    expect(r.notes()).toBe("Attache keeps itself current.\nInstall this release by hand once.\n");
    expect(r.stdout).toContain(`https://github.com/${REPO}/actions/runs/7`);
  });
});

describe("the release gate refuses, saying what to do", () => {
  it("makes a plain version tag a Stable release, not a prerelease", async () => {
    const changelog = "# Changelog\n\n## 0.7.0\n\nAttache keeps itself current.\n";
    const r = await gate(checkout({ version: "0.7.0", changelog }), await actionsApi([fullRun(7)]), ["--tag", "v0.7.0"]);
    expect(r.status, r.all).toBe(0);
    expect(r.outputs).toEqual({ version: "0.7.0", prerelease: "false" });
  });

  it("keeps a section's own ### headings in the notes, up to the next version", async () => {
    const changelog = "# Changelog\n\n## 0.7.0-beta.1\n\nInstall by hand once.\n\n### What's new\n\nAutomatic updates.\n\n## 0.6.0\n\nOlder.\n";
    const r = await gate(checkout({ changelog }), await actionsApi([fullRun(7)]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status, r.all).toBe(0);
    expect(r.notes()).toBe("Install by hand once.\n\n### What's new\n\nAutomatic updates.\n");
  });

  it("refuses a tag that does not match the version in the code", async () => {
    const r = await gate(checkout({ version: "0.6.0" }), await actionsApi([fullRun(7)]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("The tag v0.7.0-beta.1 does not match the version in the code, 0.6.0 (package.json)");
    expect(r.outputs).toEqual({});
  });

  it("refuses a version bumped in package.json but not everywhere else the code holds it", async () => {
    const root = checkout();
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "@attache/web", version: "0.6.0" }));
    mkdirSync(join(root, "apps", "service", "src", "core"), { recursive: true });
    writeFileSync(join(root, "apps", "service", "src", "core", "version.ts"), 'export const VERSION = process.env.ATTACHE_VERSION ?? "0.6.0";\n');
    const r = await gate(root, await actionsApi([fullRun(7)]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("The version is 0.7.0-beta.1 in package.json but 0.6.0 in apps/web/package.json and apps/service/src/core/version.ts. Bump it in every one of them.");
  });

  it("refuses a tag that is not v<version>", async () => {
    const r = await gate(checkout(), await actionsApi([fullRun(7)]), ["--tag", "0.7.0-beta.1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("The tag 0.7.0-beta.1 is not a release tag: release tags are v<version>");
  });

  it("refuses a version without a section in the changelog", async () => {
    const r = await gate(checkout({ version: "0.7.0" }), await actionsApi([fullRun(7)]), ["--tag", "v0.7.0"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CHANGELOG.md has no section for 0.7.0. Add a "## 0.7.0" section');
  });

  it("refuses a section with no notes in it", async () => {
    const r = await gate(checkout({ changelog: "# Changelog\n\n## 0.7.0-beta.1\n\n## 0.6.0\n\nOlder notes.\n" }), await actionsApi([fullRun(7)]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CHANGELOG.md's section for 0.7.0-beta.1 is empty");
  });

  it("refuses a commit that only had the CI run a push starts, saying how to start the full one", async () => {
    const push = fullRun(5, { event: "push", jobs: [{ name: "checks (ubuntu-latest)", conclusion: "success" }] });
    const r = await gate(checkout(), await actionsApi([push]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`No CI run started by hand has run on commit ${COMMIT}`);
    expect(r.stderr).toContain('run "gh workflow run ci.yml --ref v0.7.0-beta.1", wait for it to pass, then re-run this workflow');
  });

  it("refuses a commit whose full CI run failed the install test, naming the job and the run", async () => {
    const failed = fullRun(8, { conclusion: "failure", jobs: FULL_RUN_JOBS.map((name) => ({ name, conclusion: name === "install (windows-latest)" ? "failure" : "success" })) });
    const r = await gate(checkout(), await actionsApi([failed]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`https://github.com/${REPO}/actions/runs/8: install (windows-latest) failed`);
  });

  it("refuses a run that skipped a job or is still running", async () => {
    const skipped = fullRun(8, { jobs: FULL_RUN_JOBS.map((name) => ({ name, conclusion: name === "install (macos-latest)" ? "skipped" : "success" })) });
    const running = fullRun(9, { status: "in_progress", conclusion: null });
    const r = await gate(checkout(), await actionsApi([running, skipped]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("runs/9: it is still in progress");
    expect(r.stderr).toContain("runs/8: install (macos-latest) ended skipped");
  });

  it("takes a passing run started by hand even when a newer one failed", async () => {
    const failed = fullRun(9, { conclusion: "failure", jobs: FULL_RUN_JOBS.map((name) => ({ name, conclusion: name === "journeys (windows-latest)" ? "failure" : "success" })) });
    const r = await gate(checkout(), await actionsApi([failed, fullRun(8)]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain("actions/runs/8");
  });

  it("refuses to release before the signing key is made", async () => {
    const r = await gate(checkout({ publicKey: null }), await actionsApi([fullRun(7)]), ["--tag", "v0.7.0-beta.1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("There is no release public key at .github/release-public-key.pem. Make the signing key once with scripts/release-key-wizard.sh.");
  });

  it("lists every reason at once", async () => {
    const r = await gate(checkout({ version: "0.7.0", publicKey: null }), await actionsApi([]), ["--tag", "v0.7.0"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CHANGELOG.md has no section for 0.7.0");
    expect(r.stderr).toContain("There is no release public key");
    expect(r.stderr).toContain("No CI run started by hand");
  });
});

describe("the release gate in a dry run", () => {
  it("builds the version given, reporting what would refuse a real release as warnings", async () => {
    const r = await gate(checkout({ version: "0.6.0", publicKey: null }), await actionsApi([]), ["--dry-run", "--version", "0.7.0-beta.1"]);
    expect(r.status, r.all).toBe(0);
    expect(r.outputs).toEqual({ version: "0.7.0-beta.1", prerelease: "true" });
    expect(r.notes()).toBe("Attache keeps itself current.\nInstall this release by hand once.\n");
    expect(r.stdout).toContain("::warning title=A release would be refused::There is no release public key");
    expect(r.stdout).toContain("::warning title=A release would be refused::No CI run started by hand");
  });

  it("builds the version in the code when none is given, with empty notes when the changelog has none", async () => {
    const r = await gate(checkout({ version: "0.6.1" }), await actionsApi([fullRun(7)]), ["--dry-run"]);
    expect(r.status, r.all).toBe(0);
    expect(r.outputs).toEqual({ version: "0.6.1", prerelease: "false" });
    expect(r.notes()).toBe("");
    expect(r.stdout).toContain("CHANGELOG.md has no section for 0.6.1");
  });

  it("stops at a version no release can carry", async () => {
    const r = await gate(checkout(), await actionsApi([fullRun(7)]), ["--dry-run", "--version", "0.7.0-rc.1"]);
    expect(r.status).toBe(1);
    expect(r.all).toContain("0.7.0-rc.1 is not a release version");
  });
});

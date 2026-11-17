import { expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JobView, ProposalView } from "@attache/contracts";
import type { TestService } from "./harness.ts";
import type { FixtureServer } from "../fixtures/fixture-server.ts";
import type { FixtureModel, ModelAnswer, ModelCall } from "../fixtures/fixture-model.ts";
import { claudeTranscript } from "../fixtures/agents/transcripts.ts";
import { homeEnv, hookShell, runInShell } from "../fixtures/harness-shell.ts";

/**
 * How the Consolidation tests drive Attache: a Claude Code session that ends
 * through the hook Attache registered, or a meeting capture written into the
 * Brain from outside, with the fixture model answering Consolidation's prompt.
 */

export const ORION = "memory/projects/orion-migration.md";
const work = mkdtempSync(join(tmpdir(), "attache-it-consolidation-"));

export async function until<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const finished = (j: JobView) => ["succeeded", "failed", "blocked", "cancelled"].includes(j.status);

/**
 * Answer the next Consolidation calls with this reply, as a model would, until the returned function is called.
 * A reply object is sent as its JSON; a string, or a reply cut off at the token limit, is sent as it is.
 */
export function consolidationReplies(model: FixtureModel, reply: (call: ModelCall) => unknown): () => void {
  return model.respond((call) => {
    if (!/Consolidation/.test(call.system)) return null;
    const answer = reply(call);
    return typeof answer === "string" || isCutOff(answer) ? answer : JSON.stringify(answer);
  });
}

const isCutOff = (answer: unknown): answer is Exclude<ModelAnswer, string> => typeof answer === "object" && answer !== null && "cutOff" in answer;

export async function connectModel(service: TestService, fx: FixtureServer) {
  await service.post("/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture-model" } });
}

/** The owner's identity, and the Orion project note the tests change. */
export async function setUp(service: TestService) {
  await service.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
  await service.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned" }] }] });
}

/** Switch Consolidation's writing on or off on this Machine, as the Dashboard does. */
export async function consolidationWrites(service: TestService, on: boolean) {
  await service.put("/consolidation/auto-accept", { autoAccept: on });
}

/** Consolidation's Proposals whose source names `from`: a session id, or a capture's path. */
export async function consolidationProposals(service: TestService, from: string): Promise<ProposalView[]> {
  const { proposals } = await service.get<{ proposals: ProposalView[] }>("/memory/proposals?limit=500");
  return proposals.filter((p) => p.proposedBy === "Consolidation" && (p.source ?? "").includes(from));
}

// ---- Harness sessions ---------------------------------------------------------

/** Run the SessionEnd command Attache registered in Claude Code's settings, the way Claude Code does. */
function runSessionEnd(service: TestService, sessionId: string, transcript: string) {
  const home = process.env.ATTACHE_AGENT_HOME!;
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  const command = (settings.hooks.SessionEnd as Array<{ hooks: Array<{ command: string }> }>)
    .flatMap((g) => g.hooks)
    // On Windows the command names the state folder with forward slashes.
    .find((h) => h.command.includes("attache-agent-hook") && h.command.replace(/\\/g, "/").includes(service.stateDir.replace(/\\/g, "/")))!.command;
  runInShell(hookShell("claude-code"), command, { input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: work, reason: "exit" }), env: { ...process.env, ...homeEnv(home) } });
}

/** Make Claude Code's settings folder, so Claude Code can be connected. */
export function claudeCodeHome() {
  mkdirSync(join(process.env.ATTACHE_AGENT_HOME!, ".claude"), { recursive: true });
}

export const sessionJobs = (service: TestService, kind: string, sessionId: string): JobView[] =>
  (service.app.db.prepare("select id from jobs where kind = ? and json_extract(input, '$.sessionId') = ? order by created_at").all(kind, sessionId) as Array<{ id: string }>).map((r) => service.app.jobs.get(r.id)!);

/**
 * End a Claude Code session with these exchanges and wait until Attache has
 * summarised it and, when it found something durable, consolidated it.
 */
export async function endSession(service: TestService, sessionId: string, exchanges: Array<[string, string]>, opts: { awaitConsolidation?: boolean } = {}) {
  const seen = { distill: sessionJobs(service, "session-distill", sessionId).length, consolidate: sessionJobs(service, "session-consolidate", sessionId).length };
  const transcript = join(work, `${sessionId}.jsonl`);
  writeFileSync(transcript, claudeTranscript(sessionId, work, exchanges));
  runSessionEnd(service, sessionId, transcript);
  const distill = await until(() => sessionJobs(service, "session-distill", sessionId).slice(seen.distill).find(finished));
  expect(distill.status).toBe("succeeded");
  const consolidations = () => sessionJobs(service, "session-consolidate", sessionId).slice(seen.consolidate);
  const queued = (distill.result as { consolidation?: string } | null)?.consolidation === "queued";
  const consolidate = queued && opts.awaitConsolidation !== false ? await until(() => consolidations().find(finished)) : null;
  if (consolidate) expect(consolidate.status).toBe("succeeded");
  return { distill, consolidate, laterJobs: consolidations() };
}

// ---- Meeting captures ----------------------------------------------------------

const CAPTURE_JOB = "capture-consolidate";

/** Put a file into a Machine's copy of the Brain from outside Attache, as an export routine or an editor does. */
export function writeIntoBrain(service: TestService, rel: string, content: string) {
  mkdirSync(dirname(join(service.dataDir, rel)), { recursive: true });
  writeFileSync(join(service.dataDir, rel), content);
}

export async function captureJobs(service: TestService): Promise<JobView[]> {
  return ((await service.get<JobView[]>("/jobs?limit=500")) as JobView[]).filter((j) => j.kind === CAPTURE_JOB);
}

/** Wait until Attache has consolidated the capture at `rel`, and return that job. */
export async function consolidated(service: TestService, rel: string): Promise<JobView> {
  const job = await until(async () => (await captureJobs(service)).find((j) => finished(j) && (j.result as { capture?: string } | null)?.capture === rel));
  expect(job.status).toBe("succeeded");
  return job;
}

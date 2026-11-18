import { describe, expect, it } from "vitest";
import type { ActionStatus, ActionView, ProposalView } from "@attache/contracts";
import { draftAnswers, draftOutcome, draftReviewLabel, draftRowText, draftStateTag, finishedRows, nothingWaits, proposalRowText, withDecided } from "../src/approvals.ts";
import type { Answer } from "../src/count.ts";

/** A Draft as `/actions` returns it, with only what a case sets. */
function draft(over: Partial<ActionView> = {}): ActionView {
  return {
    id: "d1",
    kind: "github.comment",
    connectionId: "github",
    title: "Review acme/web#42: Add checkout retry",
    target: { repo: "acme/web", number: 42, url: "https://github.com/acme/web/pull/42" },
    payload: { body: "Looks good.\nOne question about retries." },
    payloadHash: "h".repeat(64),
    version: 1,
    context: {},
    status: "draft",
    expiresAt: "2026-11-20T09:00:00.000Z",
    createdAt: "2026-11-18T09:00:00.000Z",
    updatedAt: "2026-11-18T09:00:00.000Z",
    approval: null,
    receipt: null,
    events: [],
    executable: { ok: true, reason: null },
    ...over,
  };
}

function proposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    id: "p1",
    status: "proposed",
    item: { action: "update", path: "memory/projects/pilot.md", facts: [{ subject: "Owner", value: "Nora", reason: "Handover" }] },
    target: "memory/projects/pilot.md",
    noteTitle: "Pilot rollout",
    reason: "Meeting",
    source: null,
    evidence: null,
    corrections: [],
    proposedBy: "codex",
    createdAt: "2026-11-18T08:00:00.000Z",
    decidedAt: null,
    proposedOn: "Work Mac",
    decidedOn: null,
    ...over,
  };
}

describe("draftRowText", () => {
  it.each<[string, Partial<ActionView>, { destination: string; preview: string | null }]>([
    ["a GitHub comment names the repository and number", {}, { destination: "GitHub comment on acme/web #42", preview: "Looks good." }],
    ["a Jira comment names the issue", { kind: "jira.comment", target: { key: "PAY-1", url: null } }, { destination: "Jira comment on PAY-1", preview: "Looks good." }],
    ["a Confluence comment names the page", { kind: "confluence.comment", target: { pageId: "9" }, context: { source: { title: "Cutover runbook" } } }, { destination: "Confluence comment on Cutover runbook", preview: "Looks good." }],
    ["a Gmail draft names who it goes to", { kind: "gmail.draft", target: { to: "nora@example.com", subject: "Pilot" } }, { destination: "Gmail draft to nora@example.com", preview: "Looks good." }],
    ["a Slack reply names the person", { kind: "slack.post", target: { channel: "D1", thread_ts: "1.2" }, payload: { text: "On it" }, context: { source: { userName: "Nora" } } }, { destination: "Slack reply to Nora", preview: "On it" }],
    ["a Slack message without a person names the channel", { kind: "slack.post", target: { channel: "C42" }, payload: { text: "On it" } }, { destination: "Slack message in C42", preview: "On it" }],
    ["an unknown kind shows the kind", { kind: "teams.post", target: {} }, { destination: "teams.post", preview: "Looks good." }],
    ["the preview skips blank lines and trims", { payload: { body: "\n\n   First words   \nmore" } }, { destination: "GitHub comment on acme/web #42", preview: "First words" }],
    ["an empty Draft has no preview", { payload: { body: "  " } }, { destination: "GitHub comment on acme/web #42", preview: null }],
  ])("%s", (_, over, expected) => {
    const text = draftRowText(draft(over));
    expect({ destination: text.destination, preview: text.preview }).toEqual(expected);
  });

  it("shows the subject without the prefix the kind already says, and the version", () => {
    expect(draftRowText(draft({ version: 3 }))).toMatchObject({ subject: "Add checkout retry", version: "v3" });
    expect(draftRowText(draft({ title: "Reply to Nora: Pilot window" }))).toMatchObject({ subject: "Pilot window" });
    expect(draftRowText(draft({ title: "Plain title" }))).toMatchObject({ subject: "Plain title" });
  });
});

describe("draftAnswers", () => {
  it.each<[string, Record<string, unknown>, { title: string | null; quote: string | null }]>([
    ["a review request quotes the pull request's description", { item: { title: "Review acme/web#42: Add checkout retry" }, source: { body: "Adds retries." } }, { title: "Review acme/web#42: Add checkout retry", quote: "Adds retries." }],
    ["a Slack message quotes its text", { item: { title: "Nora wrote" }, source: { text: "Can you check?" } }, { title: "Nora wrote", quote: "Can you check?" }],
    ["a Gmail thread quotes its snippet", { source: { snippet: "Is Thursday fine?" } }, { title: null, quote: "Is Thursday fine?" }],
    ["a Confluence mention quotes its excerpt", { source: { excerpt: "@you see here" } }, { title: null, quote: "@you see here" }],
    ["a Jira issue quotes its summary", { source: { summary: "Payment retries fail" } }, { title: null, quote: "Payment retries fail" }],
    ["nothing to quote", {}, { title: null, quote: null }],
  ])("%s", (_, context, expected) => {
    expect(draftAnswers(draft({ context }))).toEqual(expected);
  });
});

describe("draftReviewLabel and draftStateTag", () => {
  it.each<[ActionStatus, string, string | null]>([
    ["draft", "Review and approve v2", null],
    ["revoked", "Review and approve v2", "Approval revoked"],
    ["approved", "Review and send v2", "Approved"],
  ])("a %s Draft offers %s", (status, label, tag) => {
    const d = draft({ status, version: 2 });
    expect(draftReviewLabel(d)).toBe(label);
    expect(draftStateTag(d)).toBe(tag);
  });

  it("names an approval that ran out by itself", () => {
    const d = draft({ status: "draft", version: 2, events: [{ event: "approval_expired", data: { version: 2, approvalExpiresAt: "2026-11-18T09:15:00.000Z" }, at: "2026-11-18T09:16:00.000Z", actor: "service" }] });
    expect(draftStateTag(d)).toBe("Approval ended");
    expect(draftReviewLabel(d)).toBe("Review and approve v2");
  });
});

describe("proposalRowText", () => {
  it.each<[string, Partial<ProposalView>, { note: string; added: string | null; change: string }]>([
    ["a correction shows the old value and the new one", { corrections: [{ subject: "Owner", was: { value: "Sam", date: "2026-11-01", review: null }, value: "Nora" }] }, { note: "Pilot rollout", added: null, change: "Owner: Sam → Nora" }],
    ["a fact the note did not hold is an addition", {}, { note: "Pilot rollout", added: null, change: "Owner: Nora" }],
    [
      "several parts name the first and count the rest",
      { item: { action: "update", path: "memory/projects/pilot.md", facts: [{ subject: "Owner", value: "Nora", reason: "x" }, { subject: "Budget", value: "40k", reason: "x" }], events: ["Kick-off"] } },
      { note: "Pilot rollout", added: null, change: "Owner: Nora · 2 more changes" },
    ],
    ["an event alone", { item: { action: "update", path: "memory/projects/pilot.md", events: ["Odense kicked off"] } }, { note: "Pilot rollout", added: null, change: "Event: Odense kicked off" }],
    [
      "a new note names its type",
      { item: { action: "create", type: "person", title: "Noor Aziz", facts: [{ subject: "Role", value: "Analyst" }] }, target: "(new person: Noor Aziz)", noteTitle: "Noor Aziz" },
      { note: "Noor Aziz", added: "New person", change: "Role: Analyst" },
    ],
    ["a note whose title cannot be read is named by its path", { noteTitle: null }, { note: "memory/projects/pilot.md", added: null, change: "Owner: Nora" }],
    ["an unreadable Proposal says so", { item: null }, { note: "Pilot rollout", added: null, change: "This Proposal can no longer be read." }],
  ])("%s", (_, over, expected) => {
    expect(proposalRowText(proposal(over))).toEqual(expected);
  });
});

describe("nothingWaits", () => {
  const rows = <T>(list: T[]): Answer<T> => ({ kind: "rows", rows: list, limit: 100 });
  const none = rows<unknown>([]);
  it.each<[string, Answer<unknown>, Answer<unknown>, boolean]>([
    ["both answered with nothing", none, none, true],
    ["Drafts are off and no Proposal waits", { kind: "off" }, none, true],
    ["a Proposal waits", none, rows([1]), false],
    ["a Draft waits", rows([1]), none, false],
    ["the Drafts request failed", { kind: "failed" }, none, false],
    ["the Proposals request is still out", none, { kind: "waiting" }, false],
  ])("%s: %s", (_, drafts, proposals, expected) => {
    expect(nothingWaits(drafts, proposals)).toBe(expected);
  });
});

describe("withDecided", () => {
  const row = (id: string) => ({ id });
  const decided = new Map([["b", "Rejected"]]);
  it.each<[string, string[], string[], Map<string, string>, string[]]>([
    ["a decided row keeps its place as a line", ["a", "b", "c"], ["a", "c"], decided, ["a", "b:Rejected", "c"]],
    ["a decided row first stays first", ["b", "a"], ["a"], decided, ["b:Rejected", "a"]],
    ["a decided row still listed shows as decided", ["a", "b"], ["a", "b"], decided, ["a", "b:Rejected"]],
    ["a row gone without a decision here leaves", ["a", "b", "c"], ["a"], new Map(), ["a"]],
    ["new rows take their live places", ["a", "b"], ["n", "a"], decided, ["n", "a", "b:Rejected"]],
    ["on the first answer nothing was shown before", [], ["a", "b"], new Map(), ["a", "b"]],
  ])("%s", (_, previous, live, made, expected) => {
    const out = withDecided(previous, live.map(row), made).map((e) => (e.kind === "decided" ? `${e.id}:${e.decision}` : e.row.id));
    expect(out).toEqual(expected);
  });
});

describe("finishedRows", () => {
  it("lists finished Drafts and decided Proposals together, the latest outcome first", () => {
    const drafts = [draft({ id: "sent", status: "succeeded", updatedAt: "2026-11-18T10:00:00.000Z" }), draft({ id: "rejected", status: "rejected", updatedAt: "2026-11-17T10:00:00.000Z" })];
    const proposals = [proposal({ id: "applied", status: "applied", decidedAt: "2026-11-18T11:00:00.000Z" }), proposal({ id: "old", status: "rejected", decidedAt: "2026-11-16T09:00:00.000Z" })];
    expect(finishedRows(drafts, proposals).map((r) => `${r.kind}:${r.row.id}`)).toEqual(["proposal:applied", "draft:sent", "draft:rejected", "proposal:old"]);
  });

  it.each<[ActionStatus, string]>([
    ["succeeded", "Sent"],
    ["failed", "Not sent"],
    ["unknown", "Outcome unknown"],
    ["rejected", "Rejected"],
    ["expired", "Expired"],
  ])("a %s Draft reads %s", (status, word) => {
    expect(draftOutcome(status)).toBe(word);
  });
});

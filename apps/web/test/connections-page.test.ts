import { describe, expect, it } from "vitest";
import type { ConnectionStatus, Coverage, CoverageState } from "@attache/contracts";
import type { FeatureStatus, ReaderView } from "@attache/contracts";
import { connectionsStatus } from "../src/connection-status.ts";
import type { ConnectionDefinition } from "@attache/contracts";
import { connectionsPage, openAtStart, openNewlyNeeded, rowCells, type PageGroup } from "../src/connections-page.ts";

// The Connections page from the Connections the service lists (`/capabilities`) and whether Attention is on.

const AT = "2026-11-18T08:06:00.000Z";
const LAST_OK = "2026-11-18T07:36:00.000Z";

const LABEL: Record<string, string> = { vault: "Attache data folder", github: "GitHub", jira: "Jira", confluence: "Confluence", slack: "Slack", gmail: "Gmail", gcal: "Google Calendar", model: "Model", "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity", "claude-desktop": "Claude Desktop" };

function coverage(state: CoverageState, extra: Partial<Coverage> = {}): Coverage {
  return { state, scopes: [], items: 3, at: AT, ...extra };
}

function conn(kind: ConnectionStatus["kind"], extra: Partial<ConnectionStatus> = {}): ConnectionStatus {
  const readable = !["model", "claude-code", "codex", "antigravity", "claude-desktop"].includes(kind);
  return {
    id: kind,
    kind,
    label: LABEL[kind] ?? kind,
    status: "connected",
    account: null,
    readScopes: [],
    writeActions: [],
    availableScopes: [],
    availableWriteActions: [],
    settings: {},
    lastAttemptAt: AT,
    lastSuccessAt: LAST_OK,
    lastReadAt: readable ? LAST_OK : null,
    lastError: null,
    coverage: readable ? coverage("complete") : null,
    authMethod: "token",
    setupHelp: "",
    ...extra,
  };
}

const unset = (kind: ConnectionStatus["kind"]) => conn(kind, { status: "not_configured", coverage: null, lastSuccessAt: null, lastReadAt: null, lastAttemptAt: null });

/** What the service lists on a typical Machine: the data folder, GitHub and Gmail, the model, Claude Code; the rest not set up. */
const TYPICAL = [conn("vault", { id: "vault-data", settings: { builtin: true } }), conn("model"), conn("github"), conn("claude-code"), unset("jira"), unset("confluence"), unset("slack"), conn("gmail"), unset("gcal"), unset("codex"), unset("antigravity"), unset("claude-desktop")];

/** Each group as `id: rows | tiles`, by id, so a table reads at a glance. */
function shape(groups: PageGroup[]): Record<string, string> {
  return Object.fromEntries(groups.map((g) => [g.id, `${g.rows.map((r) => r.connection.id).join(",")} | ${g.tiles.map((c) => c.id).join(",")}`]));
}

describe("connectionsPage: the groups", () => {
  it("puts set-up Connections in rows and the rest in tiles under their group, in the order Notes, Work sources, Harnesses, Model", () => {
    const page = connectionsPage(TYPICAL, true);
    expect(page.map((g) => g.title)).toEqual(["Notes", "Work sources", "Harnesses", "Model"]);
    expect(shape(page)).toEqual({
      notes: "vault-data | ",
      work: "github,gmail | jira,confluence,slack,gcal",
      harnesses: "claude-code | codex,antigravity,claude-desktop",
      model: "model | ",
    });
  });
});

describe("connectionsPage: Needs you", () => {
  it("is absent while nothing needs sign-in", () => {
    expect(connectionsPage(TYPICAL, true).some((g) => g.id === "needs_you")).toBe(false);
  });

  it("comes first and holds every Connection that needs sign-in, which leaves its own group (one Connection, one row)", () => {
    const signedOut = TYPICAL.map((c) => (c.id === "github" ? { ...c, status: "needs_auth" as const } : c.id === "model" ? { ...c, status: "needs_auth" as const } : c));
    const page = connectionsPage(signedOut, true);
    expect(page[0]).toMatchObject({ id: "needs_you", title: "Needs you" });
    expect(shape(page)).toEqual({
      needs_you: "github,model | ",
      notes: "vault-data | ",
      work: "gmail | jira,confluence,slack,gcal",
      harnesses: "claude-code | codex,antigravity,claude-desktop",
    });
    expect(page[0]!.rows.map((r) => r.problem?.word)).toEqual(["Sign-in needed", "Sign-in needed"]);
  });

  it("holds a source whose last read was refused for sign-in, as Home's Sign-in needed row does, but only while sources are read", () => {
    const refused = TYPICAL.map((c) => (c.id === "gmail" ? { ...c, coverage: coverage("unauthorized") } : c));
    expect(shape(connectionsPage(refused, true)).needs_you).toBe("gmail | ");
    expect(connectionsPage(refused, false).some((g) => g.id === "needs_you")).toBe(false);
  });

  it("keeps the Notes group, where a folder is imported, even with no folder set up", () => {
    const page = connectionsPage(TYPICAL.filter((c) => c.kind !== "vault"), true);
    expect(page.find((g) => g.id === "notes")).toMatchObject({ rows: [], tiles: [] });
  });
});

describe("connectionsPage: a row's state", () => {
  const states: Array<[string, ConnectionStatus, string | null, string | null]> = [
    ["works", conn("github"), null, null],
    ["signed out", conn("github", { status: "needs_auth" }), "Sign-in needed", "amber"],
    ["down", conn("github", { status: "error", lastError: "500" }), "Down", "red"],
    ["a read that failed", conn("github", { coverage: coverage("error") }), "Down", "red"],
    ["not reached", conn("github", { coverage: coverage("offline") }), "Offline", "red"],
    ["a refused scope", conn("github", { coverage: coverage("complete", { scopes: [{ scope: "issues", state: "denied", items: 0, pages: 0 }] }) }), "Access denied", "amber"],
    ["partly read", conn("github", { coverage: coverage("partial") }), "Partly read", "amber"],
    ["never read", conn("github", { coverage: null, lastReadAt: null }), "Not read yet", "slate"],
    ["a model that works", conn("model"), null, null],
    ["a Harness that is down", conn("claude-code", { status: "error" }), "Down", "red"],
  ];
  for (const [name, c, word, hue] of states) {
    it(`${name}: ${word ?? "no state word"}`, () => {
      const row = connectionsPage([c], true).flatMap((g) => g.rows)[0]!;
      expect(row.problem?.word ?? null).toBe(word);
      expect(row.problem?.hue ?? null).toBe(hue);
    });
  }

  it("shows no reading problem while Attention is off, as Home does: nothing is read then", () => {
    const row = connectionsPage([conn("github", { coverage: coverage("offline") })], false).flatMap((g) => g.rows)[0]!;
    expect(row.problem).toBeNull();
  });
});

describe("connectionsPage agrees with Home's Connections area", () => {
  const reader: ReaderView = { machine: { id: "m1", name: "Work Mac" }, thisMachine: true, replicated: false, heartbeatAt: null, silent: false, lastRefreshAt: AT };
  const attention: FeatureStatus = { id: "attention", label: "Attention and briefings", description: "", core: false, enabled: true, readiness: "ready", reason: null, dependsOn: { features: [], connections: [] }, schedules: [] };
  const broken: ConnectionStatus[] = [
    conn("github", { status: "needs_auth" }),
    conn("gmail", { status: "error" }),
    conn("slack", { coverage: coverage("offline") }),
    conn("jira", { coverage: coverage("partial") }),
    conn("confluence", { coverage: coverage("denied") }),
    conn("model", { status: "needs_auth" }),
    conn("claude-code", { status: "error" }),
  ];
  it("names each Connection's problem with the word and colour of its row on Home", () => {
    const home = connectionsStatus({ connections: { state: "ok", data: broken }, features: { state: "ok", data: [attention] }, reader: { state: "ok", data: reader }, nextRefreshAt: null });
    if (home.kind !== "problems") throw new Error("expected problems on Home");
    const onHome = Object.fromEntries(home.rows.filter((r) => r.subject !== "Notes").map((r) => [r.subject, `${r.word} ${r.hue}`]));
    const onPage = Object.fromEntries(connectionsPage(broken, true).flatMap((g) => g.rows).map((r) => [r.connection.label, `${r.problem!.word} ${r.problem!.hue}`]));
    expect(onPage).toEqual(onHome);
  });
});

describe("rowCells: account, permission and last read, each its own column", () => {
  const def = (kind: ConnectionStatus["kind"], extra: Partial<ConnectionDefinition> = {}): ConnectionDefinition => ({ kind, label: LABEL[kind] ?? kind, description: "", authMethods: [], scopes: [], writeActions: [], setupHelp: "", unavoidableSteps: [], ...extra });
  const github = def("github", {
    scopes: [{ id: "review_requests", label: "Pull requests requesting my review", default: true }, { id: "authored", label: "My open pull requests", default: true }, { id: "assigned", label: "Issues assigned to me", default: true }],
    writeActions: [{ id: "github.comment", label: "Post a comment on a pull request or issue" }],
  });

  const cases: Array<[string, ConnectionStatus, ConnectionDefinition, ReturnType<typeof rowCells>]> = [
    [
      "a work source reads what was chosen and writes nothing until a write is allowed",
      conn("github", { account: "alex", readScopes: ["review_requests", "assigned"] }),
      github,
      { account: "alex", reads: "pull requests requesting my review and issues assigned to me", writes: "nothing", last: { label: "Last read", at: LAST_OK } },
    ],
    [
      "an allowed write is named; a scope the definition no longer lists keeps its id",
      conn("github", { account: "alex", readScopes: ["review_requests", "old_scope"], writeActions: ["github.comment"] }),
      github,
      { account: "alex", reads: "pull requests requesting my review and old_scope", writes: "post a comment on a pull request or issue", last: { label: "Last read", at: LAST_OK } },
    ],
    [
      "a scope label that starts with a name keeps its case",
      conn("github", { readScopes: ["pr"] }),
      def("github", { scopes: [{ id: "pr", label: "PRs I opened", default: true }] }),
      { account: null, reads: "PRs I opened", writes: "nothing", last: { label: "Last read", at: LAST_OK } },
    ],
    ["a source with nothing chosen reads nothing", conn("github", { account: "alex" }), github, { account: "alex", reads: "nothing", writes: "nothing", last: { label: "Last read", at: LAST_OK } }],
    ["a source never read says so by its missing time", conn("gcal", { lastReadAt: null }), def("gcal"), { account: null, reads: "nothing", writes: "nothing", last: { label: "Last read", at: null } }],
    [
      "the data folder is read whole and is where Attache writes the Brain",
      conn("vault", { account: "/home/alex/Attache", settings: { builtin: true }, readScopes: ["tasks"] }),
      def("vault", { scopes: [{ id: "tasks", label: "Tasks and notes with due dates", default: true }] }),
      { account: "/home/alex/Attache", reads: "its Markdown files", writes: "the Brain", last: { label: "Last read", at: LAST_OK } },
    ],
    ["the model reads only what Attache sends it, and answers rather than reads", conn("model", { account: "anthropic · claude" }), def("model"), { account: "anthropic · claude", reads: "only what Attache sends it", writes: "nothing", last: { label: "Last answered", at: LAST_OK } }],
    ["a Harness reaches the Brain", conn("claude-code", { account: "~/.claude/settings.json" }), def("claude-code"), { account: "~/.claude/settings.json", reads: "the Brain", writes: "to the Brain", last: { label: "Last answered", at: LAST_OK } }],
  ];
  for (const [name, c, d, expected] of cases) {
    it(name, () => expect(rowCells(c, d)).toEqual(expected));
  }
});

describe("openAtStart: rows open when the page opens", () => {
  const signedOut = TYPICAL.map((c) => (c.id === "gmail" || c.id === "model" ? { ...c, status: "needs_auth" as const } : c));
  it("opens every row in Needs you, and nothing else on a plain visit", () => {
    expect([...openAtStart(connectionsPage(signedOut, true), null)].sort()).toEqual(["gmail", "model"]);
    expect([...openAtStart(connectionsPage(TYPICAL, true), null)]).toEqual([]);
  });
  it("also opens the row or tile a link names (Home's Reconnect, Open in Connections)", () => {
    expect([...openAtStart(connectionsPage(signedOut, true), "github")].sort()).toEqual(["github", "gmail", "model"]);
    expect([...openAtStart(connectionsPage(TYPICAL, true), "slack")]).toEqual(["slack"]);
  });
  it("ignores a link to a Connection the page does not show", () => {
    expect([...openAtStart(connectionsPage(TYPICAL, true), "nope")]).toEqual([]);
  });
});

describe("openNewlyNeeded: a Connection that comes to need sign-in while the page is open", () => {
  const signedOut = (...ids: string[]) => connectionsPage(TYPICAL.map((c) => (ids.includes(c.id) ? { ...c, status: "needs_auth" as const } : c)), true);
  it("opens when it arrives in Needs you, keeping every other row as the owner left it", () => {
    expect([...openNewlyNeeded(new Set(["claude-code"]), connectionsPage(TYPICAL, true), signedOut("github"))].sort()).toEqual(["claude-code", "github"]);
  });
  it("stays closed once the owner closed it in Needs you", () => {
    expect([...openNewlyNeeded(new Set(), signedOut("github"), signedOut("github", "gmail"))]).toEqual(["gmail"]);
  });
});

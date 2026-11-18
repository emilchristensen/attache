import { describe, expect, it } from "vitest";
import type { ConnectionStatus, Coverage, CoverageState, FeatureStatus, ReaderView } from "@attache/contracts";
import { connectionsStatus, inboxCoverage, splitRows, type Reply, type StatusInputs, type StatusRow } from "../src/connection-status.ts";

// Fixtures of the three answers the Dashboard already asks for: /connections, /capabilities (features) and /reader.

const AT = "2026-11-18T08:06:00.000Z";
const LAST_OK = "2026-11-18T07:36:00.000Z";
const NEXT = "2026-11-18T08:36:00.000Z";

const LABEL: Record<string, string> = { vault: "Notes", github: "GitHub", jira: "Jira", confluence: "Confluence", slack: "Slack", gmail: "Gmail", gcal: "Google Calendar", model: "Model", "claude-code": "Claude Code" };

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
    lastError: null,
    coverage: readable ? coverage("complete") : null,
    authMethod: "token",
    setupHelp: "",
    ...extra,
  };
}

function feature(id: FeatureStatus["id"], extra: Partial<FeatureStatus> = {}): FeatureStatus {
  const label = { recall: "Recall", capture: "Capture", attention: "Attention and briefings", drafts: "Drafts and approvals", jobs: "Background jobs", sessions: "Sessions" }[id];
  const connections = id === "drafts" ? [{ kinds: ["model" as const], label: "A model to prepare drafts", required: false }] : [];
  return { id, label, description: "", core: false, enabled: true, readiness: "ready", reason: null, dependsOn: { features: [], connections }, schedules: [], ...extra };
}

const THIS_READER: ReaderView = { machine: { id: "m1", name: "Work Mac" }, thisMachine: true, replicated: false, heartbeatAt: null, silent: false, lastRefreshAt: AT };
const OTHER_READER: ReaderView = { machine: { id: "m2", name: "Home PC" }, thisMachine: false, replicated: true, heartbeatAt: AT, silent: false, lastRefreshAt: AT };

const ok = <T>(data: T): Reply<T> => ({ state: "ok", data });
const HEALTHY_CONNECTIONS = [conn("vault"), conn("github"), conn("gmail"), conn("slack"), conn("model"), conn("claude-code"), conn("jira", { status: "not_configured", coverage: null, lastSuccessAt: null })];
const FEATURES = [feature("recall"), feature("attention"), feature("drafts"), feature("jobs")];

function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  return { connections: ok(HEALTHY_CONNECTIONS), features: ok(FEATURES), reader: ok(THIS_READER), nextRefreshAt: NEXT, ...over };
}

/** The healthy fixture with some Connections replaced or added, matched by id. */
function withConnections(...changed: ConnectionStatus[]): StatusInputs {
  const ids = new Set(changed.map((c) => c.id));
  return inputs({ connections: ok([...HEALTHY_CONNECTIONS.filter((c) => !ids.has(c.id)), ...changed]) });
}

function rowsOf(i: StatusInputs): StatusRow[] {
  const s = connectionsStatus(i);
  if (s.kind !== "problems") throw new Error(`expected problem rows, got ${s.kind}`);
  return s.rows;
}

function onlyRow(i: StatusInputs): StatusRow {
  const rows = rowsOf(i);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("connectionsStatus: the green line", () => {
  it("says All good, with what was checked, only when all three answers arrived and everything is healthy", () => {
    expect(connectionsStatus(inputs())).toEqual({ kind: "all_good", sources: 4, others: 2, lastReadAt: AT, reader: "This Machine" });
  });

  it("names another Machine when it is the Reader", () => {
    expect(connectionsStatus(inputs({ reader: ok(OTHER_READER) }))).toMatchObject({ kind: "all_good", reader: "Home PC" });
  });

  it("counts an empty read as read, and never lists Connections that are not set up or disconnected", () => {
    const s = connectionsStatus(withConnections(conn("gmail", { coverage: coverage("empty", { items: 0 }) }), conn("gcal", { status: "disconnected", coverage: null })));
    expect(s).toMatchObject({ kind: "all_good", sources: 4 });
  });

  it("ignores a feature the owner switched off", () => {
    const s = connectionsStatus(inputs({ features: ok([...FEATURES, feature("sessions", { enabled: false, readiness: "disabled" })]) }));
    expect(s.kind).toBe("all_good");
  });
});

describe("connectionsStatus: one case per state", () => {
  it("Checking while any of the three answers has not arrived, and claims nothing else", () => {
    for (const key of ["connections", "features", "reader"] as const) {
      const row = onlyRow(inputs({ [key]: { state: "waiting" } }));
      expect(row).toMatchObject({ state: "checking", word: "Checking", hue: "slate", icon: "question", action: null });
    }
  });

  it("Could not check, with Retry, when a request failed, naming which one", () => {
    const row = onlyRow(inputs({ reader: { state: "failed", message: "Network error" }, connections: { state: "waiting" } }));
    expect(row).toMatchObject({ state: "could_not_check", word: "Could not check", hue: "slate", icon: "question", action: { kind: "retry_check" } });
    expect(row.sentence).toContain("the Reader");
    expect(row.failure).toBe("Network error");
  });

  it("Sign-in needed in amber with a key and Reconnect, keeping the impact on the collapsed line", () => {
    const row = onlyRow(withConnections(conn("gmail", { status: "needs_auth", lastError: "Token expired" })));
    expect(row).toMatchObject({ state: "sign_in", word: "Sign-in needed", hue: "amber", icon: "key", subject: "Gmail", impact: "Replies may be missing", counted: true, action: { kind: "reconnect", connectionId: "gmail" } });
    expect(row.sentence).toBe("Gmail signed you out, so Gmail replies may be missing below.");
    expect(row.lastRead).toEqual([{ name: "Gmail", at: LAST_OK }]);
    expect(row.failure).toBe("Token expired");
  });

  it("Sign-in needed for a read the source refused as unauthorized, which is not counted in the dot", () => {
    const row = onlyRow(withConnections(conn("slack", { coverage: coverage("unauthorized") })));
    expect(row).toMatchObject({ state: "sign_in", subject: "Slack", impact: "Replies and mentions may be missing", counted: false, action: { kind: "reconnect", connectionId: "slack" } });
  });

  it("Sign-in needed for the model says what waits instead of what is missing", () => {
    const row = onlyRow(withConnections(conn("model", { status: "needs_auth" })));
    expect(row).toMatchObject({ state: "sign_in", subject: "Model", impact: "Briefings and new Drafts wait", counted: true, lastRead: [] });
  });

  it("Not reading, red, when no Machine is the Reader", () => {
    const row = onlyRow(inputs({ reader: ok({ ...OTHER_READER, machine: null, lastRefreshAt: null }) }));
    expect(row).toMatchObject({ state: "not_reading", word: "Not reading", hue: "red", icon: "warning", subject: "No Machine", action: { kind: "machines" }, retry: { kind: "none" } });
    expect(row.lastRead).toEqual([{ name: "Every source", at: null }]);
  });

  it("Not reading when the Reader is silent, with when it last read", () => {
    const row = onlyRow(inputs({ reader: ok({ ...OTHER_READER, silent: true }) }));
    expect(row).toMatchObject({ state: "not_reading", subject: "Home PC", retry: { kind: "none" } });
    expect(row.sentence).toBe("Home PC, the Reader, went silent, so no Machine reads the sources and new items may be missing below.");
    expect(row.lastRead).toEqual([{ name: "Every source", at: AT }]);
  });

  it("Down, red, with what failed, when it last worked and Retry now", () => {
    const row = onlyRow(withConnections(conn("slack", { status: "error", lastError: "The request timed out" })));
    expect(row).toMatchObject({ state: "down", word: "Down", hue: "red", icon: "warning", subject: "Slack", failure: "The request timed out", action: { kind: "test", connectionId: "slack", label: "Retry now" } });
    expect(row.sentence).toBe("Slack is not answering, so Slack replies and mentions may be missing below.");
    expect(row.lastRead).toEqual([{ name: "Slack", at: LAST_OK }]);
  });

  it("Down for a read that failed although the Connection is signed in", () => {
    const row = onlyRow(withConnections(conn("github", { coverage: coverage("error", { note: "GitHub answered 503" }) })));
    expect(row).toMatchObject({ state: "down", subject: "GitHub", failure: "GitHub answered 503" });
  });

  it("Down for a Harness tests it again, and has no last read since it has no Source refresh", () => {
    const row = onlyRow(withConnections(conn("claude-code", { status: "error", lastError: "Not installed" })));
    expect(row).toMatchObject({ state: "down", subject: "Claude Code", lastRead: [], action: { kind: "test", connectionId: "claude-code", label: "Retry now" } });
  });

  it("Offline, red, as one row for every source this Machine could not reach", () => {
    const row = onlyRow(withConnections(conn("github", { coverage: coverage("offline") }), conn("gmail", { coverage: coverage("offline") }), conn("slack", { coverage: coverage("offline") })));
    expect(row).toMatchObject({ state: "offline", word: "Offline", hue: "red", icon: "warning", subject: "GitHub, Gmail and Slack", impact: "Their items may be missing", action: { kind: "refresh", connectionIds: ["github", "gmail", "slack"], label: "Retry now" } });
    expect(row.sentence).toBe("3 sources could not be reached, so their items may be missing below.");
    expect(row.lastRead).toHaveLength(3);
  });

  it("Access denied, amber with a key, for the source or one of its scopes, naming what was refused", () => {
    const scoped = coverage("complete", { scopes: [{ scope: "review requests for @me", state: "denied", items: 0, pages: 0 }, { scope: "assigned issues", state: "complete", items: 2, pages: 1 }] });
    for (const cov of [coverage("denied"), scoped]) {
      const row = onlyRow(withConnections(conn("github", { coverage: cov })));
      expect(row).toMatchObject({ state: "denied", word: "Access denied", hue: "amber", icon: "key", subject: "GitHub", action: { kind: "open_connections", connectionId: "github" } });
    }
    expect(onlyRow(withConnections(conn("github", { coverage: scoped }))).failure).toBe("Refused: review requests for @me");
  });

  it("Partly read, amber, with the coverage note", () => {
    const row = onlyRow(withConnections(conn("gmail", { coverage: coverage("partial", { note: "Stopped after 3 of 5 pages" }) })));
    expect(row).toMatchObject({ state: "partial", word: "Partly read", hue: "amber", icon: "warning", subject: "Gmail", failure: "Stopped after 3 of 5 pages", action: { kind: "open_connections", connectionId: "gmail" } });
  });

  it("Partly working and Needs setup, amber with a key, give the service's reason and Open Settings", () => {
    const partly = onlyRow(inputs({ features: ok([...FEATURES.filter((f) => f.id !== "drafts"), feature("drafts", { readiness: "partial", reason: "No model is connected." })]) }));
    expect(partly).toMatchObject({ state: "partly_working", word: "Partly working", hue: "amber", icon: "key", subject: "Drafts and approvals", sentence: "No model is connected.", action: { kind: "open_settings" } });
    const setup = onlyRow(inputs({ features: ok([...FEATURES.filter((f) => f.id !== "recall"), feature("recall", { readiness: "needs_setup", reason: "Choose a folder." })]) }));
    expect(setup).toMatchObject({ state: "needs_setup", word: "Needs setup", hue: "amber", icon: "key", subject: "Recall" });
  });

  it("Cannot run, red, for a switched-on feature that is unavailable", () => {
    const row = onlyRow(inputs({ features: ok([...FEATURES.filter((f) => f.id !== "drafts"), feature("drafts", { readiness: "unavailable", reason: "A model: connection needs attention." })]) }));
    expect(row).toMatchObject({ state: "cannot_run", word: "Cannot run", hue: "red", icon: "warning", subject: "Drafts and approvals", action: { kind: "open_settings" } });
  });

  it("Not read yet, slate with a question mark, with no invented last-read time, as one row for every new source", () => {
    const row = onlyRow(withConnections(conn("jira", { coverage: null, lastSuccessAt: null }), conn("gcal", { coverage: coverage("never_run"), lastSuccessAt: null })));
    expect(row).toMatchObject({ state: "not_read_yet", word: "Not read yet", hue: "slate", icon: "question", subject: "Jira and Google Calendar", action: { kind: "refresh", connectionIds: ["jira", "gcal"], label: "Refresh now" } });
    expect(row.lastRead).toEqual([{ name: "Jira", at: null }, { name: "Google Calendar", at: null }]);
  });

  it("Notes only, slate, when no work source is connected", () => {
    const row = onlyRow(inputs({ connections: ok([conn("vault"), conn("model")]) }));
    expect(row).toMatchObject({ state: "notes_only", word: "Notes only", hue: "slate", subject: "Notes", action: { kind: "open_connections" } });
    expect(row.sentence).toBe("No work source is connected, so the Inbox holds only deadlines and facts from your notes.");
  });

  it("Switched off, slate, when Attention and briefings is off, and drops what only reading would show", () => {
    const off = [...FEATURES.filter((f) => f.id !== "attention" && f.id !== "drafts"), feature("attention", { enabled: false, readiness: "disabled" }), feature("drafts", { enabled: false, readiness: "disabled" })];
    const i = { ...withConnections(conn("gmail", { coverage: coverage("partial") }), conn("slack", { status: "needs_auth" })), features: ok(off), reader: ok({ ...OTHER_READER, silent: true }) };
    const rows = rowsOf(i);
    expect(rows.map((r) => r.state)).toEqual(["sign_in", "switched_off"]);
    expect(rows[1]).toMatchObject({ word: "Switched off", hue: "slate", subject: "Attention and briefings", action: { kind: "open_settings" } });
  });
});

describe("connectionsStatus: rules for every row", () => {
  const MIXED = withConnections(
    conn("jira", { coverage: null, lastSuccessAt: null }),
    conn("gmail", { status: "error", lastError: "503" }),
    conn("github", { coverage: coverage("partial") }),
    conn("slack", { status: "needs_auth" }),
    conn("confluence", { coverage: coverage("denied") }),
    conn("gcal", { coverage: coverage("offline") }),
  );

  it("orders by what the owner can do: sign-in, not reading, down, offline, denied, partly read, features, cannot run, not read yet", () => {
    const i = { ...MIXED, reader: ok({ ...THIS_READER, silent: true }), features: ok([feature("attention"), feature("drafts", { readiness: "partial", reason: "x" }), feature("recall", { readiness: "unavailable", reason: "y" })]) };
    expect(rowsOf(i).map((r) => r.state)).toEqual(["sign_in", "not_reading", "down", "offline", "denied", "partial", "partly_working", "cannot_run", "not_read_yet"]);
  });

  it("shows at most three rows, the rest behind one disclosure", () => {
    const rows = rowsOf(MIXED);
    const { shown, more } = splitRows(rows);
    expect(shown).toHaveLength(3);
    expect(more).toHaveLength(rows.length - 3);
    expect(splitRows(rows.slice(0, 3)).more).toEqual([]);
  });

  it("says how many others work, counting only what passed", () => {
    const s = connectionsStatus(withConnections(conn("gmail", { status: "needs_auth" })));
    expect(s).toMatchObject({ kind: "problems", working: { sources: 3, others: 2 } });
  });

  it("says nothing about the others while no Machine reads them", () => {
    const s = connectionsStatus(inputs({ reader: ok({ ...THIS_READER, silent: true }) }));
    expect(s).toMatchObject({ kind: "problems", working: null });
  });

  it("promises the next automatic read only when this Machine is an active Reader with a scheduled refresh", () => {
    const down = conn("slack", { status: "error" });
    const retryOf = (over: Partial<StatusInputs>) => onlyRow({ ...withConnections(down), ...over }).retry;
    expect(retryOf({})).toEqual({ kind: "at", at: NEXT });
    // Nothing is scheduled on this Machine.
    expect(retryOf({ nextRefreshAt: null })).toBeNull();
    // Another Machine reads: its schedule is not known here.
    expect(retryOf({ reader: ok(OTHER_READER) })).toBeNull();
  });

  it("says nothing retries by itself while no Machine reads", () => {
    const rows = rowsOf({ ...withConnections(conn("slack", { status: "error" })), reader: ok({ ...THIS_READER, silent: true }) });
    expect(rows.find((r) => r.state === "down")!.retry).toEqual({ kind: "none" });
  });

  it("takes last-read times only from stored success times", () => {
    const row = onlyRow(withConnections(conn("slack", { status: "error", lastSuccessAt: null, lastAttemptAt: AT })));
    expect(row.lastRead).toEqual([{ name: "Slack", at: null }]);
  });

  it("gives every row a word, a colour, an icon, a sentence and at most one button", () => {
    for (const row of rowsOf(MIXED)) {
      expect(row.word).not.toBe("");
      expect(["amber", "red", "slate"]).toContain(row.hue);
      expect(["key", "warning", "question", "brain", "settings"]).toContain(row.icon);
      expect(row.sentence).toMatch(/\.$/);
    }
  });
});

describe("connectionsStatus: findings from review round 1", () => {
  it("is not green before the Reader stored a refresh of every source: one Not read yet row for every source", () => {
    const row = onlyRow(inputs({ reader: ok({ ...THIS_READER, lastRefreshAt: null }) }));
    expect(row).toMatchObject({ state: "not_read_yet", subject: "Every source", action: { kind: "refresh", connectionIds: ["vault", "github", "gmail", "slack"], label: "Refresh now" } });
  });

  it("names a refused scope Access denied even when the service's overall state is partial", () => {
    const cov = coverage("partial", { scopes: [{ scope: "review requests for @me", state: "denied", items: 0, pages: 0 }, { scope: "authored pull requests", state: "complete", items: 2, pages: 1 }] });
    expect(onlyRow(withConnections(conn("github", { coverage: cov })))).toMatchObject({ state: "denied", failure: "Refused: review requests for @me" });
  });

  it("folds a feature that waits on a broken Connection into that Connection's row: one cause, one row", () => {
    const drafts = feature("drafts", { readiness: "partial", reason: "Drafts start empty for you to write; Attache cannot prepare them." });
    const i = { ...withConnections(conn("model", { status: "needs_auth" })), features: ok([...FEATURES.filter((f) => f.id !== "drafts"), drafts]) };
    const row = onlyRow(i);
    expect(row).toMatchObject({ state: "sign_in", subject: "Model", alsoAffected: ["Drafts and approvals"] });
  });

  it("retries a Connection that is in error by testing it, and a failed read by reading again", () => {
    expect(onlyRow(withConnections(conn("slack", { status: "error" }))).action).toEqual({ kind: "test", connectionId: "slack", label: "Retry now" });
    expect(onlyRow(withConnections(conn("github", { coverage: coverage("error") }))).action).toEqual({ kind: "refresh", connectionIds: ["github"], label: "Retry now" });
  });

  it("shows no last-read time for a source that was never read, even after a successful test", () => {
    const row = onlyRow(withConnections(conn("jira", { coverage: null, lastSuccessAt: AT })));
    expect(row.lastRead).toEqual([{ name: "Jira", at: null }]);
  });

  it("says a source could not be reached, not that this Machine had no network, since the service also files timeouts and 5xx answers there", () => {
    const row = onlyRow(withConnections(conn("github", { coverage: coverage("offline") }), conn("gmail", { coverage: coverage("offline") })));
    expect(row.sentence).toBe("2 sources could not be reached, so their items may be missing below.");
  });
});

describe("inboxCoverage: what an empty Inbox may claim", () => {
  it("claims every source only on the green line, the notes alone when nothing else is connected, and nothing otherwise", () => {
    expect(inboxCoverage(connectionsStatus(inputs()))).toBe("all");
    expect(inboxCoverage(connectionsStatus(inputs({ connections: ok([conn("vault"), conn("model")]) })))).toBe("notes");
    expect(inboxCoverage(connectionsStatus(inputs({ connections: ok([conn("vault", { coverage: coverage("partial") }), conn("model")]) })))).toBe("incomplete");
    expect(inboxCoverage(connectionsStatus(withConnections(conn("gmail", { status: "needs_auth" }))))).toBe("incomplete");
    expect(inboxCoverage(connectionsStatus(inputs({ reader: { state: "waiting" } })))).toBe("incomplete");
    // Problems that hide no Inbox item: the model signed out, a Harness down, a feature other than Attention not ready.
    expect(inboxCoverage(connectionsStatus(withConnections(conn("model", { status: "needs_auth" }), conn("claude-code", { status: "error" }))))).toBe("all");
    const sessions = feature("sessions", { readiness: "needs_setup", reason: "Connect a Harness." });
    expect(inboxCoverage(connectionsStatus(inputs({ connections: ok([conn("vault")]), features: ok([...FEATURES, sessions]) })))).toBe("notes");
    expect(inboxCoverage(connectionsStatus(inputs({ features: ok([...FEATURES.filter((f) => f.id !== "attention"), feature("attention", { readiness: "unavailable", reason: "x" })]) })))).toBe("incomplete");
  });
});

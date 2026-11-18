import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ConnectionDefinition, ConnectionStatus, FeatureStatus } from "@attache/contracts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, Time, useLocation } from "../components/ui.tsx";
import { Icon } from "../components/icons.tsx";
import { ConnectionControls, connectionDescription } from "../components/ConnectionCard.tsx";
import { hueClass } from "../theme/hues.ts";
import { connectionsPage, openAtStart, openNewlyNeeded, rowCells, type GroupId, type PageGroup, type PageRow } from "../connections-page.ts";
import { ReaderLine } from "./ReaderLine.tsx";
import { ImportFolder } from "./ImportFolder.tsx";

interface Caps {
  features: FeatureStatus[];
  connections: ConnectionStatus[];
  definitions: ConnectionDefinition[];
}

/** What each group calls its account column: a folder, an account, the settings file a Harness was installed in, a provider. */
const ACCOUNT_HEADING: Record<GroupId, string> = { needs_you: "Account", notes: "Folder", work: "Account", harnesses: "Installed in", model: "Provider" };

/**
 * The open rows, as the page opened them, then as the owner opens and closes them. A live answer opens only a
 * Connection that has just come to need sign-in; it never closes a row or opens any other.
 */
function useOpenRows(groups: PageGroup[] | null, openId: string | null) {
  const [open, setOpen] = useState<Set<string> | null>(null);
  const before = useRef<PageGroup[] | null>(null);
  const loaded = groups !== null;
  useEffect(() => {
    // Chosen once the first answer arrives, and again when a link names another Connection.
    if (loaded) setOpen(openAtStart(groups, openId));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `groups` changes with every live answer; only arrival and the link choose.
  }, [loaded, openId]);
  useEffect(() => {
    const was = before.current;
    before.current = groups;
    if (was && groups) setOpen((now) => (now ? openNewlyNeeded(now, was, groups) : now));
  }, [groups]);
  const toggle = (id: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return { open: open ?? new Set<string>(), toggle };
}

type TestResult = { message: string | null; set: (message: string | null) => void };
interface TestResults {
  of: (id: string) => TestResult;
}

/** The last Test or connect result per Connection, kept by the page so it survives a row moving between groups. */
function useTestResults(): TestResults {
  const [messages, setMessages] = useState<ReadonlyMap<string, string | null>>(new Map());
  return { of: (id) => ({ message: messages.get(id) ?? null, set: (message) => setMessages((now) => new Map(now).set(id, message)) }) };
}

/** Home's Reconnect and Open in Connections land here: bring that Connection's controls into view and put the keyboard in them. */
function useArrival(openId: string | null, ready: boolean) {
  useEffect(() => {
    if (!ready || !openId) return;
    const target = document.querySelector<HTMLElement>(`[data-connection="${CSS.escape(openId)}"]`);
    const detail = target?.querySelector<HTMLElement>(".connection-detail");
    if (!target || !detail) return;
    // The first row in "Needs you" leaves the page at its top, so the group's heading and the Reader stay in view;
    // any other row comes to the top of the page.
    if (target.matches("[data-group=needs_you] .connection-row:first-child")) document.querySelector(".page")?.scrollTo({ top: 0 });
    else target.scrollIntoView({ block: "start" });
    // The secret to type again, else the repair form's first field, else the first control inside the opened row; it is
    // brought into view too, in case the row's own details push it below the window.
    const field = detail.querySelector<HTMLElement>("input[type=password]") ?? detail.querySelector<HTMLElement>("input[type=text], input:not([type]), select");
    const control = field ?? detail.querySelector<HTMLElement>("button:not(:disabled)");
    control?.focus({ preventScroll: true });
    control?.scrollIntoView({ block: "nearest" });
  }, [openId, ready]);
}

function ColumnHeads({ group, titleId }: { group: PageGroup; titleId: string }) {
  const last = group.id === "harnesses" || group.id === "model" ? "Last answered" : "Last read";
  return (
    <div className="connection-head">
      <h2 id={titleId} className="heading-section">
        {group.title}
      </h2>
      {group.rows.length > 0 && (
        <>
          <span className="connection-col" aria-hidden="true">
            {ACCOUNT_HEADING[group.id]}
          </span>
          <span className="connection-col" aria-hidden="true">
            May read and write
          </span>
          <span className="connection-col" aria-hidden="true">
            {last}
          </span>
        </>
      )}
    </div>
  );
}

/** A path breaks after its slashes, not inside a folder's name. */
function BreakAtSlashes({ text }: { text: string }) {
  const parts = text.split("/");
  return (
    <>
      {parts.map((part, n) => (
        <span key={n}>
          {part}
          {n < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </span>
      ))}
    </>
  );
}

/** One set-up Connection: name and state, account, what it may read and write, and its last read, opening in place into its controls. */
function ConnectionRow({ row, definition, open, onToggle, repair, accountHeading, onChanged, testResult }: { row: PageRow; definition: ConnectionDefinition; open: boolean; onToggle: () => void; repair: boolean; accountHeading: string; onChanged: () => void; testResult: TestResult }) {
  const c = row.connection;
  const cells = rowCells(c, definition);
  const detailId = useId();
  return (
    <li className="connection-row" data-connection={c.id} data-state={row.problem?.state ?? "works"} data-open={open || undefined}>
      <div className="connection-line">
        <div className="connection-name">
          <h3>
            <button type="button" className="connection-toggle" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
              <Icon name="chevron" size={16} className="connection-chevron" />
              {c.label}
            </button>
          </h3>
          {row.problem && (
            <span className={`connection-state ${hueClass(row.problem.hue)}`} data-connection-state={row.problem.state}>
              <Icon name={row.problem.icon} size={16} />
              {row.problem.word}
            </span>
          )}
        </div>
        <p className="connection-account">
          <span className="connection-label">{accountHeading}: </span>
          {cells.account ? <BreakAtSlashes text={cells.account} /> : <span className="muted">None</span>}
        </p>
        <p className="connection-permission">
          <span>
            <span className="connection-verb">Reads</span> {cells.reads}
          </span>
          <span>
            <span className="connection-verb">Writes</span> {cells.writes}
          </span>
        </p>
        <p className="connection-last">
          <span className="connection-label">{cells.last.label} </span>
          {cells.last.at ? <Time iso={cells.last.at} standalone /> : <span className="muted">Never</span>}
        </p>
      </div>
      <div id={detailId} className="connection-detail stack" hidden={!open}>
        {open && (
          <>
            <p className="small muted">{connectionDescription(c, definition)}</p>
            <ConnectionControls status={c} definition={definition} onChanged={onChanged} repair={repair} inRow testResult={testResult} />
          </>
        )}
      </div>
    </li>
  );
}

/** A Connection that is not set up: a small tile that opens in place, across the group, into its setup form. */
function ConnectionTile({ status, definition, open, onToggle, onChanged, testResult }: { status: ConnectionStatus; definition: ConnectionDefinition; open: boolean; onToggle: () => void; onChanged: () => void; testResult: TestResult }) {
  const detailId = useId();
  return (
    <li className="connection-tile" data-connection={status.id} data-open={open || undefined}>
      <button type="button" className="connection-tile-button" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
        <span className="connection-tile-name">{status.label}</span>
        <span className="connection-tile-meta">{status.status === "disconnected" ? "Disconnected" : "Not set up"}</span>
        <Icon name="chevron" size={16} className="connection-chevron" />
      </button>
      <div id={detailId} className="connection-detail stack" hidden={!open}>
        {open && (
          <>
            <p className="small muted">{connectionDescription(status, definition)}</p>
            <ConnectionControls status={status} definition={definition} onChanged={onChanged} inRow testResult={testResult} />
          </>
        )}
      </div>
    </li>
  );
}

function Group({ group, caps, open, toggle, openId, onChanged, tests }: { group: PageGroup; caps: Caps; open: Set<string>; toggle: (id: string) => void; openId: string | null; onChanged: () => void; tests: TestResults }) {
  const titleId = useId();
  const definition = (c: ConnectionStatus) => caps.definitions.find((d) => d.kind === c.kind);
  const importOpen = open.has(IMPORT_ID);
  return (
    <section className="connection-group" aria-labelledby={titleId} data-group={group.id}>
      <ColumnHeads group={group} titleId={titleId} />
      {group.rows.length > 0 && (
        <ul className="connection-rows">
          {group.rows.map((row) => {
            const def = definition(row.connection);
            return def ? <ConnectionRow key={row.connection.id} row={row} definition={def} open={open.has(row.connection.id)} onToggle={() => toggle(row.connection.id)} repair={group.id === "needs_you" || row.connection.id === openId} accountHeading={ACCOUNT_HEADING[group.id]} onChanged={onChanged} testResult={tests.of(row.connection.id)} /> : null;
          })}
        </ul>
      )}
      {(group.tiles.length > 0 || group.id === "notes") && (
        <ul className="connection-tiles" aria-label={`${group.title} not set up`}>
          {group.tiles.map((t) => {
            const def = definition(t);
            return def ? <ConnectionTile key={t.id} status={t} definition={def} open={open.has(t.id)} onToggle={() => toggle(t.id)} onChanged={onChanged} testResult={tests.of(t.id)} /> : null;
          })}
          {group.id === "notes" && <ImportFolder open={importOpen} onToggle={() => toggle(IMPORT_ID)} onDone={onChanged} />}
        </ul>
      )}
    </section>
  );
}

/** The import tile's place in the open set: no Connection has this id. */
const IMPORT_ID = "import-folder";

export function ConnectionsView() {
  // Every job event too: a running Source refresh changes what a row says about its last read.
  const caps = useResource<Caps>("/capabilities", ["connections.changed", "config.changed", "job"]);
  const loc = useLocation();
  const oauth = loc.search.get("oauth");
  const openId = loc.search.get("open");
  const d = caps.data;
  const attentionOn = d?.features.find((f) => f.id === "attention")?.enabled ?? false;
  const groups = useMemo(() => (d ? connectionsPage(d.connections, attentionOn) : null), [d, attentionOn]);
  const { open, toggle } = useOpenRows(groups, openId);
  const tests = useTestResults();
  useArrival(openId, open.size > 0);
  return (
    <div className="page page-connections">
      <div className="page-header">
        <h1>Connections</h1>
      </div>
      <ReaderLine />
      <p className="connections-lede">What each Connection may read and write, and when Attache last read it. Open a row for its last Source refresh and controls.</p>
      {oauth && (
        <div className={`state ${oauth === "ok" ? "partial" : "error"} small connections-oauth`} role="status">
          {loc.search.get("message")}
        </div>
      )}
      {caps.loading && !d && <Loading lines={6} />}
      <ErrorState error={caps.error} retry={caps.reload} />
      {d && groups && (
        <div className="connection-groups">
          {groups.map((g) => (
            <Group key={g.id} group={g} caps={d} open={open} toggle={toggle} openId={openId} onChanged={caps.reload} tests={tests} />
          ))}
        </div>
      )}
    </div>
  );
}

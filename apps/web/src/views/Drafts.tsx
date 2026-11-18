import { useEffect, useState } from "react";
import { approvalEndedAt, FINISHED_ACTION_STATUSES, OPEN_ACTION_STATUSES, plural, type ActionView, type Citation } from "@attache/contracts";
import { post, put } from "../api.ts";
import { useResource } from "../live.ts";
import { Empty, ErrorState, Link, Loading, navigate, Time, useAction, useLocation } from "../components/ui.tsx";
import { StateTag } from "../components/StateTag.tsx";
import { useRevealDetail } from "../components/reveal-detail.ts";
import { useOpenEvidence } from "../components/Evidence.tsx";
import { Tabs, type TabItem } from "../components/Tabs.tsx";

const BODY_KEY: Record<string, string> = { "slack.post": "text" };
const KIND_LABEL: Record<string, string> = { "github.comment": "GitHub comment", "jira.comment": "Jira comment", "confluence.comment": "Confluence comment", "slack.post": "Slack message", "gmail.draft": "Gmail draft" };

function DraftDetail({ id }: { id: string }) {
  const a = useResource<ActionView>(`/actions/${id}`, ["actions.changed"]);
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();
  const open = useOpenEvidence();
  const d = a.data;
  const key = d ? (BODY_KEY[d.kind] ?? "body") : "body";
  useEffect(() => {
    if (d && !dirty) setBody(String(d.payload[key] ?? ""));
  }, [d, dirty, key]);
  if (a.loading && !d) return <Loading lines={6} />;
  if (a.error) return <ErrorState error={a.error} retry={a.reload} />;
  if (!d) return null;
  const endedAt = approvalEndedAt(d);
  const editable = ["draft", "approved", "revoked", "rejected"].includes(d.status) && d.expiresAt > new Date().toISOString();
  const ctx = d.context as { item?: { title: string; summary: string; url: string | null }; source?: Record<string, unknown>; fetched?: { changedFiles?: Array<{ file: string; additions: number; deletions: number }> }; related?: Citation[]; preparedBy?: string | null; preparedAt?: string };
  const save = () =>
    run("save", async () => {
      await put(`/actions/${d.id}`, { payload: { ...d.payload, [key]: body }, expectedVersion: d.version });
      setDirty(false);
      a.reload();
    }, "Saved as a new version. Any earlier approval no longer applies.");
  return (
    <div className="stack" data-action-id={d.id} data-status={d.status}>
      <div className="row">
        <h2 style={{ flex: 1 }}>{d.title}</h2>
        <StateTag state={d.status} />
      </div>
      <dl className="kv">
        <dt>Action</dt>
        <dd>{KIND_LABEL[d.kind] ?? d.kind}</dd>
        <dt>Target</dt>
        <dd className="mono">{typeof d.target.url === "string" ? <a href={d.target.url} target="_blank" rel="noopener noreferrer">{d.target.url}</a> : JSON.stringify(d.target)}</dd>
        <dt>Version</dt>
        <dd>
          v{d.version} · <span className="mono">{d.payloadHash.slice(0, 12)}</span>
        </dd>
        <dt>Expires</dt>
        <dd>
          {new Date(d.expiresAt).toLocaleString()} (<Time iso={d.expiresAt} />)
        </dd>
        {d.approval && (
          <>
            <dt>Approved</dt>
            <dd>
              v{d.approval.version} at {new Date(d.approval.approvedAt).toLocaleTimeString()}, valid until {new Date(d.approval.expiresAt).toLocaleTimeString()}
            </dd>
          </>
        )}
        {ctx.preparedBy && (
          <>
            <dt>Prepared by</dt>
            <dd>{ctx.preparedBy}</dd>
          </>
        )}
      </dl>

      {ctx.item && (
        <div className="card stack-sm">
          <h3>Context</h3>
          <p className="small">{ctx.item.summary}</p>
          {ctx.source && typeof ctx.source.body === "string" && ctx.source.body && <p className="small muted" style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{ctx.source.body}</p>}
          {ctx.fetched?.changedFiles?.length ? (
            <details>
              <summary className="small">{plural(ctx.fetched.changedFiles.length, "changed file")}</summary>
              <ul className="small mono" style={{ paddingLeft: 18 }}>
                {ctx.fetched.changedFiles.map((f) => (
                  <li key={f.file}>
                    {f.file} (+{f.additions} −{f.deletions})
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {ctx.related?.length ? (
            <div className="sources">
              {ctx.related.map((c) => (
                <button key={c.marker} className="source-chip" onClick={() => open({ root: c.root, relPath: c.relPath, lines: [c.startLine, c.endLine], title: c.title })}>
                  <span>{c.title}</span>
                  <span className="path">{c.relPath}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}

      <label className="field">
        {d.kind === "slack.post" ? "Message" : "Text"}
        <textarea
          value={body}
          rows={8}
          disabled={!editable}
          onChange={(e) => {
            setBody(e.target.value);
            setDirty(true);
          }}
          placeholder={ctx.preparedBy ? "" : "No model prepared this draft. Write it here."}
        />
      </label>

      {!d.executable.ok && d.status === "approved" && d.executable.reason && (
        <div className="state partial small" role="status">
          <strong style={{ color: "var(--warn)" }}>Cannot send yet</strong>
          <span>{d.executable.reason}</span>
          {/authoris/i.test(d.executable.reason) && <Link to="/connections">Open Connections</Link>}
        </div>
      )}

      {endedAt && !dirty && (
        <p className="small muted" role="status">
          The approval of v{d.version} ended at {new Date(endedAt).toLocaleTimeString()}. Nothing was sent.
        </p>
      )}

      <div className="row">
        {dirty && (
          <button className="primary" disabled={busy !== null} onClick={save}>
            Save new version
          </button>
        )}
        {!dirty && (d.status === "draft" || d.status === "revoked") && (
          <button className="primary" disabled={busy !== null || !body.trim()} onClick={() => run("approve", () => post(`/actions/${d.id}/approve`, { version: d.version, payloadHash: d.payloadHash }).then(a.reload), `Approved version ${d.version}`)}>
            Approve v{d.version}
            {endedAt ? " again" : ""}
          </button>
        )}
        {!dirty && d.status === "approved" && d.approval && (
          <button className="primary" disabled={busy !== null || !d.executable.ok} onClick={() => run("exec", () => post(`/actions/${d.id}/execute`, { nonce: d.approval!.nonce, version: d.version, payloadHash: d.payloadHash }).then(a.reload), "Sending. The result appears when the service verifies it.")}>
            {KIND_LABEL[d.kind]?.includes("draft") ? "Create in Gmail" : "Send"}
          </button>
        )}
        {d.status === "approved" && (
          <button disabled={busy !== null} onClick={() => run("revoke", () => post(`/actions/${d.id}/revoke`).then(a.reload), "Approval revoked")}>
            Revoke approval
          </button>
        )}
        {["draft", "approved", "revoked"].includes(d.status) && (
          <button className="ghost danger" disabled={busy !== null} onClick={() => run("reject", () => post(`/actions/${d.id}/reject`, {}).then(a.reload), "Rejected")}>
            Reject
          </button>
        )}
      </div>

      {d.status === "executing" && <p className="small muted">Sending… Attache marks this sent only after the service confirms the result.</p>}
      {d.receipt && (
        <div className={`card small stack-sm`} data-receipt>
          <h3>Receipt</h3>
          {d.status === "succeeded" ? (
            <p>
              Verified {d.receipt.verifiedAt ? new Date(String(d.receipt.verifiedAt)).toLocaleString() : ""}. Remote id <span className="mono">{String(d.receipt.remoteId ?? "")}</span>
              {typeof d.receipt.url === "string" && (
                <>
                  {" "}
                  · <a href={d.receipt.url} target="_blank" rel="noopener noreferrer">open</a>
                </>
              )}
            </p>
          ) : (
            <p className={d.status === "failed" ? "error-text" : ""}>{String(d.receipt.error ?? (d.status === "unknown" ? "The outcome could not be verified. Check the target before retrying." : ""))}</p>
          )}
        </div>
      )}

      <div className="card">
        <h3>History</h3>
        <ul className="timeline" style={{ marginTop: 6 }}>
          {d.events.map((e, i) => (
            <li key={i}>
              <Time iso={e.at} />
              <span>
                {e.event.replace(/_/g, " ")} <span className="muted">by {e.actor}</span>
                {e.data && typeof e.data === "object" && "message" in (e.data as Record<string, unknown>) ? <span className="muted"> — {String((e.data as Record<string, unknown>).message)}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

type Filter = "open" | "done" | "all";
const FILTERS: ReadonlyArray<TabItem<Filter>> = [
  { id: "open", label: "Needs review" },
  { id: "done", label: "Finished" },
  { id: "all", label: "All" },
];

export function DraftsView() {
  const loc = useLocation();
  const [filter, setFilter] = useState<Filter>("open");
  const statuses = filter === "open" ? OPEN_ACTION_STATUSES.join(",") : filter === "done" ? FINISHED_ACTION_STATUSES.join(",") : "";
  const list = useResource<ActionView[]>(`/actions${statuses ? `?status=${statuses}` : ""}`, ["actions.changed", "job"]);
  const selected = loc.search.get("id");
  const { detailRef, revealDetail } = useRevealDetail();
  useEffect(() => {
    if (!selected && list.data?.[0]) navigate(`/drafts?id=${list.data[0].id}`, { replace: true });
  }, [list.data, selected]);
  return (
    <div className="page">
      <div className="page-header">
        <h1>Drafts and approvals</h1>
        <span className="subtitle">Nothing is sent until you approve a specific version. Edits invalidate earlier approvals.</span>
      </div>
      <div className="split">
        <div className="stack">
          <Tabs label="Drafts to show" tabs={FILTERS} selected={filter} onSelect={setFilter} />
          {list.loading && !list.data && <Loading />}
          <ErrorState error={list.error} retry={list.reload} />
          {list.data?.length === 0 && <Empty title="No drafts">Use “Prepare draft” on an Inbox item. Drafts appear here with their context.</Empty>}
          <div className="list">
            {list.data?.map((d) => (
              <button key={d.id} className="list-item" aria-current={d.id === selected} onClick={() => { navigate(`/drafts?id=${d.id}`); revealDetail(); }}>
                <div className="stack-sm" style={{ minWidth: 0, flex: 1 }}>
                  <strong>{d.title}</strong>
                  <span className="row small muted">
                    <StateTag state={d.status} /> {KIND_LABEL[d.kind] ?? d.kind} · <Time iso={d.updatedAt} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div ref={detailRef} className="split-detail">{selected ? <DraftDetail id={selected} /> : <Empty title="Select a draft" />}</div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { plural, type ConnectionDefinition, type ConnectionStatus, type Coverage, type DisconnectEffects } from "@attache/contracts";
import { api, post, put } from "../api.ts";
import { MarkdownInline, Time, useAction } from "./ui.tsx";
import { StateTag } from "./StateTag.tsx";
import { reconfigureSignIn, reconnectMethod, startBrowserSignIn } from "../reconnect.ts";

const COVERAGE_TEXT: Record<string, string> = {
  complete: "Complete",
  empty: "Complete — nothing found",
  partial: "Partial — some items may be missing",
  denied: "Access denied for a scope",
  unauthorized: "Sign-in expired or rejected",
  offline: "Service unreachable",
  error: "Failed",
  not_configured: "Not configured",
  never_run: "Never refreshed",
};

export function CoverageDetail({ coverage }: { coverage: Coverage | null }) {
  if (!coverage) return <p className="small muted">Not refreshed yet.</p>;
  return (
    <div className="stack-sm">
      <div className="row small">
        <StateTag state={coverage.state} label={COVERAGE_TEXT[coverage.state] ?? coverage.state} />
        <span className="muted">
          {coverage.items} item{coverage.items === 1 ? "" : "s"} · <Time iso={coverage.at} />
        </span>
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)" }}>
        {coverage.scopes.map((s, i) => (
          <li key={i}>
            {s.scope}: <b>{s.state.replace(/_/g, " ")}</b> ({s.items} item{s.items === 1 ? "" : "s"}, {s.pages} page{s.pages === 1 ? "" : "s"}){s.note ? <span className="muted"> — {s.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Props {
  status: ConnectionStatus;
  definition: ConnectionDefinition;
  onChanged: () => void;
  compact?: boolean;
  /** Opened from a link that asks for repair: a sign-in that needs new secrets, or a refused read, starts with its form open. */
  repair?: boolean;
}

export function ConnectionCard({ status, definition, onChanged, compact, repair = false }: Props) {
  const { busy, run } = useAction();
  const configured = status.status !== "not_configured" && status.status !== "disconnected";
  const needsForm = repair && configured && ((status.status === "needs_auth" && reconnectMethod(status, definition) === "credentials") || status.coverage?.state === "denied" || !!status.coverage?.scopes.some((s) => s.state === "denied"));
  const [editing, setEditing] = useState((!configured && !compact) || needsForm);
  const [method, setMethod] = useState(definition.authMethods.some((a) => a.id === status.authMethod) ? status.authMethod : (definition.authMethods[0]?.id ?? ""));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [scopes, setScopes] = useState<string[]>(configured ? status.readScopes : definition.scopes.filter((s) => s.default).map((s) => s.id));
  const [preview, setPreview] = useState<DisconnectEffects | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const m = definition.authMethods.find((x) => x.id === method) ?? definition.authMethods[0];
  // Browser sign-in follows the method being edited, or the method the connection was saved with.
  const current = definition.authMethods.find((a) => a.id === status.authMethod);
  const isOAuth = editing ? !!m?.browserSignIn : !!current?.browserSignIn;
  const signInWith = ((editing ? m : current)?.label ?? "Sign in").replace(/\s*\(.*\)$/, "");
  const builtin = status.settings.builtin === true;

  const configure = () =>
    run(
      "configure",
      async () => {
        const r = await post<{ test: { ok: boolean; message: string } }>(`/connections/${status.kind}/configure`, { method, fields, readScopes: definition.scopes.length ? scopes : undefined });
        // Before browser sign-in there is no test result to show; the toast says what to do next.
        setTestMsg(isOAuth && !r.test.ok ? null : r.test.message);
        setFields({});
        setEditing(false);
        onChanged();
        return r;
      },
      isOAuth ? `Saved. Now ${signInWith.charAt(0).toLowerCase()}${signInWith.slice(1)}.` : undefined,
    );

  const signIn = (includeWrite = false) =>
    run("oauth", () => startBrowserSignIn(status.kind, includeWrite));

  // Methods with secrets need new ones; claude.ai-style methods only need the outside sign-in fixed and a fresh test.
  const reconnect = () => {
    const how = reconnectMethod(status, definition);
    if (current && how === "credentials") {
      setMethod(current.id);
      setEditing(true);
      return;
    }
    if (how === "reconfigure") {
      void run("reconnect", () => reconfigureSignIn(status).finally(onChanged), "Reconnected");
      return;
    }
    void run("reconnect", async () => {
      const r = await post<{ test: { ok: boolean; message: string } }>(`/connections/${status.id}/test`);
      setTestMsg(r.test.message);
      onChanged();
      if (!r.test.ok) throw new Error(`Still not signed in: ${r.test.message}`);
    }, "Reconnected");
  };

  return (
    <div className="card stack" data-connection={status.id}>
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{status.label}</h3>
          <p className="small muted">{builtin ? "Where Attache keeps your memory, evidence and deliverables as Markdown. Attache reads and writes here; your edits are picked up on the next refresh." : definition.description}</p>
        </div>
        <StateTag state={status.status} label={status.status === "not_configured" ? "not connected" : status.status.replace(/_/g, " ")} />
      </div>

      {configured && (
        <dl className="kv">
          <dt>Account</dt>
          <dd>{status.account ?? "—"}</dd>
          <dt>Last success</dt>
          <dd>
            <Time iso={status.lastSuccessAt} standalone />
          </dd>
          {status.lastError && (
            <>
              <dt>Last error</dt>
              <dd className="error-text">{status.lastError}</dd>
            </>
          )}
          {definition.scopes.length > 0 && (
            <>
              <dt>Reading</dt>
              <dd>{status.readScopes.map((s) => definition.scopes.find((d) => d.id === s)?.label ?? s).join(", ") || "nothing selected"}</dd>
            </>
          )}
          {definition.writeActions.length > 0 && (
            <>
              <dt>May write</dt>
              <dd>{status.writeActions.length ? status.writeActions.map((a) => definition.writeActions.find((d) => d.id === a)?.label ?? a).join(", ") : "Nothing (read-only)"}</dd>
            </>
          )}
        </dl>
      )}
      {configured && !compact && definition.scopes.length > 0 && <CoverageDetail coverage={status.coverage} />}
      {testMsg && <p className="small muted">Test: {testMsg}</p>}

      {editing && (
        <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          {definition.unavoidableSteps.length > 0 && (
            <div className="state partial small">
              <strong style={{ color: "var(--warn)" }}>Before you connect</strong>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {definition.unavoidableSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="small muted">{definition.setupHelp}</p>
          {definition.authMethods.length > 1 && (
            <label className="field">
              How to connect
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {definition.authMethods.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {m?.fields.map((f) => (
            <label key={f.id} className="field">
              {f.label}
              {f.optional ? <span className="help">optional</span> : null}
              {f.id === "stt" || f.id === "tts" ? (
                <select value={fields[f.id] ?? ""} onChange={(e) => setFields({ ...fields, [f.id]: e.target.value })}>
                  <option value="">Default</option>
                  {(f.placeholder ?? "").split("|").map((o) => o.trim()).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input type={f.secret ? "password" : "text"} value={fields[f.id] ?? ""} placeholder={f.placeholder} autoComplete="off" spellCheck={false} onChange={(e) => setFields({ ...fields, [f.id]: e.target.value })} />
              )}
              {f.help && <MarkdownInline className="help" text={f.help} />}
            </label>
          ))}
          {definition.scopes.length > 0 && (
            <fieldset className="stack-sm" style={{ border: "none", padding: 0, margin: 0 }}>
              <legend className="small" style={{ fontWeight: 560, color: "var(--text-2)", marginBottom: 4 }}>
                What Attache may read
              </legend>
              {definition.scopes.map((s) => (
                <label key={s.id} className="check small">
                  <input type="checkbox" checked={scopes.includes(s.id)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))} />
                  {s.label}
                </label>
              ))}
            </fieldset>
          )}
          <div className="row">
            <button className="primary" disabled={busy !== null} onClick={configure}>
              {busy === "configure" ? "Connecting…" : configured ? "Save and test" : "Connect"}
            </button>
            {(configured || compact) && (
              <button className="ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {!isOAuth && configured && status.status === "needs_auth" && !editing && (
        <div className="state partial small" role="status" aria-label="Sign-in needed">
          <strong style={{ color: "var(--warn)" }}>Sign-in needed</strong>
          <MarkdownInline text={current?.reconnectHelp ?? `Enter new credentials for ${status.label} to reconnect.`} />
          <div className="row">
            <button className="primary" disabled={busy !== null} onClick={reconnect}>
              {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
            </button>
          </div>
        </div>
      )}

      {isOAuth && status.status === "needs_auth" && !editing && (
        <div className="row">
          <button className="primary" disabled={busy !== null} onClick={() => signIn(false)}>
            {signInWith} (read-only)
          </button>
        </div>
      )}

      {!editing && (
        <div className="row">
          {!configured && (
            <button onClick={() => setEditing(true)} className={compact ? "" : "primary"}>
              Set up
            </button>
          )}
          {configured && (
            <>
              <button disabled={busy !== null} onClick={() => run("test", async () => { const r = await post<{ test: { message: string } }>(`/connections/${status.id}/test`); setTestMsg(r.test.message); onChanged(); })}>
                {busy === "test" ? "Testing…" : "Test"}
              </button>
              {definition.scopes.length > 0 && status.kind !== "model" && status.status !== "needs_auth" && (
                <button disabled={busy !== null} onClick={() => run("refresh", () => post(`/connections/${status.id}/refresh`).then(onChanged), "Refresh started")}>
                  Refresh now
                </button>
              )}
              {!builtin && (
                <>
                  <button className="ghost" onClick={() => setEditing(true)}>
                    Reconfigure
                  </button>
                  <button className="ghost danger" onClick={() => run("preview", async () => setPreview(await api<DisconnectEffects>(`/connections/${status.id}/disconnect-preview`)))}>
                    Disconnect…
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {configured && !compact && definition.scopes.length > 0 && !editing && (
        <details>
          <summary className="small">Change what Attache reads</summary>
          <div className="stack-sm" style={{ marginTop: 8 }}>
            {definition.scopes.map((s) => (
              <label key={s.id} className="check small">
                <input type="checkbox" checked={scopes.includes(s.id)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))} />
                {s.label}
              </label>
            ))}
            <div>
              <button className="small" onClick={() => run("scopes", () => put(`/connections/${status.id}/scopes`, { readScopes: scopes }).then(onChanged), "Scopes saved")}>
                Save scopes
              </button>
            </div>
          </div>
        </details>
      )}

      {configured && !compact && definition.writeActions.length > 0 && <WriteAuthority status={status} definition={definition} onChanged={onChanged} onSignIn={isOAuth ? () => signIn(true) : undefined} signInWith={signInWith} />}

      {preview && (
        <div className="state error small" role="alertdialog" aria-label="Disconnect">
          <strong>Disconnect {status.label}?</strong>
          <span>
            {preview.credentials > 0 ? "Attache deletes the stored credentials and stops all requests." : "Attache stops reading from it."} {plural(preview.queuedJobs, "queued job")} will be cancelled and approvals for {plural(preview.drafts, "draft")} revoked.
          </span>
          <span>
            Retained data: {plural(preview.observations, "observation")}, {plural(preview.attentionItems, "open Inbox item")}{preview.indexedDocuments ? `, ${plural(preview.indexedDocuments, "indexed file")}` : ""}.
          </span>
          <div className="row">
            <button className="danger" onClick={() => run("disc", () => post(`/connections/${status.id}/disconnect`, { deleteData: false }).then(() => { setPreview(null); onChanged(); }), "Disconnected; data kept")}>
              Disconnect, keep data
            </button>
            <button className="danger" onClick={() => run("disc", () => post(`/connections/${status.id}/disconnect`, { deleteData: true }).then(() => { setPreview(null); onChanged(); }), "Disconnected; data deleted")}>
              Disconnect and delete data
            </button>
            <button className="ghost" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WriteAuthority({ status, definition, onChanged, onSignIn, signInWith }: { status: ConnectionStatus; definition: ConnectionDefinition; onChanged: () => void; onSignIn: (() => void) | undefined; signInWith: string }) {
  const { run } = useAction();
  const [sel, setSel] = useState<string[]>(status.writeActions);
  const [confirm, setConfirm] = useState(false);
  const changed = sel.slice().sort().join() !== status.writeActions.slice().sort().join();
  return (
    <details>
      <summary className="small">Write permissions ({status.writeActions.length ? "enabled" : "read-only"})</summary>
      <div className="stack-sm" style={{ marginTop: 8 }}>
        <p className="small muted">Writing is authorised separately from reading. Even when allowed, nothing is sent until you approve a specific draft version.</p>
        {definition.writeActions.map((a) => (
          <label key={a.id} className="check small">
            <input type="checkbox" checked={sel.includes(a.id)} onChange={(e) => setSel(e.target.checked ? [...sel, a.id] : sel.filter((x) => x !== a.id))} />
            {a.label}
          </label>
        ))}
        {onSignIn && sel.length > 0 && (
          <p className="small muted">
            Writing needs an extra permission from the provider. <button className="small" onClick={onSignIn}>{signInWith} again to grant write access</button>
          </p>
        )}
        {changed && (
          <label className="check small">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />I understand Attache may perform these actions after I approve each one.
          </label>
        )}
        <div>
          <button className="small" disabled={!changed || (sel.length > 0 && !confirm)} onClick={() => run("write", () => put(`/connections/${status.id}/write-actions`, { writeActions: sel, confirm: true }).then(onChanged), "Write permissions saved")}>
            Save write permissions
          </button>
        </div>
      </div>
    </details>
  );
}

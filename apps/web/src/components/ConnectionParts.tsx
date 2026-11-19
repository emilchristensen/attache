import { useState } from "react";
import { plural, type ConnectionDefinition, type ConnectionStatus, type Coverage, type DisconnectEffects } from "@attache/contracts";
import { put } from "../api.ts";
import { MarkdownInline, Time, useAction } from "./ui.tsx";
import { StateTag } from "./StateTag.tsx";

/**
 * The parts `ConnectionControls` (ConnectionCard.tsx) draws: what is known of a Connection, its last Source refresh,
 * the setup form, what it may read and write, and the disconnect confirmation. The controls own the Connection's
 * state and pass it in.
 */

const COVERAGE_TEXT: Record<string, string> = {
  complete: "Complete",
  empty: "Complete, nothing found",
  partial: "Partial: some items may be missing",
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
            {s.scope}: <b>{s.state.replace(/_/g, " ")}</b> ({s.items} item{s.items === 1 ? "" : "s"}, {s.pages} page{s.pages === 1 ? "" : "s"}){s.note ? <span className="muted">: {s.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Account, last success, last error and, outside a Connections row (which has its own columns), what it reads and may write. */
export function ConnectionFacts({ status, definition, inRow }: { status: ConnectionStatus; definition: ConnectionDefinition; inRow: boolean }) {
  return (
    <dl className="kv">
      {!inRow && (
        <>
          <dt>Account</dt>
          <dd>{status.account ?? "Not known"}</dd>
        </>
      )}
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
      {!inRow && definition.scopes.length > 0 && (
        <>
          <dt>Reading</dt>
          <dd>{status.readScopes.map((s) => definition.scopes.find((d) => d.id === s)?.label ?? s).join(", ") || "nothing selected"}</dd>
        </>
      )}
      {!inRow && definition.writeActions.length > 0 && (
        <>
          <dt>May write</dt>
          <dd>{status.writeActions.length ? status.writeActions.map((a) => definition.writeActions.find((d) => d.id === a)?.label ?? a).join(", ") : "Nothing (read-only)"}</dd>
        </>
      )}
    </dl>
  );
}

/** One checkbox per scope the Connection can read: the setup form's and "Change what Attache reads". */
export function ScopeChecks({ definition, scopes, onScopes }: { definition: ConnectionDefinition; scopes: readonly string[]; onScopes: (scopes: string[]) => void }) {
  return (
    <>
      {definition.scopes.map((s) => (
        <label key={s.id} className="check small">
          <input type="checkbox" checked={scopes.includes(s.id)} onChange={(e) => onScopes(e.target.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))} />
          {s.label}
        </label>
      ))}
    </>
  );
}

interface SetupFormProps {
  definition: ConnectionDefinition;
  /** The sign-in method being edited. */
  method: ConnectionDefinition["authMethods"][number] | undefined;
  onMethod: (id: string) => void;
  fields: Record<string, string>;
  onFields: (fields: Record<string, string>) => void;
  scopes: readonly string[];
  onScopes: (scopes: string[]) => void;
  submit: { label: string; disabled: boolean; run: () => void };
  /** Null when there is nothing to go back to: a Connection set up for the first time. */
  onCancel: (() => void) | null;
}

/** Setting a Connection up, or again: the steps outside Attache, the method, its fields and what Attache may read. */
export function SetupForm({ definition, method, onMethod, fields, onFields, scopes, onScopes, submit, onCancel }: SetupFormProps) {
  return (
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
          <select value={method?.id ?? ""} onChange={(e) => onMethod(e.target.value)}>
            {definition.authMethods.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {method?.fields.map((f) => (
        <label key={f.id} className="field">
          {f.label}
          {f.optional ? <span className="help">optional</span> : null}
          {f.id === "stt" || f.id === "tts" ? (
            <select value={fields[f.id] ?? ""} onChange={(e) => onFields({ ...fields, [f.id]: e.target.value })}>
              <option value="">Default</option>
              {(f.placeholder ?? "").split("|").map((o) => o.trim()).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input type={f.secret ? "password" : "text"} value={fields[f.id] ?? ""} placeholder={f.placeholder} autoComplete="off" spellCheck={false} onChange={(e) => onFields({ ...fields, [f.id]: e.target.value })} />
          )}
          {f.help && <MarkdownInline className="help" text={f.help} />}
        </label>
      ))}
      {definition.scopes.length > 0 && (
        <fieldset className="stack-sm" style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="small" style={{ fontWeight: 560, color: "var(--text-2)", marginBottom: 4 }}>
            What Attache may read
          </legend>
          <ScopeChecks definition={definition} scopes={scopes} onScopes={onScopes} />
        </fieldset>
      )}
      <div className="row">
        <button className="primary" disabled={submit.disabled} onClick={submit.run}>
          {submit.label}
        </button>
        {onCancel && (
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/** What disconnecting stops, cancels and keeps, with both ways to disconnect and Cancel. */
export function DisconnectConfirm({ status, preview, disconnect, onCancel }: { status: ConnectionStatus; preview: DisconnectEffects; disconnect: (deleteData: boolean) => void; onCancel: () => void }) {
  return (
    <div className="state error small" role="alertdialog" aria-label="Disconnect">
      <strong>Disconnect {status.label}?</strong>
      <span>
        {preview.credentials > 0 ? "Attache deletes the stored credentials and stops all requests." : "Attache stops reading from it."} {plural(preview.queuedJobs, "queued job")} will be cancelled and approvals for {plural(preview.drafts, "draft")} revoked.
      </span>
      <span>
        Retained data: {plural(preview.observations, "observation")}, {plural(preview.attentionItems, "open Inbox item")}{preview.indexedDocuments ? `, ${plural(preview.indexedDocuments, "indexed file")}` : ""}.
      </span>
      <div className="row">
        <button className="danger" onClick={() => disconnect(false)}>
          Disconnect, keep data
        </button>
        <button className="danger" onClick={() => disconnect(true)}>
          Disconnect and delete data
        </button>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function WriteAuthority({ status, definition, onChanged, onSignIn, signInWith }: { status: ConnectionStatus; definition: ConnectionDefinition; onChanged: () => void; onSignIn: (() => void) | undefined; signInWith: string }) {
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

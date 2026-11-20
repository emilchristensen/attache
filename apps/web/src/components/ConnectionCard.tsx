import { useState } from "react";
import { type ConnectionDefinition, type ConnectionStatus, type DisconnectEffects } from "@attache/contracts";
import { api, post, put } from "../api.ts";
import { MarkdownInline, useAction } from "./ui.tsx";
import { StateTag } from "./StateTag.tsx";
import { reconfigureSignIn, reconnectMethod, savedFields, startBrowserSignIn } from "../reconnect.ts";
import { ConnectionFacts, CoverageDetail, DisconnectConfirm, ScopeChecks, SetupForm, WriteAuthority } from "./ConnectionParts.tsx";


interface Props {
  status: ConnectionStatus;
  definition: ConnectionDefinition;
  onChanged: () => void;
  compact?: boolean;
  /** Opened from a link that asks for repair: a sign-in that needs new secrets, or a refused read, starts with its form open. */
  repair?: boolean;
}

/** What a Connection is for, in one sentence: the data folder says what Attache keeps there. */
export function connectionDescription(status: ConnectionStatus, definition: ConnectionDefinition): string {
  return status.settings.builtin === true ? "Where this Machine keeps its copy of your Brain (curated notes, evidence and deliverables) as Markdown. Attache reads and writes here; your edits are picked up on the next refresh." : definition.description;
}

/** One Connection as a card with its name, description and state above its controls: Setup's Connections and Model steps. */
export function ConnectionCard(props: Props) {
  const { status, definition } = props;
  return (
    <div className="card stack" data-connection={status.id}>
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{status.label}</h3>
          <p className="small muted">{connectionDescription(status, definition)}</p>
        </div>
        <StateTag state={status.status} label={status.status === "not_configured" ? "not connected" : status.status.replace(/_/g, " ")} />
      </div>
      <ConnectionControls {...props} />
    </div>
  );
}

/**
 * Everything the owner can see and do for one Connection: its details, last Source refresh, setup form, sign-in,
   * Test, Refresh now, Reconfigure, Disable, what it reads and what it may write. `inRow`: the Connections page's
 * row already shows the account and what it reads and writes in its columns, so they are not repeated.
 */
/**
 * `testResult`: the Connections page keeps the last Test or connect result by Connection, since a row is drawn anew
 * when it moves between a tile, its group and "Needs you"; without it the controls keep their own.
 */
export function ConnectionControls({ status, definition, onChanged, compact, repair = false, inRow = false, testResult }: Props & { inRow?: boolean; testResult?: { message: string | null; set: (message: string | null) => void } }) {
  const { busy, run } = useAction();
  const configured = status.status !== "not_configured" && status.status !== "disconnected";
  const needsForm = repair && configured && ((status.status === "needs_auth" && reconnectMethod(status, definition) === "credentials") || status.coverage?.state === "denied" || !!status.coverage?.scopes.some((s) => s.state === "denied"));
  const [editing, setEditing] = useState((!configured && !compact) || needsForm);
  // The method the Connection was saved with, else the definition's first.
  const savedMethod = definition.authMethods.some((a) => a.id === status.authMethod) ? status.authMethod : (definition.authMethods[0]?.id ?? "");
  const [method, setMethod] = useState(savedMethod);
  // The saved non-secret fields of the method in use, so a new secret alone keeps the rest of what was saved.
  const savedFor = (id: string) => (configured ? savedFields(status, definition.authMethods.find((a) => a.id === id)) : {});
  const [fields, setFields] = useState<Record<string, string>>(() => savedFor(method));
  const [scopes, setScopes] = useState<string[]>(configured ? status.readScopes : definition.scopes.filter((s) => s.default).map((s) => s.id));
  const [preview, setPreview] = useState<DisconnectEffects | null>(null);
  const [ownTestMsg, setOwnTestMsg] = useState<string | null>(null);
  const testMsg = testResult ? testResult.message : ownTestMsg;
  const setTestMsg = testResult ? testResult.set : setOwnTestMsg;
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
      setFields(savedFor(current.id));
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
    <>
      {configured && <ConnectionFacts status={status} definition={definition} inRow={inRow} />}
      {configured && !compact && definition.scopes.length > 0 && <CoverageDetail coverage={status.coverage} />}
      {testMsg && <p className="small muted">Test: {testMsg}</p>}

      {editing && (
        <SetupForm
          definition={definition}
          method={m}
          onMethod={(id) => {
            setMethod(id);
            setFields(savedFor(id));
          }}
          fields={fields}
          onFields={setFields}
          scopes={scopes}
          onScopes={setScopes}
          submit={{ label: busy === "configure" ? "Connecting…" : configured ? "Save and test" : "Connect", disabled: busy !== null, run: configure }}
          onCancel={configured || compact ? () => setEditing(false) : null}
        />
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
                  <button className="ghost" onClick={() => { setMethod(savedMethod); setFields(savedFor(savedMethod)); setEditing(true); }}>
                    Reconfigure
                  </button>
                  <button className="ghost danger" onClick={() => run("preview", async () => setPreview(await api<DisconnectEffects>(`/connections/${status.id}/disconnect-preview`)))}>
                    Disable…
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
            <ScopeChecks definition={definition} scopes={scopes} onScopes={setScopes} />
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
        <DisconnectConfirm
          status={status}
          preview={preview}
          disconnect={(deleteData) =>
            run("disc", () => post(`/connections/${status.id}/disconnect`, { deleteData }).then(() => { setPreview(null); setTestMsg(null); onChanged(); }), deleteData ? "Disabled; data deleted" : "Disabled; data kept")
          }
          onCancel={() => setPreview(null)}
        />
      )}
    </>
  );
}


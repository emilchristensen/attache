import type { HarnessSettingView } from "@jarvis/contracts";
import { put } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Link, Loading, useAction } from "../components/ui.tsx";

/** One switch per connected Harness: on, its saves are written without the confirmation request, on this Machine only. */
export function AutoAccept() {
  const list = useResource<HarnessSettingView[]>("/harnesses", ["config.changed", "connections.changed"]);
  const { busy, run } = useAction();
  const toggle = (h: HarnessSettingView, on: boolean) =>
    void run(h.id, () => put(`/harnesses/${h.id}/auto-accept`, { autoAccept: on }).then(list.reload), on ? `${h.label} saves without asking on this Machine` : `${h.label} asks before every save`);
  return (
    <section className="card stack" aria-labelledby="auto-accept-title">
      <h3 id="auto-accept-title">Auto-accept saves</h3>
      <p className="small muted">
        A Harness asks you to confirm every save to your Brain. Switch on auto-accept for a Harness you trust and its saves are written without asking, on this Machine only. Your identity record is never changed this way, and every auto-accepted save is marked in Recent saves, where you can revert it.
      </p>
      {list.loading && !list.data && <Loading lines={1} />}
      <ErrorState error={list.error} retry={list.reload} />
      {list.data && list.data.length === 0 && (
        <p className="small muted">
          No Harness is connected. Connect one under <Link to="/connections">Connections</Link>.
        </p>
      )}
      {list.data && list.data.length > 0 && (
        <div>
          {list.data.map((h) => (
            <div key={h.id} className="feature-row" data-harness={h.id}>
              <input type="checkbox" id={`auto-accept-${h.id}`} checked={h.autoAccept} disabled={busy !== null} aria-describedby={`auto-accept-${h.id}-desc`} onChange={(e) => toggle(h, e.target.checked)} style={{ marginTop: 4, width: 16, height: 16, accentColor: "var(--accent-strong)" }} />
              <div style={{ flex: 1 }}>
                <label htmlFor={`auto-accept-${h.id}`} style={{ cursor: "pointer" }}>
                  <strong>{h.label}</strong>
                </label>
                <p className="desc" id={`auto-accept-${h.id}-desc`}>
                  {h.autoAccept ? "Saves without asking." : "Asks before every save."}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

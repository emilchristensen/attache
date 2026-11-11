// Names, routes, class names and types are code, not text the owner reads.
import { syncNow } from "./sync-client.ts";

type Kind = "sync" | "vault";

export function Good({ busy, kind }: { busy: boolean; kind: Kind }) {
  const route = "/api/v1/sync";
  const syncing = kind === "sync";
  return (
    <section className="sync primary" data-kind="sync" key="sync" id="sync-panel">
      <h3>Replication</h3>
      <p title="Source refresh">Source refresh reads new activity{syncing ? "." : ""}</p>
      <button type="button" onClick={() => syncNow(route)} disabled={busy}>
        Refresh now
      </button>
    </section>
  );
}

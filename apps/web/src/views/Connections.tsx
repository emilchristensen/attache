import { useState } from "react";
import { plural, type ConnectionDefinition, type ConnectionStatus, type FeatureStatus } from "@attache/contracts";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, useAction, useLocation } from "../components/ui.tsx";
import { ConnectionCard } from "../components/ConnectionCard.tsx";
import { useFolderExamples } from "../folder-examples.ts";

interface Caps {
  features: FeatureStatus[];
  connections: ConnectionStatus[];
  definitions: ConnectionDefinition[];
}

function ImportFolder({ onDone }: { onDone: () => void }) {
  const [path, setPath] = useState("");
  const examples = useFolderExamples();
  const [preview, setPreview] = useState<{ path: string; filesToRead: number; skippedCount: number; note: string } | null>(null);
  const { busy, run } = useAction();
  return (
    <div className="card stack-sm">
      <h3>Import a Markdown folder or Obsidian vault</h3>
      <p className="small muted">Read-only. Attache indexes and cites the files where they are and never changes them.</p>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input value={path} onChange={(e) => { setPath(e.target.value); setPreview(null); }} placeholder={examples.notes} aria-label="Folder path" spellCheck={false} />
        <button disabled={!path.trim() || busy !== null} onClick={() => run("pv", async () => setPreview(await post("/import/preview", { path })))}>
          Preview
        </button>
      </div>
      {preview && (
        <div className="state partial small">
          <strong style={{ color: "var(--text)" }}>Reads {plural(preview.filesToRead, "Markdown file")} · changes 0 files</strong>
          <span>{preview.note}</span>
          {preview.skippedCount > 0 && <span>{plural(preview.skippedCount, "item")} skipped (hidden folders, links or large files).</span>}
          <button className="small primary" disabled={busy !== null} onClick={() => run("imp", () => post("/import", { path: preview.path }).then(() => { setPreview(null); setPath(""); onDone(); }), "Import started")}>
            Import
          </button>
        </div>
      )}
    </div>
  );
}

export function ConnectionsView() {
  const caps = useResource<Caps>("/capabilities", ["connections.changed", "config.changed", "job"]);
  const loc = useLocation();
  const oauth = loc.search.get("oauth");
  const d = caps.data;
  const card = (s: ConnectionStatus) => {
    const def = d!.definitions.find((x) => x.kind === s.kind);
    return def ? <ConnectionCard key={s.id} status={s} definition={def} onChanged={caps.reload} /> : null;
  };
  return (
    <div className="page page-narrow">
      <div className="page-header">
        <h1>Connections</h1>
        <span className="subtitle">Each connection shows what it may read and write, when it last succeeded and how complete its last Source refresh was.</span>
      </div>
      {oauth && (
        <div className={`state ${oauth === "ok" ? "partial" : "error"} small`} role="status" style={{ marginBottom: 14 }}>
          {loc.search.get("message")}
        </div>
      )}
      {caps.loading && !d && <Loading lines={6} />}
      <ErrorState error={caps.error} retry={caps.reload} />
      {d && (
        <div className="stack">
          <h2>Notes</h2>
          {d.connections.filter((c) => c.kind === "vault").map(card)}
          <ImportFolder onDone={caps.reload} />
          <h2>Work sources</h2>
          {d.connections.filter((c) => ["github", "jira", "confluence", "slack", "gmail", "gcal"].includes(c.kind)).map(card)}
          <h2>Harnesses</h2>
          {d.connections.filter((c) => ["claude-code", "codex", "antigravity", "claude-desktop"].includes(c.kind)).map(card)}
          <h2>Model</h2>
          {d.connections.filter((c) => c.kind === "model").map(card)}
        </div>
      )}
    </div>
  );
}

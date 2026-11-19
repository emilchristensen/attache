import { useId, useState } from "react";
import { plural } from "@attache/contracts";
import { post } from "../api.ts";
import { useAction } from "../components/ui.tsx";
import { Icon } from "../components/icons.tsx";
import { useFolderExamples } from "../folder-examples.ts";

interface ImportPreview {
  path: string;
  filesToRead: number;
  skippedCount: number;
  note: string;
}

/** The Notes group's tile for importing a Markdown folder or Obsidian vault, read-only, opening in place into its form. */
export function ImportFolder({ open, onToggle, onDone }: { open: boolean; onToggle: () => void; onDone: () => void }) {
  const [path, setPath] = useState("");
  const examples = useFolderExamples();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const { busy, run } = useAction();
  const detailId = useId();
  return (
    <li className="connection-tile" data-import-folder data-open={open || undefined}>
      <button type="button" className="connection-tile-button" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
        <span className="connection-tile-name">Import a folder</span>
        <span className="connection-tile-meta">Markdown or Obsidian</span>
        <Icon name="chevron" size={16} className="connection-chevron" />
      </button>
      <div id={detailId} className="connection-detail stack-sm" hidden={!open}>
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
    </li>
  );
}

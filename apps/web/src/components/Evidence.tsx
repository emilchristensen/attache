import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useResource } from "../live.ts";
import { ErrorState, Link, Loading, Markdown, Time } from "./ui.tsx";
import { Tag } from "./Tag.tsx";
import { Tabs, type TabItem } from "./Tabs.tsx";

export interface EvidenceTarget {
  root: string;
  relPath: string;
  lines?: [number, number] | undefined;
  title?: string | undefined;
  marker?: string | undefined;
}

interface DocView {
  root: string;
  rootLabel: string;
  relPath: string;
  absPath: string;
  raw: string;
  title: string;
  area: string;
  docType: string | null;
  indexedAt: string | null;
  protected: boolean;
  frontmatter: Record<string, unknown>;
}

const EvidenceCtx = createContext<(t: EvidenceTarget) => void>(() => {});
export const useOpenEvidence = () => useContext(EvidenceCtx);

export function EvidenceProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<EvidenceTarget | null>(null);
  return (
    <EvidenceCtx.Provider value={setTarget}>
      {children}
      {target && <EvidenceDrawer target={target} onClose={() => setTarget(null)} />}
    </EvidenceCtx.Provider>
  );
}

export function SourceView({ raw, lines }: { raw: string; lines?: [number, number] | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const from = lines?.[0];
  const to = lines?.[1];
  useEffect(() => {
    const el = ref.current?.querySelector(".line.hl");
    el?.scrollIntoView({ block: "center" });
  }, [raw, from, to]);
  const all = raw.split("\n");
  return (
    <div className="source-view" ref={ref} aria-label="File contents with line numbers">
      {all.map((l, i) => {
        const n = i + 1;
        const hl = !!lines && n >= lines[0] && n <= lines[1];
        return (
          <div key={i} className={`line${hl ? " hl" : ""}`} data-line={n} {...(hl ? { "aria-current": "true" as const } : {})}>
            <span className="ln">{n}</span>
            <span className="tx">{l || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

type EvidenceMode = "source" | "rendered";
const EVIDENCE_MODES: ReadonlyArray<TabItem<EvidenceMode>> = [
  { id: "source", label: "Source lines" },
  { id: "rendered", label: "Rendered" },
];

function EvidenceDrawer({ target, onClose }: { target: EvidenceTarget; onClose: () => void }) {
  const doc = useResource<DocView>(`/memory/document?root=${encodeURIComponent(target.root)}&path=${encodeURIComponent(target.relPath)}`, ["memory.changed"]);
  const [mode, setMode] = useState<EvidenceMode>("source");
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const d = doc.data;
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Evidence: ${target.title ?? target.relPath}`}>
        <div className="drawer-head">
          <div className="stack-sm" style={{ flex: 1, minWidth: 0 }}>
            <div className="row">
              {target.marker && <span className="cite">{target.marker}</span>}
              <h2 className="detail-title" style={{ overflowWrap: "anywhere" }}>{d?.title ?? target.title ?? target.relPath}</h2>
            </div>
            <div className="row small muted">
              {d && <Tag>{d.area === "memory" ? "curated memory" : d.area === "import" ? "imported note" : d.area}</Tag>}
              <span className="mono" style={{ overflowWrap: "anywhere" }}>
                {target.root !== "data" ? `${d?.rootLabel ?? target.root} › ` : ""}
                {target.relPath}
                {target.lines ? `:${target.lines[0]}–${target.lines[1]}` : ""}
              </span>
              {d?.indexedAt && (
                <span>
                  indexed <Time iso={d.indexedAt} />
                </span>
              )}
            </div>
          </div>
          <button ref={closeRef} className="ghost" onClick={onClose} aria-label="Close evidence">
            ✕
          </button>
        </div>
        <div className="drawer-body stack">
          {doc.loading && !d && <Loading lines={8} />}
          <ErrorState error={doc.error} retry={doc.reload} title="Could not open this evidence" />
          {d && (
            <>
              <div className="row">
                <Tabs label="How to show the file" tabs={EVIDENCE_MODES} selected={mode} onSelect={setMode} plain />
                {d.root === "data" && d.relPath.startsWith("memory/") && (
                  <Link to={`/brain?path=${encodeURIComponent(d.relPath)}`}>Open in Brain</Link>
                )}
              </div>
              {mode === "source" ? <SourceView raw={d.raw} lines={target.lines} /> : <Markdown text={d.raw.replace(/^---[\s\S]*?---\n/, "")} />}
              <p className="small muted">Absolute path: <span className="mono">{d.absPath}</span></p>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

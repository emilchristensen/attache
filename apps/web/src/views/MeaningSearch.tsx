import type { MeaningState, MeaningStatus } from "@attache/contracts";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, useAction } from "../components/ui.tsx";
import { StateTag } from "../components/StateTag.tsx";

const LABEL: Record<MeaningState, string> = { missing: "not downloaded", downloading: "downloading", failed: "failed", building: "building", ready: "ready" };
const STATE: Record<MeaningState, string> = { missing: "never_run", downloading: "running", failed: "failed", building: "running", ready: "ready" };

const mb = (bytes: number) => (bytes >= 1_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} KB`);
const share = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.floor((part / whole) * 100)) : 0);

function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

function Detail({ s }: { s: MeaningStatus }) {
  const { chunks, embedded } = s.vectors;
  switch (s.state) {
    case "missing":
      return <p className="small muted">Search matches keywords only until the model is downloaded ({mb(s.model.bytes)}).</p>;
    case "downloading": {
      const d = s.download ?? { received: 0, total: s.model.bytes };
      return (
        <div className="stack-sm">
          <Progress value={share(d.received, d.total)} label="Model download" />
          <p className="small muted">
            {mb(d.received)} of {mb(d.total)}. Search matches keywords only until the model is here and vectors are built.
          </p>
        </div>
      );
    }
    case "failed":
      return <p className="small error-text">{s.error}</p>;
    case "building":
      return (
        <div className="stack-sm">
          <Progress value={share(embedded, chunks)} label="Vectors built" />
          <p className="small muted">
            Vectors for {embedded} of {chunks} passages. Search matches keywords only until they are done.
          </p>
        </div>
      );
    case "ready":
      return (
        <p className="small muted">
          Every passage in this Machine's index has a vector ({chunks}). Search ranks by meaning and keywords.
        </p>
      );
  }
}

/** The meaning model on this Machine: its state, and the button that downloads it. */
export function MeaningSearchCard() {
  const status = useResource<MeaningStatus>("/memory/meaning", ["meaning.changed", "memory.changed"]);
  const { busy, run } = useAction();
  const s = status.data;
  const canDownload = s?.state === "missing" || s?.state === "failed";
  return (
    <div className="card stack" data-meaning-search>
      <div className="row">
        <h3 style={{ flex: 1 }}>Meaning-based search</h3>
        {s && <StateTag state={STATE[s.state]} label={LABEL[s.state]} />}
      </div>
      <p className="small muted">
        Meaning-based search finds notes by what they mean, so a question in other words or in Danish finds an English note. The model{s ? <> ({s.model.name})</> : null} runs on this Machine; notes never leave it, and its vectors stay out of the Brain.
      </p>
      {status.loading && !s && <Loading lines={1} />}
      <ErrorState error={status.error} retry={status.reload} />
      {s && <Detail s={s} />}
      {canDownload && (
        <div>
          <button className="primary" disabled={busy !== null} onClick={() => void run("meaning", () => post<MeaningStatus>("/memory/meaning/download").then(status.setData))}>
            {s.state === "failed" ? "Download again" : `Download model (${mb(s.model.bytes)})`}
          </button>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import type { ConnectionDefinition, ConnectionStatus, FeatureStatus } from "@attache/contracts";
import { put, type ApiError } from "../api.ts";
import { featureProblem } from "../feature-problem.ts";
import { useAction } from "../components/ui.tsx";
import { StateTag } from "../components/StateTag.tsx";
import { Tag } from "../components/Tag.tsx";

/** GET /capabilities, as the feature switches read it. */
export interface Caps {
  features: FeatureStatus[];
  connections: ConnectionStatus[];
  definitions: ConnectionDefinition[];
}

/** What a feature needs, in words: the features first, then the Connections, an optional one marked. */
function needs(f: FeatureStatus, all: FeatureStatus[]): string {
  return [...f.dependsOn.features.map((d) => all.find((x) => x.id === d)?.label ?? d), ...f.dependsOn.connections.map((c) => `${c.label}${c.required ? "" : " (optional)"}`)].join(" · ");
}

/**
 * One switch per feature, in Setup and in Settings: its name, what it does and what it needs. A healthy feature, or
 * one switched off, says nothing more; one that is on but not fully working names its state and the service's reason.
 * A change that would break a dependency asks first: turn on what it needs too, or also turn off what depends on it.
 */
export function FeatureList({ caps, onChanged }: { caps: Caps; onChanged: () => void }) {
  const { run } = useAction();
  const [problem, setProblem] = useState<{ id: string; on: boolean; message: string } | null>(null);
  const toggle = async (id: string, on: boolean, cascade = false) => {
    try {
      await put("/features", { changes: { [id]: on }, cascade });
      setProblem(null);
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "dependency") setProblem({ id, on, message: err.message });
      else throw e;
    }
  };
  return (
    <div className="card" role="group" aria-label="Features">
      {caps.features.map((f) => {
        const shown = featureProblem(f);
        const needed = needs(f, caps.features);
        const ids = { state: `f-${f.id}-state`, reason: `f-${f.id}-reason`, desc: `f-${f.id}-desc` };
        // A screen reader hears the problem's words and why before what the feature does.
        const described = [shown && ids.state, shown?.reason && ids.reason, ids.desc].filter(Boolean).join(" ");
        return (
          <div key={f.id} className="feature-row" data-feature={f.id}>
            <input type="checkbox" id={`f-${f.id}`} checked={f.enabled} disabled={f.core} aria-describedby={described} onChange={(e) => void run(`f-${f.id}`, () => toggle(f.id, e.target.checked))} />
            <div className="feature-body">
              <div className="feature-head">
                <label htmlFor={`f-${f.id}`} className={f.core ? "feature-name core" : "feature-name"}>
                  {f.label}
                </label>
                {f.core && <Tag>core</Tag>}
                {shown && (
                  <span id={ids.state} data-feature-problem={shown.state}>
                    <StateTag state={shown.state} label={shown.words} />
                  </span>
                )}
              </div>
              {shown?.reason && (
                <p className="feature-reason" id={ids.reason}>
                  {shown.reason}
                </p>
              )}
              <p className="desc" id={ids.desc}>
                {f.description}
              </p>
              {needed && <p className="deps">Needs: {needed}</p>}
              {problem?.id === f.id && (
                <div className="state partial small feature-dependency" role="alert">
                  <span>{problem.message}</span>
                  <div className="row">
                    <button className="small primary" onClick={() => void run("cascade", () => toggle(problem.id, problem.on, true))}>
                      {problem.on ? "Turn on what it needs too" : "Also turn off what depends on it"}
                    </button>
                    <button className="small ghost" onClick={() => setProblem(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

import type { ConnectionKind, FeatureId, FeatureStatus, ReadinessState } from "@attache/contracts";
import { HOOK_AGENT_KINDS } from "../agents/integrations.ts";

/**
 * The single server-side definition of what Attache can do. The setup
 * checklist, dependency validation, API access checks and the scheduler all
 * read this registry; the clients only render it.
 */
export interface FeatureDefinition {
  id: FeatureId;
  label: string;
  description: string;
  core: boolean;
  defaultEnabled: boolean;
  requiresFeatures: FeatureId[];
  connections: Array<{ kinds: ConnectionKind[]; label: string; required: boolean; missingEffect: string }>;
  /** Scheduled triggers owned by this feature. */
  schedules: Array<{ id: string; label: string; jobKind: "source-refresh" | "briefing" }>;
  /** Job kinds that belong to this feature (cancelled when it is disabled). */
  jobKinds: string[];
}

export const SOURCE_KINDS: ConnectionKind[] = ["vault", "github", "jira", "confluence", "slack", "gmail", "gcal"];

export const FEATURES: FeatureDefinition[] = [
  {
    id: "recall",
    label: "Search and recall",
    description: "Index your Markdown and search it. Works without a model.",
    core: true,
    defaultEnabled: true,
    requiresFeatures: [],
    connections: [],
    schedules: [],
    jobKinds: ["reindex"],
  },
  {
    id: "capture",
    label: "Saving to memory",
    description: "Import a Markdown folder, save notes and decisions from a Harness, write what a meeting capture changes in the Brain (with a model; Proposals for you to review when the Consolidation switch is off), and review Proposals and recent saves.",
    core: false,
    defaultEnabled: true,
    requiresFeatures: ["recall"],
    // A model is only needed to consolidate meeting captures; saving works without one, so it is not listed here.
    connections: [],
    schedules: [],
    jobKinds: ["import", "capture-consolidate"],
  },
  {
    id: "jobs",
    label: "Background work",
    description: "Research, briefing and draft-preparation jobs that keep running when you close the tab.",
    core: false,
    defaultEnabled: true,
    requiresFeatures: [],
    connections: [],
    schedules: [],
    jobKinds: ["research", "demo-long"],
  },
  {
    id: "attention",
    label: "Attention and briefings",
    description: "Scheduled source updates, deadlines, review queues, meeting prep, pending replies and a daily briefing.",
    core: false,
    defaultEnabled: true,
    requiresFeatures: ["jobs"],
    connections: [{ kinds: SOURCE_KINDS, label: "At least one source (your data folder counts)", required: true, missingEffect: "Nothing to watch." }],
    schedules: [
      { id: "source-refresh", label: "Source refresh", jobKind: "source-refresh" },
      { id: "briefing", label: "Daily briefing", jobKind: "briefing" },
    ],
    jobKinds: ["source-refresh", "briefing"],
  },
  {
    id: "drafts",
    label: "Drafts and approvals",
    description: "Prepare replies and review comments with their context. Nothing is sent until you approve that exact version.",
    core: false,
    defaultEnabled: true,
    requiresFeatures: ["attention", "jobs"],
    connections: [{ kinds: ["model"], label: "A model to prepare drafts", required: false, missingEffect: "Drafts start empty for you to write; Attache cannot prepare them." }],
    schedules: [],
    jobKinds: ["draft", "action"],
  },
  {
    id: "sessions",
    label: "Agent sessions",
    description: "Save your Harness sessions (Claude Code, Codex, Antigravity) in your data folder with a summary of what was decided, write what they change in the Brain (Proposals for you to review when the Consolidation switch is off), and give each new session your Attache memory.",
    core: false,
    defaultEnabled: true,
    requiresFeatures: ["capture", "jobs"],
    connections: [
      { kinds: HOOK_AGENT_KINDS, label: "A Harness with hooks (Claude Code, Codex or Antigravity)", required: true, missingEffect: "There are no agent sessions to save." },
      { kinds: ["model"], label: "A model to summarise and consolidate sessions", required: false, missingEffect: "Sessions are saved without a summary and are not consolidated." },
    ],
    schedules: [],
    jobKinds: ["session-distill", "session-consolidate"],
  },
];

export const featureDef = (id: FeatureId) => FEATURES.find((f) => f.id === id)!;

export function isEnabled(features: Partial<Record<FeatureId, boolean>>, id: FeatureId): boolean {
  const def = featureDef(id);
  if (def.core) return true;
  return features[id] ?? def.defaultEnabled;
}

export function effectiveFeatures(features: Partial<Record<FeatureId, boolean>>): Record<FeatureId, boolean> {
  return Object.fromEntries(FEATURES.map((f) => [f.id, isEnabled(features, f.id)])) as Record<FeatureId, boolean>;
}

export interface DependencyProblem {
  feature: FeatureId;
  kind: "requires" | "required_by";
  others: FeatureId[];
  message: string;
}

/** Validate a proposed feature map. Returns problems instead of silently fixing them. */
export function validateFeatures(proposed: Partial<Record<FeatureId, boolean>>): DependencyProblem[] {
  const eff = effectiveFeatures(proposed);
  const problems: DependencyProblem[] = [];
  for (const f of FEATURES) {
    if (!eff[f.id]) continue;
    const missing = f.requiresFeatures.filter((d) => !eff[d]);
    if (missing.length) problems.push({ feature: f.id, kind: "requires", others: missing, message: `${f.label} needs ${missing.map((m) => featureDef(m).label).join(" and ")}.` });
  }
  return problems;
}

/** Apply a change, optionally cascading: enabling pulls in requirements, disabling turns off dependents. */
export function resolveChange(current: Partial<Record<FeatureId, boolean>>, change: Partial<Record<FeatureId, boolean>>, cascade: boolean): { next: Record<FeatureId, boolean>; added: FeatureId[]; removed: FeatureId[]; problems: DependencyProblem[] } {
  for (const [id, on] of Object.entries(change)) {
    if (featureDef(id as FeatureId)?.core && on === false) {
      return { next: effectiveFeatures(current), added: [], removed: [], problems: [{ feature: id as FeatureId, kind: "required_by", others: [], message: `${featureDef(id as FeatureId).label} is core and cannot be turned off.` }] };
    }
  }
  const next = { ...effectiveFeatures(current), ...change } as Record<FeatureId, boolean>;
  const added: FeatureId[] = [];
  const removed: FeatureId[] = [];
  if (cascade) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of FEATURES) {
        if (next[f.id]) {
          for (const d of f.requiresFeatures) {
            if (!next[d]) {
              if (change[f.id] === true) {
                next[d] = true;
                added.push(d);
              } else {
                next[f.id] = false;
                removed.push(f.id);
              }
              changed = true;
            }
          }
        }
      }
    }
  }
  return { next, added, removed, problems: validateFeatures(next) };
}

export function computeStatus(
  features: Partial<Record<FeatureId, boolean>>,
  connections: Array<{ kind: ConnectionKind; status: string }>,
  opts: { dataFolder: string | null },
): FeatureStatus[] {
  const eff = effectiveFeatures(features);
  return FEATURES.map((f) => {
    const base = {
      id: f.id,
      label: f.label,
      description: f.description,
      core: f.core,
      enabled: eff[f.id],
      dependsOn: { features: f.requiresFeatures, connections: f.connections.map((c) => ({ kinds: c.kinds, label: c.label, required: c.required })) },
      schedules: f.schedules.map((s) => s.label),
    };
    if (!eff[f.id]) return { ...base, readiness: "disabled" as ReadinessState, reason: null };
    const missingFeatures = f.requiresFeatures.filter((d) => !eff[d]);
    if (missingFeatures.length) return { ...base, readiness: "needs_setup" as ReadinessState, reason: `Turn on ${missingFeatures.map((m) => featureDef(m).label).join(", ")}.` };
    if ((f.id === "recall" || f.id === "capture" || f.id === "sessions") && !opts.dataFolder) return { ...base, readiness: "needs_setup" as ReadinessState, reason: "Choose a data folder." };
    let readiness: ReadinessState = "ready";
    let reason: string | null = null;
    for (const c of f.connections) {
      const matching = connections.filter((x) => c.kinds.includes(x.kind));
      const ok = matching.filter((x) => x.status === "connected");
      if (c.kinds.includes("vault") && opts.dataFolder) continue;
      if (!ok.length) {
        const broken = matching.find((x) => x.status === "error" || x.status === "needs_auth");
        if (c.required) {
          readiness = broken ? "unavailable" : "needs_setup";
          reason = broken ? `${c.label}: connection needs attention.` : `${c.label} is not connected. ${c.missingEffect}`;
        } else if (readiness === "ready") {
          readiness = "partial";
          reason = c.missingEffect;
        }
      }
    }
    return { ...base, readiness, reason };
  });
}

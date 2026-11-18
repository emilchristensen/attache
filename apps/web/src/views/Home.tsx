import { useResource } from "../live.ts";
import { BriefingCard, Inbox } from "./Inbox.tsx";
import { HomeConnections, useConnectionsStatus } from "./HomeConnections.tsx";
import { RecentlyAdded } from "./RecentlyAdded.tsx";
import { inboxCoverage } from "../connection-status.ts";

/**
 * Home: the briefing, then Connections (can the owner trust what is below?), then the Inbox and what reached the
 * Brain without review. Questions to the Brain happen in the owner's Harness (ADR 0003).
 */
export function Home() {
  const cfg = useResource<{ features: Record<string, boolean> }>("/config", ["config.changed"]);
  const f = cfg.data?.features ?? {};
  const connections = useConnectionsStatus();
  return (
    <section className="page page-inbox" aria-label="Attention inbox">
      {f.attention && <BriefingCard canRun />}
      <HomeConnections view={connections} />
      <Inbox attentionOn={f.attention ?? false} draftsOn={f.drafts ?? false} coverage={inboxCoverage(connections.status)} />
      {f.recall && <RecentlyAdded />}
    </section>
  );
}

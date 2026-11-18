import { useResource } from "../live.ts";
import { ForYouNow } from "./ForYouNow.tsx";
import { HomeSearch } from "./HomeSearch.tsx";
import { Inbox } from "./Inbox.tsx";
import { HomeConnections, useConnectionsStatus } from "./HomeConnections.tsx";
import { RecentlyAdded } from "./RecentlyAdded.tsx";
import { inboxCoverage } from "../connection-status.ts";

/**
 * Home: Search the Brain, For you now (the Heads-ups), then Connections (can the owner trust what is below?), then
 * the Inbox and what reached the Brain without review. Questions to the Brain happen in the owner's Harness (ADR 0003).
 */
export function Home() {
  const cfg = useResource<{ features: Record<string, boolean> }>("/config", ["config.changed"]);
  const f = cfg.data?.features ?? {};
  const connections = useConnectionsStatus();
  return (
    <section className="page page-inbox" aria-label="Home">
      <HomeSearch recall={f.recall} />
      {cfg.data && <ForYouNow attentionOn={f.attention ?? false} />}
      <HomeConnections view={connections} />
      <Inbox attentionOn={f.attention ?? false} draftsOn={f.drafts ?? false} coverage={inboxCoverage(connections.status)} />
      {f.recall && <RecentlyAdded />}
    </section>
  );
}

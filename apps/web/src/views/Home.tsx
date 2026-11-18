import type { Config } from "@attache/contracts";
import { useResource } from "../live.ts";
import { ForYouNow } from "./ForYouNow.tsx";
import { Inbox } from "./Inbox.tsx";
import { RecentlyAdded } from "./RecentlyAdded.tsx";

/**
 * Home: For you now (the Heads-ups), the Inbox, then what reached the Brain without review.
 * Questions to the Brain happen in the owner's Harness (ADR 0003).
 */
export function Home() {
  const cfg = useResource<{ config: Config; features: Record<string, boolean> }>("/config", ["config.changed"]);
  const f = cfg.data?.features ?? {};
  const schedules = cfg.data?.config.schedules;
  return (
    <section className="page page-inbox" aria-label="Home">
      {cfg.data && <ForYouNow attentionOn={f.attention ?? false} schedule={schedules ? { briefingAt: schedules.briefingAt, briefingEnabled: schedules.briefingEnabled } : null} />}
      <Inbox attentionOn={f.attention ?? false} draftsOn={f.drafts ?? false} />
      {f.recall && <RecentlyAdded />}
    </section>
  );
}

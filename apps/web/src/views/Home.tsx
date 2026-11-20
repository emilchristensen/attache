import { useRef, useState } from "react";
import { useReadingPlace } from "../reading-place.ts";
import { useHomeClock } from "../heads-up-clock.ts";
import { useResource } from "../live.ts";
import { HomeSearch } from "./HomeSearch.tsx";
import { ForYouNow } from "./ForYouNow.tsx";
import { DailyBriefing } from "./DailyBriefing.tsx";
import { Inbox } from "./Inbox.tsx";
import { useConnectionsStatus } from "./HomeConnections.tsx";
import { RecentlyAdded } from "./RecentlyAdded.tsx";
import { YourDay } from "./YourDay.tsx";

const NOTHING_ABOVE: ReadonlySet<string> = new Set();

/** Home's areas and the shared clock for their live, time-dependent views. */
export function Home() {
  const cfg = useResource<{ features: Record<string, boolean> }>("/config", ["config.changed"]);
  const f = cfg.data?.features ?? {};
  const connections = useConnectionsStatus();
  const [above, setAbove] = useState<ReadonlySet<string>>(NOTHING_ABOVE);
  const page = useRef<HTMLElement>(null);
  const clock = useHomeClock();
  useReadingPlace(page);
  return (
    <section ref={page} className="page page-inbox" aria-label="Home">
      <HomeSearch recall={f.recall} />
      {cfg.data && <DailyBriefing attentionOn={f.attention ?? false} clock={clock} onRead={(id) => window.history.pushState(null, "", `/briefing/${id}`)} />}
      {cfg.data && <ForYouNow attentionOn={f.attention ?? false} clock={clock} onAbove={setAbove} />}
      {cfg.data && <YourDay clock={clock} enabled={f.attention ?? false} />}
      <Inbox attentionOn={cfg.data ? (f.attention ?? false) : null} draftsOn={f.drafts ?? false} connections={connections.status} above={above} clock={clock} after={f.capture && <RecentlyAdded />} />
    </section>
  );
}

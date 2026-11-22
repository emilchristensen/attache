import { useCallback, useRef, useState } from "react";
import { useReadingPlace } from "../reading-place.ts";
import { useHomeClock } from "../heads-up-clock.ts";
import { useResource } from "../live.ts";
import { useConnections } from "../connections-view.ts";
import { HomeSearch } from "./HomeSearch.tsx";
import { ForYouNow } from "./ForYouNow.tsx";
import { DailyBriefing } from "./DailyBriefing.tsx";
import { Inbox } from "./Inbox.tsx";
import { RecentlyAdded } from "./RecentlyAdded.tsx";
import { YourDay } from "./YourDay.tsx";

const NOTHING_SUGGESTED: ReadonlySet<string> = new Set();

/** The same items, in any order: a new set only when what For you now shows changed. */
const sameItems = (a: ReadonlySet<string>, b: readonly string[]) => a.size === b.length && b.every((id) => a.has(id));

/**
 * Home's areas, in the order a desktop window reads them: Search the Brain, The Daily Briefing, Your day, then For you
 * now beside the Inbox (`styles/home.css` arranges them, and puts For you now before Your day on a phone), with one
 * clock for their time-dependent views.
 */
export function Home() {
  const cfg = useResource<{ features: Record<string, boolean> }>("/config", ["config.changed"]);
  const f = cfg.data?.features ?? {};
  const connections = useConnections();
  const [suggested, setSuggested] = useState<ReadonlySet<string>>(NOTHING_SUGGESTED);
  const onShown = useCallback((ids: readonly string[]) => setSuggested((prev) => (sameItems(prev, ids) ? prev : new Set(ids))), []);
  const page = useRef<HTMLElement>(null);
  const clock = useHomeClock();
  useReadingPlace(page);
  const attentionOn = f.attention ?? false;
  return (
    <section ref={page} className="page page-inbox" aria-label="Home">
      <HomeSearch recall={f.recall} />
      {cfg.data && <DailyBriefing attentionOn={attentionOn} clock={clock} />}
      <div className="home-areas">
        {cfg.data && <YourDay clock={clock} enabled={attentionOn} />}
        {cfg.data && <ForYouNow attentionOn={attentionOn} draftsOn={f.drafts ?? false} clock={clock} onShown={onShown} />}
        <Inbox attentionOn={cfg.data ? attentionOn : null} draftsOn={f.drafts ?? false} connections={connections.status} suggested={suggested} clock={clock} after={f.capture && <RecentlyAdded />} />
      </div>
    </section>
  );
}

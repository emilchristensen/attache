import type { Ref } from "react";
import { navBadge, type NavSignals } from "../nav-signals.ts";
import { BOTTOM_BAR_SCREENS, MORE_SCREENS, screen, type ScreenId } from "../routes.ts";
import { launchSearch } from "../search-launch.ts";
import { AttentionDot } from "./AttentionDot.tsx";
import { Icon } from "./icons.tsx";
import { ScreenLink, spokenName } from "./ScreenLink.tsx";

/** What waits under More, read out after its name: "1 sign-in needed, Replication blocked". */
function moreNews(signals: NavSignals): string | null {
  const news = [signals.badges.connections?.label, signals.settingsWarning].filter(Boolean);
  return news.length ? news.join(", ") : null;
}

/**
 * The narrow window's navigation: Home, Approvals, Search, Brain and More, one tap each. More opens the sheet with
 * Jobs, Connections, Settings and this Machine, and carries the brass dot when one of those needs the owner.
 */
export function BottomBar({ current, signals, moreOpen, onMore, moreRef }: { current: ScreenId | null; signals: NavSignals; moreOpen: boolean; onMore: () => void; moreRef: Ref<HTMLButtonElement> }) {
  const [home, approvals, brain] = BOTTOM_BAR_SCREENS.map(screen);
  const link = (id: ScreenId) => <ScreenLink key={id} screen={screen(id)} current={current === id} badge={navBadge(signals, id, current)} icon />;
  const news = moreNews(signals);
  return (
    <nav className="bottom-bar" aria-label="Main">
      {link(home!.id)}
      {link(approvals!.id)}
      <button onClick={launchSearch}>
        <Icon name="search" size={20} />
        <span className="screen-label">Search</span>
      </button>
      {link(brain!.id)}
      <button ref={moreRef} aria-label={spokenName("More", [news])} aria-haspopup="dialog" aria-expanded={moreOpen} aria-current={current && MORE_SCREENS.includes(current) ? "true" : undefined} onClick={onMore}>
        <Icon name="more" size={20} />
        <span className="screen-label">More</span>
        {news && <AttentionDot decorative />}
      </button>
    </nav>
  );
}

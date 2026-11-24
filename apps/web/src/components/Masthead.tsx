import type { ConnectionsStatus } from "../connection-status.ts";
import { shownCount } from "../count.ts";
import { navBadge, needYou, type NavSignals } from "../nav-signals.ts";
import { SCREENS, type ScreenId } from "../routes.ts";
import { Icon } from "./icons.tsx";
import { Logo } from "./Logo.tsx";
import { MachineDisclosure } from "./MachinePanel.tsx";
import { ScreenLink, spokenName } from "./ScreenLink.tsx";
import { Link } from "./ui.tsx";

/**
 * The desktop masthead: the mark with the total raised beside the wordmark, every screen on one line (the current one a
 * solid pill), the search launcher off Home and this Machine's disclosure at the far right. On a narrow window only
 * the mark stays (and the disclosure while the live connection is lost); the bottom bar takes the screens.
 */
export function Masthead({ current, signals, connections, onSearch }: { current: ScreenId | null; signals: NavSignals; connections: ConnectionsStatus; onSearch: () => void }) {
  const total = shownCount(signals.count.total);
  return (
    <header className="masthead">
      <div className="masthead-inner">
        {/* The name starts with the words on screen, "Attache" and the raised total, then says what it counts (WCAG 2.5.3). */}
        <Link to="/" className="brand" aria-label={spokenName("Attache", [total && `${total} ${needYou(signals.count.total.count)}`])}>
          <Logo size={32} attention={signals.dot} />
          <span className="brand-name">Attache</span>
          {total && (
            <>
              {" "}
              <sup className="brand-total">{total}</sup>
            </>
          )}
        </Link>
        <nav className="masthead-nav" aria-label="Main">
          {SCREENS.map((s) => (
            <ScreenLink key={s.id} screen={s} current={current === s.id} badge={navBadge(signals, s.id, current)} warning={s.id === "settings" ? signals.settingsWarning : null} healthy={s.id === "connections" && connections.kind === "all_good"} />
          ))}
        </nav>
        <div className="masthead-tools">
          {current !== "home" && (
            <button className="search-launcher" aria-label="Search the Brain" onClick={onSearch}>
              <Icon name="search" />
              <span className="search-launcher-label">Search</span>
            </button>
          )}
          <MachineDisclosure />
        </div>
      </div>
    </header>
  );
}

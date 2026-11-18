import { navBadge, spokenTotal, type NavSignals } from "../nav-signals.ts";
import { SCREENS, type ScreenId } from "../routes.ts";
import { launchSearch } from "../search-launch.ts";
import { Icon } from "./icons.tsx";
import { Logo } from "./Logo.tsx";
import { MachineDisclosure } from "./MachinePanel.tsx";
import { ScreenLink, spokenName } from "./ScreenLink.tsx";
import { Link } from "./ui.tsx";

/**
 * The desktop masthead: the unchanged mark, every screen on one line, the search launcher off Home and this
 * Machine's disclosure. On a narrow window only the mark stays (and the disclosure while the live connection is
 * lost); the bottom bar takes the screens.
 */
export function Masthead({ current, signals }: { current: ScreenId | null; signals: NavSignals }) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <Link to="/" className="brand" aria-label={spokenName("Attache", [spokenTotal(signals.count.total)])}>
          <Logo size={32} attention={signals.dot} />
          <span className="brand-name">Attache</span>
        </Link>
        <nav className="masthead-nav" aria-label="Main">
          {SCREENS.map((s) => (
            <ScreenLink key={s.id} screen={s} current={current === s.id} badge={navBadge(signals, s.id, current)} warning={s.id === "settings" ? signals.settingsWarning : null} />
          ))}
        </nav>
        <div className="masthead-tools">
          {current !== "home" && (
            <button className="search-launcher" aria-label="Search the Brain" onClick={launchSearch}>
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

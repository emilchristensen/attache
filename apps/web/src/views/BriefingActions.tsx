import { usePopover } from "../components/menu.ts";
import { Icon } from "../components/icons.tsx";
import { useAction } from "../components/ui.tsx";
import type { BriefingKind } from "./briefing-job.ts";

/** What the owner hears once a briefing asked for here is on its way. */
export const PREPARING: Readonly<Record<BriefingKind, string>> = {
  daily: "Preparing today's Daily Briefing in the background",
  manual: "Preparing a briefing in the background",
  away: "Writing an Away summary in the background",
};

/** How far back an Away summary looks. */
export const AWAY_SUMMARY_DAYS = 3;

interface Props {
  /** A briefing is being written; asking for another waits until it is done. */
  running: boolean;
  /** Meeting context needs a briefing to read it from. */
  hasBriefing: boolean;
  /** No Daily Briefing was written today: Prepare a briefing writes it, so it fills the area. */
  noDailyToday: boolean;
  start: (kind: BriefingKind, since?: string) => Promise<void>;
  onMeetingContext: () => void;
}

/**
 * Prepare a briefing, Away summary and Meeting context, together behind one button that For you now always shows,
 * whatever is timely: nothing from the old briefing card is lost when no briefing leads.
 */
export function BriefingActions({ running, hasBriefing, noDailyToday, start, onMeetingContext }: Props) {
  // A choice made: the menu has done its job and focus goes back to its button.
  const menu = usePopover();
  const { busy, run } = useAction();
  const waiting = running || busy !== null;
  const ask = (asked: "prepare" | "away") => {
    const kind: BriefingKind = asked === "away" ? "away" : noDailyToday ? "daily" : "manual";
    const since = kind === "away" ? new Date(Date.now() - AWAY_SUMMARY_DAYS * 86_400_000).toISOString() : undefined;
    void run(kind, () => start(kind, since), PREPARING[kind]);
  };
  return (
    <div className="briefing-actions">
      <button className="small briefing-actions-trigger" {...menu.buttonProps}>
        Briefing options
        <Icon name="chevron" className="briefing-actions-chevron" />
      </button>
      {menu.open && (
        <div className="menu-pop" aria-label="Briefing actions" {...menu.listProps}>
          <button className="menu-item" disabled={waiting} onClick={() => ask("prepare")}>
            <span>Prepare a briefing</span>
            <span className="menu-help">{running ? "A briefing is being written now." : "What needs you now, across your sources."}</span>
          </button>
          <button className="menu-item" disabled={waiting} onClick={() => ask("away")}>
            <span>Away summary</span>
            <span className="menu-help">What changed in the last {AWAY_SUMMARY_DAYS} days.</span>
          </button>
          <button className="menu-item" disabled={!hasBriefing} onClick={onMeetingContext}>
            <span>Meeting context</span>
            <span className="menu-help">{hasBriefing ? "Notes the latest briefing found for your meetings." : "Prepare a briefing first; it finds the notes."}</span>
          </button>
        </div>
      )}
    </div>
  );
}

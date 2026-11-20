import { useCallback, useId, useRef, useState } from "react";
import { useMenuDismiss } from "../components/menu.ts";
import { Icon } from "../components/icons.tsx";
import { useAction } from "../components/ui.tsx";

/** How far back an Away summary looks. */
export const AWAY_SUMMARY_DAYS = 3;

interface Props {
  /** A briefing is being written; asking for another waits until it is done. */
  running: boolean;
  /** Meeting context needs a briefing to read it from. */
  hasBriefing: boolean;
  start: (kind: "manual" | "away", since?: string) => Promise<void>;
  onMeetingContext: () => void;
}

/**
 * Prepare a briefing, Away summary and Meeting context, together behind one button that For you now always shows,
 * whatever is timely: nothing from the old briefing card is lost when no briefing leads.
 */
export function BriefingActions({ running, hasBriefing, start, onMeetingContext }: Props) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { busy, run } = useAction();
  const close = useCallback(() => setOpen(false), []);
  // A choice made: the menu has done its job and focus goes back to its button.
  const chosen = useMenuDismiss(open, close, root, button);
  const waiting = running || busy !== null;
  const ask = (kind: "manual" | "away") => {
    const since = kind === "away" ? new Date(Date.now() - AWAY_SUMMARY_DAYS * 86_400_000).toISOString() : undefined;
    void run(kind, () => start(kind, since), kind === "away" ? "Writing an Away summary in the background" : "Preparing a briefing in the background");
  };
  return (
    <div className="briefing-actions" ref={root}>
      <button ref={button} className="small briefing-actions-trigger" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>
        Briefing options
        <Icon name="chevron" className="briefing-actions-chevron" />
      </button>
      {open && (
        <div id={menuId} className="menu-pop" role="group" aria-label="Briefing actions" onClick={chosen}>
          <button className="menu-item" disabled={waiting} onClick={() => ask("manual")}>
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

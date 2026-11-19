import type { Badge } from "../nav-signals.ts";
import type { Screen } from "../routes.ts";
import { AttentionDot } from "./AttentionDot.tsx";
import { Icon } from "./icons.tsx";
import { Link } from "./ui.tsx";

/** A name in the navigation as a screen reader hears it, with what waits there right after it: "Approvals, 2 waiting". */
export function spokenName(label: string, news: ReadonlyArray<string | null | undefined>): string {
  return [label, ...news.filter(Boolean)].join(", ");
}

/**
 * A screen's decision count as it shows: the number alone ("4", or "4+" for a lower bound); the link's name reads it
 * out with its words. A space keeps it apart from the name in the text, so the words on screen ("Approvals 2") are
 * what the name starts with ("Approvals, 2 waiting") and speech input can say them (WCAG 2.5.3).
 */
export function BadgeCount({ badge }: { badge: Badge | undefined }) {
  if (!badge) return null;
  return (
    <>
      {" "}
      <span className="count" aria-hidden>
        {badge.shown}
      </span>
    </>
  );
}

/**
 * One screen in the navigation, the current one marked by shape and contrast. A named `warning` (Settings' Replication
 * problem) shows as the brass dot with its name: read out and on hover, or in words where there is room (`warningShown`).
 */
export function ScreenLink({ screen, current, badge, warning, warningShown = false, icon = false }: { screen: Screen; current: boolean; badge?: Badge; warning?: string | null; warningShown?: boolean; icon?: boolean }) {
  return (
    <Link to={screen.to} aria-current={current ? "page" : undefined} aria-label={spokenName(screen.label, [badge?.label, warning])} title={warning ?? `g then ${screen.key}`}>
      {icon && <Icon name={screen.icon} size={20} />}
      <span className="screen-label">{screen.label}</span>
      <BadgeCount badge={badge} />
      {warning && (
        <span className="screen-warning">
          <AttentionDot decorative />
          {warningShown && warning}
        </span>
      )}
    </Link>
  );
}

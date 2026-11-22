import { useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import type { AgendaResponse } from "@attache/contracts";
import { useResource } from "../live.ts";
import type { HeadsUpClock } from "../heads-up-clock.ts";
import { yourDay, yourDayRange, type DayEvent, type YourDayView } from "../your-day.ts";
import { clockTime } from "../zoned-time.ts";
import { Link, TurnOnInSettings } from "../components/ui.tsx";

function Meeting({ event, zone }: { event: DayEvent; zone: string }) {
  const time = event.allDay ? "All day" : clockTime(Date.parse(event.start), zone);
  return (
    <li className={`your-day-event ${event.phase}`} data-phase={event.phase}>
      <span className="your-day-time">{event.phase === "in-progress" ? "In progress" : time}</span>
      <span className="your-day-title">
        {event.calendarUrl ? (
          <a href={event.calendarUrl} target="_blank" rel="noopener noreferrer">
            {event.title}
          </a>
        ) : (
          event.title
        )}
        {event.response === "needsAction" && <span className="your-day-response">Not answered</span>}
      </span>
      {event.joinable && event.meetLink && (
        <a className="btn small" href={event.meetLink} target="_blank" rel="noopener noreferrer">
          Join
        </a>
      )}
    </li>
  );
}

function Meetings({ view, zone }: { view: YourDayView; zone: string }) {
  const allDay = view.events.filter((e) => e.allDay);
  const timed = view.events.filter((e) => !e.allDay);
  return (
    <>
      {allDay.length > 0 && <p className="your-day-all-day">{allDay.map((e) => e.title).join(" · ")}</p>}
      <ul className="your-day-events your-day-wide">
        {timed
          .filter((e) => e.visible)
          .map((e) => (
            <Meeting key={e.id} event={e} zone={zone} />
          ))}
      </ul>
      <ul className="your-day-events your-day-narrow">
        {timed.map((e) => (
          <Meeting key={e.id} event={e} zone={zone} />
        ))}
      </ul>
      {view.more > 0 && <span className="your-day-more">{view.more} more</span>}
    </>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <p className="your-day-message">{children}</p>;
}

/** The body for each state: never a blank box, and never "nothing today" without a complete read. */
function Body({ view, failed, readAt, zone, retry }: { view: YourDayView | null; failed: boolean; readAt: string | null; zone: string; retry: () => void }) {
  if (failed || view?.state === "error") {
    const last = readAt ? ` Last read ${clockTime(Date.parse(readAt), zone)}.` : "";
    return (
      <>
        <Message>
          Could not read your calendar.{last}{" "}
          <button className="small" onClick={retry}>
            Retry
          </button>
        </Message>
        {view && view.events.length > 0 && <Meetings view={view} zone={zone} />}
      </>
    );
  }
  switch (view?.state ?? "checking") {
    case "off":
      return (
        <Message>
          Switched off: Attention and briefings does not read your calendar. <TurnOnInSettings />
        </Message>
      );
    case "unconnected":
      return (
        <Message>
          No calendar connected. <Link to="/connections">Go to Connections</Link>
        </Message>
      );
    case "events":
      return <Meetings view={view!} zone={zone} />;
    case "empty":
      return <Message>Nothing on your calendar today</Message>;
    case "nothing-more":
      return <Message>Nothing more today{view!.tomorrow ? ` · Tomorrow ${clockTime(Date.parse(view!.tomorrow.start), zone)} ${view!.tomorrow.title}` : ""}</Message>;
    default:
      return <Message>Checking your calendar…</Message>;
  }
}

/**
 * Your day: today's meetings from the agenda route, as one ruled band (a list when narrow), following Home's clock
 * and the browser's current zone. A failed read keeps the last list it knew, with when it was read.
 */
export function YourDay({ clock, enabled }: { clock: HeadsUpClock; enabled: boolean }) {
  const headingId = useId();
  const range = useMemo(() => yourDayRange(clock.now, clock.timeZone), [clock.now, clock.timeZone]);
  const agenda = useResource<AgendaResponse>(enabled ? `/agenda?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : null, ["connections.changed"]);
  // A new range is a new request: the last answer stands in until it comes, so the band does not blink each minute.
  const last = useRef<AgendaResponse | null>(null);
  useEffect(() => {
    if (agenda.data) last.current = agenda.data;
  }, [agenda.data]);
  const data = agenda.data ?? last.current;
  const view = !enabled ? yourDay({ now: clock.now, timeZone: clock.timeZone, events: [], connection: null, readAt: null, coverage: null, enabled }) : data ? yourDay({ ...data, ...clock, enabled }) : null;
  return (
    <section className="your-day" aria-labelledby={headingId} data-state={agenda.error ? "error" : (view?.state ?? "checking")}>
      <div className="your-day-band">
        <h2 id={headingId}>Your day</h2>
        <div className="your-day-body">
          <Body view={view} failed={!!agenda.error} readAt={data?.readAt ?? null} zone={clock.timeZone} retry={agenda.reload} />
        </div>
      </div>
    </section>
  );
}

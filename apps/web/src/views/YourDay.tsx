import { useMemo } from "react";
import type { AgendaResponse } from "@attache/contracts";
import { useResource } from "../live.ts";
import type { HeadsUpClock } from "../heads-up-clock.ts";
import { yourDay, yourDayRange, type DayEvent } from "../your-day.ts";
import { clockTime } from "../zoned-time.ts";

function Meeting({ event, zone }: { event: DayEvent; zone: string }) {
  const time = event.allDay ? "All day" : clockTime(Date.parse(event.start), zone);
  return (
    <li className={`your-day-event ${event.phase}`} data-phase={event.phase}>
      <span className="your-day-time">{event.phase === "in-progress" ? "In progress" : time}</span>
      <span className="your-day-title">
        <a href={event.calendarUrl ?? undefined} target="_blank" rel="noreferrer">{event.title}</a>
        {event.response === "needsAction" && <span className="your-day-response">Not answered</span>}
      </span>
      {event.joinable && event.meetLink && <a className="button small" href={event.meetLink} target="_blank" rel="noreferrer">Join</a>}
    </li>
  );
}

export function YourDay({ clock, enabled }: { clock: HeadsUpClock; enabled: boolean }) {
  const range = useMemo(() => yourDayRange(clock.now, clock.timeZone), [clock.now, clock.timeZone]);
  const agenda = useResource<AgendaResponse>(`/agenda?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, ["connections.changed", "job"]);
  const view = agenda.data ? yourDay({ ...agenda.data, ...clock, enabled }) : null;
  return (
    <section className="your-day" aria-labelledby="your-day-heading" data-state={view?.state ?? "checking"}>
      <h2 id="your-day-heading">Your day</h2>
      <div className="your-day-body">
        {(!view || view.state === "checking") && !agenda.error && <p className="your-day-message">Checking</p>}
        {agenda.error && <p className="your-day-message">Could not read. <button className="link" onClick={agenda.reload}>Retry</button></p>}
        {view?.state === "off" && <p className="your-day-message">Switched off. <a href="/settings">Open Settings</a></p>}
        {view?.state === "unconnected" && <p className="your-day-message">No calendar connected. <a href="/connections">Open Connections</a></p>}
        {view?.state === "error" && <>
          <p className="your-day-message">Could not read{view && agenda.data?.readAt ? ` · Last read ${clockTime(Date.parse(agenda.data.readAt), clock.timeZone)}` : ""}. <button className="link" onClick={agenda.reload}>Retry</button></p>
          <ul className="your-day-events">{view.events.map((event) => <Meeting key={event.id} event={event} zone={clock.timeZone} />)}</ul>
        </>}
        {view?.state === "events" && <>
          {!!view.events.some((event) => event.allDay) && <p className="your-day-all-day">{view.events.filter((event) => event.allDay && event.visible).map((event) => event.title).join(" · ")}</p>}
          <ul className="your-day-events your-day-wide">{view.events.filter((event) => !event.allDay && event.visible).map((event) => <Meeting key={event.id} event={event} zone={clock.timeZone} />)}</ul>
          <ul className="your-day-events your-day-narrow">{view.events.filter((event) => !event.allDay).map((event) => <Meeting key={event.id} event={event} zone={clock.timeZone} />)}</ul>
          {!!view.more && <span className="your-day-more">{view.more} more</span>}
        </>}
        {view?.state === "empty" && <p className="your-day-message">Nothing on your calendar today</p>}
        {view?.state === "nothing-more" && <p className="your-day-message">Nothing more today{view.tomorrow ? ` · Tomorrow: ${clockTime(Date.parse(view.tomorrow.start), clock.timeZone)} ${view.tomorrow.title}` : ""}</p>}
      </div>
    </section>
  );
}

import { useId, useState } from "react";
import type { BriefingView } from "@attache/contracts";
import { useResource } from "../live.ts";
import { paintingForDate } from "../paintings.ts";
import { useSettledHeadsUps } from "../heads-up-memory.ts";
import { clockTime } from "../zoned-time.ts";
import { Link, TurnOnInSettings } from "../components/ui.tsx";
import { BriefingActions } from "./BriefingActions.tsx";
import { useBriefingJob } from "./briefing-job.ts";
import { MeetingContext } from "./BriefingParts.tsx";

function sameDay(at: string, now: number, zone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at)) === new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function RequestedBriefing({ briefing, clock, onRead, onGotIt }: { briefing: BriefingView; clock: { now: number; timeZone: string }; onRead: () => void; onGotIt: () => void }) {
  if (!sameDay(briefing.createdAt, clock.now, clock.timeZone) || clock.now >= Date.parse(briefing.createdAt) + 4 * 60 * 60_000) return null;
  const lead = briefing.lead;
  return <article className="requested-briefing"><div><strong>{briefing.kind === "away" ? "Away summary" : "Briefing you asked for"}</strong><h3>{lead?.headline ?? briefing.sections[0]?.items[0]?.title ?? "Your briefing is ready"}</h3><p>{lead?.explanation ?? briefing.summary}</p></div><div className="heads-up-actions"><button className="small" onClick={onRead}>Read briefing</button><button className="small ghost" onClick={onGotIt}>Got it</button></div></article>;
}

export function DailyBriefing({ attentionOn, clock, onRead }: { attentionOn: boolean; clock: { now: number; timeZone: string }; onRead: (id: string) => void }) {
  const headingId = useId();
  const latest = useResource<{ daily: BriefingView | null; requested: BriefingView | null }>(attentionOn ? "/briefings" : null, ["briefing.created", "job"]);
  const { job, start } = useBriefingJob(attentionOn);
  const { settled, settle } = useSettledHeadsUps();
  const [context, setContext] = useState(false);
  const briefing = latest.data?.daily ?? latest.data?.requested ?? null;
  const daily = latest.data?.daily && sameDay(latest.data.daily.createdAt, clock.now, clock.timeZone) ? latest.data.daily : null;
  const requested = latest.data?.requested && !settled.has(`briefing:${latest.data.requested.id}`) ? latest.data.requested : null;
  const folded = !!daily && settled.has(`briefing:${daily.id}`);
  const painting = daily ? paintingForDate(new Date(daily.createdAt).toLocaleDateString("en-CA", { timeZone: clock.timeZone })) : null;
  const options = <BriefingActions running={!!job} hasBriefing={!!briefing} start={start} onMeetingContext={() => setContext(true)} />;
  const leadItem = daily?.sections.flatMap((section) => section.items).at(0);
  const leadTitle = daily?.lead?.headline ?? leadItem?.title ?? "Your briefing is ready";
  const leadText = daily?.lead?.explanation ?? leadItem?.summary ?? daily?.summary;
  return <section className="daily-briefing-area" aria-labelledby={headingId}>
    <div className="daily-briefing-head"><h2 id={headingId}>The Daily Briefing</h2>{options}</div>
    {requested && <RequestedBriefing briefing={requested} clock={clock} onRead={() => onRead(requested.id)} onGotIt={() => settle(`briefing:${requested.id}`)} />}
    {!attentionOn ? <div className="briefing-empty">Briefings are switched off. <TurnOnInSettings /></div> : job ? <div className="briefing-empty"><strong>Preparing your briefing</strong><p>{job.note ?? "Queued"}</p><div className="progress" role="progressbar" aria-label="Briefing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div></div> : !daily ? <div className="briefing-empty"><strong>No briefing yet today</strong><button className="primary" onClick={() => void start("manual")}>Prepare a briefing</button></div> : folded ? <div className="briefing-folded"><button className="ghost" onClick={() => settle(`open:${daily.id}`)}>{leadTitle}</button><span>Written {clockTime(Date.parse(daily.createdAt), clock.timeZone)}</span></div> : <article className="daily-briefing-card">
      {painting && <div className="briefing-painting" style={{ backgroundImage: `url(${painting.src})`, backgroundPosition: painting.focal }}><div><span>The</span><strong>Daily Briefing</strong><p>{painting.title} · {painting.painter}</p></div></div>}
      <div className="briefing-lead"><p className="briefing-eyebrow">First on your list</p><h3>{leadTitle}</h3><p>{leadText}</p><p className="briefing-time">Written {clockTime(Date.parse(daily.createdAt), clock.timeZone)}</p><div className="heads-up-actions"><Link className="primary" to={`/briefing/${daily.id}`}>Read briefing</Link><button className="ghost" onClick={() => settle(`briefing:${daily.id}`)}>Got it</button></div></div>
    </article>}
    {latest.error && <p className="for-you-now-failed">Could not check for a briefing. <button className="small" onClick={latest.reload}>Try again</button></p>}
    {context && briefing && <MeetingContext briefing={briefing} now={clock.now} timeZone={clock.timeZone} onClose={() => setContext(false)} />}
  </section>;
}

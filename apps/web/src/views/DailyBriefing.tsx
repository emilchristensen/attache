import { useId, useState } from "react";
import type { BriefingView } from "@attache/contracts";
import { areaState, BRIEFING_NAME, leadWords, requestedShown, settledKey, staleReadAt, todaysDaily } from "../briefing-area.ts";
import type { HeadsUpClock } from "../heads-up-clock.ts";
import { useSettledHeadsUps } from "../heads-up-memory.ts";
import { paintingForDate } from "../paintings.ts";
import { briefingHref } from "../routes.ts";
import { clockTime, dayKey } from "../zoned-time.ts";
import { Link, TurnOnInSettings, useAction } from "../components/ui.tsx";
import { BriefingActions, PREPARING } from "./BriefingActions.tsx";
import { BriefingPainting } from "./BriefingPainting.tsx";
import { MeetingContext } from "./BriefingParts.tsx";
import { useBriefingJob, type BriefingJob } from "./briefing-job.ts";
import { useBriefings } from "./briefings.ts";

/** An away summary or a briefing the owner asked for: a plain card above the Daily Briefing, named for what it is. */
function RequestedBriefing({ briefing, onGotIt }: { briefing: BriefingView; onGotIt: () => void }) {
  const words = leadWords(briefing);
  return (
    <article className="requested-briefing" aria-label={BRIEFING_NAME[briefing.kind]}>
      <div>
        <strong>{BRIEFING_NAME[briefing.kind]}</strong>
        <h3>{words.headline}</h3>
        <p>{words.explanation}</p>
      </div>
      <div className="briefing-buttons">
        <Link className="btn small" to={briefingHref(briefing.id)}>
          Read briefing
        </Link>
        <button className="small ghost" onClick={onGotIt}>
          Got it
        </button>
      </div>
    </article>
  );
}

/** The two-part card: the painting with the area's name and credit, then "First on your list" and its actions. */
function DailyCard({ briefing, timeZone, onGotIt }: { briefing: BriefingView; timeZone: string; onGotIt: () => void }) {
  const words = leadWords(briefing);
  const painting = paintingForDate(dayKey(Date.parse(briefing.createdAt), timeZone));
  return (
    <article className="daily-briefing-card">
      <BriefingPainting painting={painting} className="briefing-card-painting">
        <span className="briefing-painting-the">The</span>
        <strong className="briefing-painting-name">Daily Briefing</strong>
      </BriefingPainting>
      <div className="briefing-lead">
        <p className="briefing-eyebrow">First on your list</p>
        <h3>{words.headline}</h3>
        <p>{words.explanation}</p>
        <p className="briefing-time">Written {clockTime(Date.parse(briefing.createdAt), timeZone)}</p>
        <div className="briefing-buttons">
          <Link className="btn primary" to={briefingHref(briefing.id)}>
            Read briefing
          </Link>
          <button className="ghost" onClick={onGotIt}>
            Got it
          </button>
        </div>
      </div>
    </article>
  );
}

/** Got it folded the card to one line; the line opens it again. */
function FoldedBriefing({ briefing, timeZone, onOpen }: { briefing: BriefingView; timeZone: string; onOpen: () => void }) {
  return (
    <div className="briefing-folded">
      <button className="ghost" onClick={onOpen}>
        {leadWords(briefing).headline}
      </button>
      <span>Written {clockTime(Date.parse(briefing.createdAt), timeZone)}</span>
    </div>
  );
}

function Writing({ job }: { job: BriefingJob }) {
  const percent = Math.round(job.progress * 100);
  return (
    <div className="briefing-empty">
      <strong>Preparing your briefing</strong>
      <p>{job.note ?? "Queued"}</p>
      <div className="progress" role="progressbar" aria-label="Briefing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/**
 * The Daily Briefing area on Home: today's Daily Briefing as the painting card all day, folded to one line by Got it
 * (remembered per briefing in this browser), an away summary or a briefing asked for above it, and the Briefing
 * options. Never an unexplained blank: no briefing yet, one being written, switched off and a failed answer each say so.
 */
export function DailyBriefing({ attentionOn, clock }: { attentionOn: boolean; clock: HeadsUpClock }) {
  const headingId = useId();
  const briefings = useBriefings(attentionOn);
  const { job, start } = useBriefingJob(attentionOn);
  const { settled, settle, unsettle } = useSettledHeadsUps();
  const [context, setContext] = useState(false);
  const { busy, run } = useAction();
  const daily = todaysDaily(briefings.data?.daily ?? null, clock.now, clock.timeZone);
  const requested = requestedShown(briefings.data?.requested ?? null, settled, clock.now);
  const latest = briefings.data?.daily ?? briefings.data?.requested ?? null;
  const state = areaState({ attentionOn, writing: !!job, failed: !!briefings.error, answered: !!briefings.data, daily, folded: !!daily && settled.has(settledKey(daily)) });
  // A later read failed after a good one: what was read stays, and a quiet line says it may be out of date.
  const staleAt = state === "off" ? null : staleReadAt({ failed: !!briefings.error, answeredAt: briefings.answeredAt });
  return (
    <section className="daily-briefing-area" aria-labelledby={headingId}>
      <div className="daily-briefing-head">
        <h2 id={headingId}>The Daily Briefing</h2>
        <BriefingActions running={!!job} hasBriefing={!!latest} noDailyToday={state === "none"} start={start} onMeetingContext={() => setContext(true)} />
      </div>
      {requested && <RequestedBriefing briefing={requested} onGotIt={() => settle(settledKey(requested))} />}
      {state === "off" && (
        <div className="briefing-empty">
          Briefings are switched off. <TurnOnInSettings />
        </div>
      )}
      {state === "writing" && job && <Writing job={job} />}
      {state === "failed" && (
        <p className="briefing-failed" role="alert">
          Could not check for a briefing.{" "}
          <button className="small" onClick={briefings.reload}>
            Try again
          </button>
        </p>
      )}
      {state === "none" && (
        <div className="briefing-empty">
          <strong>No briefing yet today</strong>
          {/* With none today, the briefing written now is today's Daily Briefing: it fills this area, with this morning's picks. */}
          <button className="primary" disabled={busy !== null} onClick={() => void run("prepare", () => start("daily"), PREPARING.daily)}>
            Prepare a briefing
          </button>
        </div>
      )}
      {state === "folded" && daily && <FoldedBriefing briefing={daily} timeZone={clock.timeZone} onOpen={() => unsettle(settledKey(daily))} />}
      {state === "card" && daily && <DailyCard briefing={daily} timeZone={clock.timeZone} onGotIt={() => settle(settledKey(daily))} />}
      {staleAt !== null && (
        <p className="briefing-stale" role="status" data-briefing-stale>
          Could not check for a newer briefing; this is the one read at {clockTime(staleAt, clock.timeZone)}.{" "}
          <button className="small" onClick={briefings.reload}>
            Retry
          </button>
        </p>
      )}
      {context && latest && <MeetingContext briefing={latest} now={clock.now} timeZone={clock.timeZone} onClose={() => setContext(false)} />}
    </section>
  );
}

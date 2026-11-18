import { briefingLines } from "../briefing-text.ts";
import type { BriefingView } from "../heads-ups.ts";
import { clockTime, spokenTime } from "../zoned-time.ts";
import { useOpenEvidence } from "../components/Evidence.tsx";
import { navigate } from "../components/ui.tsx";

/** Briefing sections that live on another screen instead of in the Inbox below. */
const SECTION_ROUTE: Record<string, string> = { prepared: "/approvals", memory: "/approvals" };

/** The Inbox's own element for a section, or the Inbox itself (`#inbox`) when it has no group of that name. */
function jumpTo(sectionId: string) {
  const route = SECTION_ROUTE[sectionId];
  if (route) return navigate(route);
  (document.getElementById(`attention-${sectionId}`) ?? document.getElementById("inbox"))?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Every point of a briefing, its linked counts and its file in the Brain: what Read briefing opens in place. */
export function BriefingDetail({ briefing }: { briefing: BriefingView }) {
  const open = useOpenEvidence();
  const fresh = [briefing.counts.new && `${briefing.counts.new} new`, briefing.counts.changed && `${briefing.counts.changed} changed`].filter(Boolean).join(" · ");
  return (
    <div className="briefing-detail">
      <ul className="briefing-lines">
        {briefingLines(briefing.summary).map((l, n) => (
          <li key={n} className={l.caveat ? "caveat" : undefined}>
            {l.text}
          </li>
        ))}
      </ul>
      {(briefing.sections.length > 0 || fresh) && (
        <div className="briefing-counts" role="group" aria-label="Briefing at a glance">
          {briefing.sections.map((s) => (
            <button key={s.id} className="count-chip" onClick={() => jumpTo(s.id)}>
              <b>{s.items.length}</b>
              {s.title}
            </button>
          ))}
          {fresh && <span className="briefing-fresh">{briefing.kind === "away" ? `${fresh} while away` : `${fresh} since the last briefing`}</span>}
        </div>
      )}
      {briefing.deliverablePath && (
        <button className="small" onClick={() => open({ root: "data", relPath: briefing.deliverablePath!, title: "Full briefing" })}>
          Open the full briefing
        </button>
      )}
    </div>
  );
}

/**
 * The meetings in the latest briefing and the notes from the Brain it found for each, labelled with when that
 * briefing looked: they are what the briefing found, not fresh research.
 */
export function MeetingContext({ briefing, now, timeZone, onClose }: { briefing: BriefingView; now: number; timeZone: string; onClose: () => void }) {
  const open = useOpenEvidence();
  const meetings = briefing.sections.filter((s) => s.id === "meetings").flatMap((s) => s.items);
  const made = Date.parse(briefing.createdAt);
  return (
    <section className="meeting-context" aria-label="Meeting context">
      <div className="meeting-context-head">
        <h3>Meeting context</h3>
        <span className="meeting-context-when">As the briefing {spokenTime(made, now, timeZone)} found it</span>
        <button className="small ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {meetings.length === 0 ? (
        <p className="meeting-context-empty">The {clockTime(made, timeZone)} briefing had no meetings to prepare. Prepare a briefing to look again.</p>
      ) : (
        <ul className="meeting-context-list">
          {meetings.map((m) => (
            <li key={m.id}>
              <strong>{m.title}</strong>
              {(m.related ?? []).length > 0 ? (
                <div className="row">
                  {m.related!.map((r) => (
                    <button key={`${r.relPath}:${r.lines.join("-")}`} className="source-chip" onClick={() => open({ root: "data", relPath: r.relPath, lines: r.lines, title: r.title })}>
                      {r.title}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="meeting-context-empty">No related notes were found.</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

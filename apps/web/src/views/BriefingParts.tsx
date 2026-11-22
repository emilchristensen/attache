import { briefingLines } from "../briefing-text.ts";
import type { BriefingRelatedNote, BriefingView } from "@attache/contracts";
import { clockTime, spokenTime } from "../zoned-time.ts";
import { useOpenEvidence } from "../components/Evidence.tsx";

/** A briefing's summary, one point a line (caveats about coverage set apart), and its file in the Brain. */
export function BriefingSummary({ briefing }: { briefing: BriefingView }) {
  const open = useOpenEvidence();
  return (
    <div className="briefing-detail">
      <ul className="briefing-lines">
        {briefingLines(briefing.summary).map((l, n) => (
          <li key={n} className={l.caveat ? "caveat" : undefined}>
            {l.text}
          </li>
        ))}
      </ul>
      {briefing.deliverablePath && (
        <button className="small" onClick={() => open({ root: "data", relPath: briefing.deliverablePath!, title: "Full briefing" })}>
          Open the full briefing
        </button>
      )}
    </div>
  );
}

/** One chip per related note a briefing found, opening the note at the lines it matched. */
export function RelatedNoteChips({ related }: { related: readonly BriefingRelatedNote[] }) {
  const open = useOpenEvidence();
  return (
    <div className="row">
      {related.map((r) => (
        <button key={`${r.relPath}:${r.lines.join("-")}`} className="source-chip" onClick={() => open({ root: "data", relPath: r.relPath, lines: r.lines, title: r.title })}>
          {r.title}
        </button>
      ))}
    </div>
  );
}

/**
 * The meetings in the latest briefing and the notes from the Brain it found for each, labelled with when that
 * briefing looked: they are what the briefing found, not fresh research.
 */
export function MeetingContext({ briefing, now, timeZone, onClose }: { briefing: BriefingView; now: number; timeZone: string; onClose: () => void }) {
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
              {(m.related ?? []).length > 0 ? <RelatedNoteChips related={m.related!} /> : <span className="meeting-context-empty">No related notes were found.</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

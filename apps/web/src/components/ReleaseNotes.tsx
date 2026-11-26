import { Markdown } from "./ui.tsx";

/**
 * A release's notes, from its signed manifest, shown inside the Dashboard so it loads nothing from the internet
 * (spec #130, What changed). Markdown with raw HTML off, as every note the Dashboard renders.
 */
export function ReleaseNotes({ notes }: { notes: string }) {
  return notes.trim() ? <Markdown text={notes} className="release-notes" /> : <p className="small muted">This release came without notes.</p>;
}

/**
 * The brass dot that means a decision waits for the owner: the logo's dot, 8 px, inside the Dashboard.
 * It sits only beside a count of decisions or on a pointer to them (a nav entry, the Inbox heading, a waiting
 * Proposal), never on a row, a Heads-up, or anything new, changed, overdue or done.
 * It is named "needs you" for a screen reader unless `label` says more, or `decorative` when the words beside it
 * already say it.
 */
export function AttentionDot({ label = "needs you", decorative = false }: { label?: string; decorative?: boolean }) {
  if (decorative) return <span className="attention-dot" aria-hidden />;
  return <span className="attention-dot" role="img" aria-label={label} />;
}

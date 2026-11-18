/** API contract: the Decision count's inputs as totals. */

/** The route that answers with `DecisionTotals`. */
export const DECISION_COUNT_PATH = "/decision-count";

/** A part whose feature is switched off: not asked, so not zero either. */
export type Off = "off";

/**
 * `GET /decision-count`: the four inputs of the Decision count as totals over everything this Machine holds, so the
 * count is exact above any list limit. Drafts do not replicate, so these are this Machine's.
 *
 * An Inbox item and its waiting Draft are one decision, and it is the Draft's: `inbox` already leaves out the open
 * items whose Draft waits, so `inbox + drafts` counts each decision once.
 */
export interface DecisionTotals {
  /** Open Inbox items whose Draft does not wait (no Draft, or one finished or being sent); off with Attention off. */
  inbox: number | Off;
  /** Drafts in `WAITING_ACTION_STATUSES`, whatever their item's state; off with Drafts off. */
  drafts: number | Off;
  /** Proposals in `proposed`. Proposals have no feature switch, so this is always a number. */
  proposals: number;
  /** Connections in `needs_auth`. */
  signIns: number;
}

import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { ActionView, ProposalView } from "@attache/contracts";
import { entryId, withDecided, type Entry } from "../approvals.ts";

/**
 * What the owner decided during one visit to Approvals, kept by the page for as long as it is open (across its
 * tabs), so a decided row stays as one line in its place until the next visit.
 * A row is held in place from the moment the owner decides, before the service answers: a live refresh that drops it
 * from the list first cannot take its place away.
 */
export type Decision<T> = { state: "pending"; row: T } | { state: "done"; words: string; subject: string; note?: string };

export interface DecisionLog<T extends { id: string }> {
  decisions: ReadonlyMap<string, Decision<T>>;
  /** The ids the list showed last, in order, so a held or decided row keeps its place. */
  shown: MutableRefObject<string[]>;
  /** The owner decided: hold the row where it is until the answer. */
  begin: (row: T) => void;
  /** The service took the decision: the row becomes its one line. */
  finish: (id: string, done: Omit<Extract<Decision<T>, { state: "done" }>, "state">) => void;
  /** The decision did not happen (refused, failed): the row is the live one again. */
  drop: (id: string) => void;
}

function useDecisionLog<T extends { id: string }>(): DecisionLog<T> {
  const [decisions, setDecisions] = useState<ReadonlyMap<string, Decision<T>>>(new Map());
  const shown = useRef<string[]>([]);
  const begin = useCallback((row: T) => setDecisions((m) => new Map(m).set(row.id, { state: "pending", row })), []);
  const finish = useCallback<DecisionLog<T>["finish"]>((id, done) => setDecisions((m) => new Map(m).set(id, { state: "done", ...done })), []);
  const drop = useCallback((id: string) => setDecisions((m) => new Map([...m].filter(([k]) => k !== id))), []);
  return useMemo(() => ({ decisions, shown, begin, finish, drop }), [decisions, begin, finish, drop]);
}

export interface ApprovalsVisit {
  drafts: DecisionLog<ActionView>;
  proposals: DecisionLog<ProposalView>;
  /** The row decided last by a click, whose line takes focus. */
  justDecided: string | null;
  setJustDecided: (id: string | null) => void;
  /** Why the service refused to apply a Proposal, by id, while it stands. */
  refusals: ReadonlyMap<string, string>;
  refuse: (id: string, reason: string) => void;
}

export function useApprovalsVisit(): ApprovalsVisit {
  const drafts = useDecisionLog<ActionView>();
  const proposals = useDecisionLog<ProposalView>();
  const [justDecided, setJustDecided] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(new Map());
  const refuse = useCallback((id: string, reason: string) => setRefusals((m) => new Map(m).set(id, reason)), []);
  return { drafts, proposals, justDecided, setJustDecided, refusals, refuse };
}

/** A list's rows with the ones decided (or being decided) in this visit kept in place; remembers what it showed. */
export function shownEntries<T extends { id: string }>(log: DecisionLog<T>, live: readonly T[]): Array<Entry<T, Decision<T>>> {
  const entries = withDecided(log.shown.current, live, log.decisions);
  log.shown.current = entries.map(entryId);
  return entries;
}

/**
 * The failure a list of the Inbox/Drafts pair shows (pure, `test/pair.test.ts`). The pair's good answers are applied
 * together, so a decision is never counted twice or not at all; a failure is not held back that way: it shows at
 * once. It then stays until the pair has settled again with a good answer, also while its Retry is under way and
 * when the Retry answers before the other list: the last settled pair is older than the failure and must not stand
 * in for it.
 */
export function pairFailure<E>(previous: E | null, own: { loading: boolean; error: E | null }, pairSettled: boolean): E | null {
  if (own.error) return own.error;
  return pairSettled ? null : previous;
}

/**
 * Where searching the Brain starts: `Ctrl K`, `Cmd K` or `/`, the masthead's launcher off Home and the bottom bar's
 * Search. On Home they focus Home's own field (#21 of spec #14); everywhere else the shell opens the search
 * palette (#34), the same search in a dialog.
 */

/** Home's search field (#21). */
export const HOME_SEARCH_ID = "home-search";

/** Focuses Home's search field. */
export function focusHomeSearch(): void {
  const home = document.getElementById(HOME_SEARCH_ID);
  home?.focus();
  home?.scrollIntoView({ block: "nearest" });
}

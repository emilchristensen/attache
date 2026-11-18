import { navigate } from "./components/ui.tsx";

/**
 * Where searching the Brain starts: `Ctrl K`, `Cmd K` or `/`, the masthead's launcher off Home and the bottom bar's
 * Search. On Home it focuses Home's own field; elsewhere it takes the owner to the Brain's search field, until the
 * search palette (#34 of spec #14) opens the same search in place.
 */

/** Home's search field (#21). */
export const HOME_SEARCH_ID = "home-search";
/** The Brain's search field, which the launcher focuses off Home. */
export const BRAIN_SEARCH_ID = "brain-search";

let focusOnArrival = false;

export function launchSearch(): void {
  const home = location.pathname === "/" ? document.getElementById(HOME_SEARCH_ID) : null;
  if (home) {
    home.focus();
    home.scrollIntoView({ block: "nearest" });
    return;
  }
  const field = document.getElementById(BRAIN_SEARCH_ID);
  if (field && location.pathname === "/brain") {
    field.focus();
    return;
  }
  focusOnArrival = true;
  navigate("/brain");
}

/** Whether the Brain should focus its search field as it opens: once, after the launcher sent the owner there. */
export function takeSearchFocus(): boolean {
  const take = focusOnArrival;
  focusOnArrival = false;
  return take;
}

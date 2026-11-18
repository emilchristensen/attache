import { navigate } from "./components/ui.tsx";

/**
 * The explicit search launcher (the masthead off Home, the bottom bar's Search): it takes the owner to the
 * Brain's search field. Home's own field (#21) and the search palette (#34 of spec #14) replace where it goes.
 */

/** The Brain's search field, which the launcher focuses. */
export const BRAIN_SEARCH_ID = "brain-search";

let focusOnArrival = false;

export function launchSearch(): void {
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

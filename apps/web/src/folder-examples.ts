import type { SetupDefaults } from "@jarvis/contracts";
import { useResource } from "./live.ts";

const NONE: SetupDefaults["examples"] = { notes: "", brain: "" };

/**
 * Example folder paths for empty folder fields, from the service: they are on
 * the computer Jarvis runs on, which may not be the one this browser runs on.
 * Empty until they arrive, so a field never shows another platform's path.
 * `wanted` false skips the request for a form that shows no folder field.
 */
export function useFolderExamples(wanted = true): SetupDefaults["examples"] {
  return useResource<SetupDefaults>(wanted ? "/setup/defaults" : null).data?.examples ?? NONE;
}

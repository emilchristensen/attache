import type { SetupDefaults } from "@jarvis/contracts";
import { pathFor, platformLocations, type PlatformLocations } from "./locations.ts";

/** The suggested data folder and example folders, in the owner's Documents folder and with this operating system's separators. */
export function folderSuggestions(loc: PlatformLocations = platformLocations()): SetupDefaults {
  const { join } = pathFor(loc.os);
  return {
    home: loc.home,
    suggestion: join(loc.documentsDir, "Jarvis"),
    examples: { notes: join(loc.documentsDir, "Notes"), brain: join(loc.documentsDir, "Brain") },
  };
}

/**
 * `CHANGELOG.md` holds one section per version, headed `## <version>`, newest
 * first. A section's text is the release notes: the release workflow copies it
 * into the signed manifest and the GitHub release, so both say the same thing.
 */

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The notes under `## <version>` (up to the next `## ` heading), or null when there is no such section. */
export function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const heading = new RegExp(`^## ${escape(version)}(\\s.*)?$`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  return body ? `${body}\n` : "";
}

/** What is wrong with the changelog for this version, or null when it has notes for it. */
export function changelogProblem(changelog, version) {
  if (changelog === null) return `There is no CHANGELOG.md. Add one with a "## ${version}" section holding the release notes.`;
  const notes = changelogSection(changelog, version);
  if (notes === null) return `CHANGELOG.md has no section for ${version}. Add a "## ${version}" section with the release notes for owners, commit it and tag that commit.`;
  if (!notes) return `CHANGELOG.md's section for ${version} is empty. Write the release notes for owners under "## ${version}".`;
  return null;
}

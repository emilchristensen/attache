/**
 * A meeting capture as the owner's meeting export writes it into the Brain:
 * frontmatter tagged as a meeting, then the meeting's notes and transcript quoted.
 */
export function meetingCapture(title: string, lines: readonly string[], tags: readonly string[] = ["granola", "meeting-transcript"]): string {
  return [
    "---",
    "id: 3f1c2a4e-0000-4000-8000-000000000001",
    "type: capture",
    `title: "${title}"`,
    "captured_at: 2026-11-11T08:29:38.048Z",
    "provenance: captured",
    "source:",
    "  kind: import",
    "  ref: https://notes.example.com/d/standup",
    "  observed_at: 2026-11-11T08:29:38.048Z",
    "  label: Meeting export",
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "---",
    `# ${title}`,
    "",
    ...lines.map((l) => (l ? `> ${l}` : ">")),
    "",
    "Source: Meeting export (import: https://notes.example.com/d/standup, observed 2026-11-11)",
    "",
  ].join("\n");
}

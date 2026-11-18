/**
 * The Dashboard's one icon set: rounded line icons on a 24 px grid at a 1.8 stroke, drawn to match the logo's handle.
 * Inline SVG, no icon package. An icon never replaces a word: it is decorative (`aria-hidden`) and a label sits beside it.
 * Kind glyphs follow `docs/design/dashboard-blind-astra/DESIGN.md` (the Inbox table); the kind-to-type map picks them.
 */
const PATHS = {
  // Screens
  home: <path d="M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5" />,
  approvals: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5.1" />
    </>
  ),
  brain: (
    <>
      <path d="M5 4h10.5A2.5 2.5 0 0 1 18 6.5V20H7.5A2.5 2.5 0 0 1 5 17.5z" />
      <path d="M5 17.5A2.5 2.5 0 0 1 7.5 15H18M9 8h5" />
    </>
  ),
  jobs: <path d="M3 12h4l2.5-6.5 5 13L17 12h4" />,
  connections: <path d="M9 3v4M15 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4" />,
  settings: (
    <>
      <path d="M4 7h7M16 7h4M4 17h4M13 17h7" />
      <circle cx="13.5" cy="7" r="2.5" />
      <circle cx="10.5" cy="17" r="2.5" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 14 5.4 5.7A1.5 1.5 0 0 1 6.8 4.6h10.4a1.5 1.5 0 0 1 1.4 1.1L21 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
      <path d="M3 14h4.8l1.2 2.2h6l1.2-2.2H21" />
    </>
  ),
  // Actions and navigation
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </>
  ),
  check: <path d="m4.5 12.5 4.8 4.8L19.5 7" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  external: <path d="M14 4h6v6M20 4l-9 9M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r=".9" />
      <circle cx="12" cy="12" r=".9" />
      <circle cx="18.5" cy="12" r=".9" />
    </>
  ),
  /** This Machine: a laptop. */
  machine: (
    <>
      <rect x="5" y="5" width="14" height="10" rx="1.5" />
      <path d="M3 19h18" />
    </>
  ),
  // Kinds of Inbox item
  /** Review request: a branch fork. */
  fork: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="5.5" r="2" />
      <path d="M6.5 7.5v9M17.5 7.5v1.5a4 4 0 0 1-4 4h-3a4 4 0 0 0-4 3.5" />
    </>
  ),
  /** Authored PR: a pull request. */
  "pull-request": (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="18.5" r="2" />
      <path d="M6.5 7.5v9M17.5 16.5V10a3 3 0 0 0-3-3H12M14 4.5 11.5 7 14 9.5" />
    </>
  ),
  /** Assigned issue and Jira work: a square checklist. */
  checklist: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="m7.5 9 1.5 1.5L11.5 8M7.5 15l1.5 1.5 2.5-2.5M14 9.5h3M14 15.5h3" />
    </>
  ),
  /** Pending reply: an envelope with a return arrow. */
  envelope: (
    <>
      <path d="M20 11V6.5A1.5 1.5 0 0 0 18.5 5h-13A1.5 1.5 0 0 0 4 6.5v10A1.5 1.5 0 0 0 5.5 18H12" />
      <path d="m4.5 6 7.5 6 7.5-6M21 20h-4a2.5 2.5 0 0 1 0-5h1.5M19 13l-2 2 2 2" />
    </>
  ),
  /** Mention: an at sign. */
  at: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M15.5 8.5v4.8a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7" />
    </>
  ),
  /** Slack DM: a speech bubble. */
  bubble: <path d="M5.5 4.5h13A1.5 1.5 0 0 1 20 6v9a1.5 1.5 0 0 1-1.5 1.5H10L6 20v-3.5h-.5A1.5 1.5 0 0 1 4 15V6a1.5 1.5 0 0 1 1.5-1.5z" />,
  /** Slack mention: an at sign in a bubble. */
  "at-bubble": (
    <>
      <path d="M5.5 4.5h13A1.5 1.5 0 0 1 20 6v9a1.5 1.5 0 0 1-1.5 1.5H10L6 20v-3.5h-.5A1.5 1.5 0 0 1 4 15V6a1.5 1.5 0 0 1 1.5-1.5z" />
      <circle cx="12" cy="10.5" r="1.8" />
      <path d="M13.8 8.7v2.3a1.2 1.2 0 0 0 2.4 0v-.5a4.2 4.2 0 1 0-1.7 3.4" />
    </>
  ),
  /** Invite response: a calendar with a question. */
  "calendar-question": (
    <>
      <path d="M20 11V7a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 4 7v11.5A1.5 1.5 0 0 0 5.5 20H12M4 10h16M8 3.5v4M16 3.5v4" />
      <path d="M15.5 15.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4M17.5 20.6v.1" />
    </>
  ),
  /** Meeting prep: a calendar with notes. */
  "calendar-notes": (
    <>
      <path d="M5.5 5.5h13A1.5 1.5 0 0 1 20 7v11.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5V7a1.5 1.5 0 0 1 1.5-1.5z" />
      <path d="M4 10h16M8 3.5v4M16 3.5v4M8 13.5h8M8 16.5h5" />
    </>
  ),
  /** A plain calendar (a meeting Heads-up, Google Calendar). */
  calendar: (
    <>
      <path d="M5.5 5.5h13A1.5 1.5 0 0 1 20 7v11.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5V7a1.5 1.5 0 0 1 1.5-1.5z" />
      <path d="M4 10h16M8 3.5v4M16 3.5v4" />
    </>
  ),
  /** Deadline: a clock. */
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.5l3.5 2" />
    </>
  ),
  /** Jira work item: a ticket. */
  ticket: <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4zM14.5 6v12" />,
  /** Fact to check: a dated page. */
  "dated-page": (
    <>
      <path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3.5V8h4.5M8.5 12.5h7M8.5 16h2.5M13.5 16h2" />
    </>
  ),
  /** Replication: a document split in two versions. */
  "split-page": (
    <>
      <path d="M11 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5H11M13 3.5h4.5A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5H13" />
      <path d="m12 3 0 2M12 8v2M12 13v2M12 18v2M8 9h1M15 9h1M8 13h1M15 13h1" />
    </>
  ),
  /** Replication blocked: two arrows against a bar. */
  "blocked-arrows": <path d="M3.5 8h11M11.5 5l3 3-3 3M20.5 16h-11M12.5 13l-3 3 3 3M18 4.5v7M6 12.5v7" />,
  /** A kind the Dashboard does not know: a plain document. */
  document: (
    <>
      <path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3.5V8h4.5M8.5 12.5h7M8.5 16h7" />
    </>
  ),
  // Approvals
  /** Drafts to send: a pen. */
  pen: (
    <>
      <path d="m4 20 .9-4.4L15.6 4.9a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L8.4 19.1z" />
      <path d="m14 6.5 3.5 3.5" />
    </>
  ),
  /** Changes to the Brain (a Proposal): a page with a change mark. */
  change: (
    <>
      <path d="M5 4h10.5A2.5 2.5 0 0 1 18 6.5V20H7.5A2.5 2.5 0 0 1 5 17.5z" />
      <path d="M9 9h5M9 13h2M15 12.5v4M13 14.5h4" />
    </>
  ),
  // For you now and status
  /** The morning briefing: a low sun on the horizon. */
  sun: <path d="M3 17h18M6.5 14a5.5 5.5 0 0 1 11 0M12 3.5v3M4.5 7l2.2 1.8M19.5 7l-2.2 1.8" />,
  /** Sign-in needed. */
  key: (
    <>
      <circle cx="8" cy="15.5" r="3.8" />
      <path d="M10.8 12.8 19.5 4M16 7.5l2.5 2.5" />
    </>
  ),
  /** A service failure. */
  warning: <path d="M12 3.8 21 19.5H3zM12 10v4M12 17v.1" />,
  /** Unknown coverage. */
  question: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.6M12 16.8v.1" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** One icon at 16 px (or `size`), in the current text colour. */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      {PATHS[name]}
    </svg>
  );
}

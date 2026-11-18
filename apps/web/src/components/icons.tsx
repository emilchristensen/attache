/**
 * The Dashboard's one icon set: 16 px line icons at a 1.7 stroke with round caps, drawn to match the logo's handle.
 * Inline SVG, no icon package. An icon never replaces a word: it is decorative (`aria-hidden`) and a label sits beside it.
 */
const PATHS = {
  // Screens
  home: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
    </>
  ),
  approvals: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <path d="m5.3 8.2 1.9 1.9 3.5-3.9" />
    </>
  ),
  brain: (
    <>
      <path d="M3 2.5h7.5a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2z" />
      <path d="M3 11.5a2 2 0 0 1 2-2h7.5M6 5.5h3.5" />
    </>
  ),
  draft: (
    <>
      <path d="m2.5 13.5.6-3 7.6-7.6a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2L5.5 12.9z" />
      <path d="m9.5 4 2.5 2.5" />
    </>
  ),
  jobs: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  connections: <path d="M6 2v3M10 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14" />,
  settings: (
    <>
      <path d="M2 4.5h5M11 4.5h3M2 11.5h3M9 11.5h5" />
      <circle cx="9" cy="4.5" r="1.8" />
      <circle cx="7" cy="11.5" r="1.8" />
    </>
  ),
  inbox: (
    <>
      <path d="M2 9.5 3.6 3.6A1 1 0 0 1 4.6 3h6.8a1 1 0 0 1 1 .6L14 9.5v2.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
      <path d="M2 9.5h3.2l.8 1.5h4l.8-1.5H14" />
    </>
  ),
  // Actions and navigation
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  check: <path d="m3 8.5 3.2 3.2L13 4.8" />,
  chevron: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  external: <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r=".6" />
      <circle cx="8" cy="8" r=".6" />
      <circle cx="12.5" cy="8" r=".6" />
    </>
  ),
  // One per Inbox type family
  flag: <path d="M4 14V2.5M4 3h7.5L10 5.5 11.5 8H4" />,
  "pull-request": (
    <>
      <circle cx="4.5" cy="4" r="1.5" />
      <circle cx="4.5" cy="12" r="1.5" />
      <circle cx="11.5" cy="12" r="1.5" />
      <path d="M4.5 5.5v5M11.5 10.5V7a2 2 0 0 0-2-2H8M9.5 3.5 8 5l1.5 1.5" />
    </>
  ),
  reply: <path d="M6.5 4 3 7.5 6.5 11M3 7.5h6a4 4 0 0 1 4 4v.5" />,
  at: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M10.5 5.5v3.2a1.6 1.6 0 0 0 3.2 0V8a5.7 5.7 0 1 0-2.3 4.6" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  ticket: <path d="M2.5 5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1.5a1.5 1.5 0 0 0 0 3V11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9.5a1.5 1.5 0 0 0 0-3zM9.5 4v8" />,
  fact: (
    <>
      <path d="M3 2.5h7.5a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2z" />
      <path d="m5.8 7.4 1.5 1.5 2.6-3" />
    </>
  ),
  sync: <path d="M13 8a5 5 0 0 1-8.5 3.5M3 8a5 5 0 0 1 8.5-3.5M11.5 2v2.5H9M4.5 14v-2.5H7" />,
  // For you now and status
  spark: <path d="M8 2c.4 3 1.6 5.6 6 6-4.4.4-5.6 3-6 6-.4-3-1.6-5.6-6-6 4.4-.4 5.6-3 6-6z" />,
  key: (
    <>
      <circle cx="5.5" cy="10.5" r="2.5" />
      <path d="M7.3 8.7 13 3M10.5 5.5l2 2" />
    </>
  ),
  alert: <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.3v.2" />,
};

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** One icon at 16 px (or `size`), in the current text colour. */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      {PATHS[name]}
    </svg>
  );
}

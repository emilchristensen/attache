import { useId } from "react";

/**
 * The Attache mark: an attaché case with a dot that needs your attention.
 * Its colours are its own (`.logo` in styles.css), not the theme's; the gaps are cut out, so it sits on any background.
 * The same drawing, on a dark tile, is `public/favicon.svg` and `docs/assets/logo.svg`.
 */
export function Logo({ size = 26 }: { size?: number }) {
  const cut = useId();
  return (
    <svg className="logo" width={size} height={size} viewBox="6 6 52 52" aria-hidden focusable="false">
      <mask id={cut}>
        <rect x="0" y="0" width="64" height="64" fill="#fff" />
        <rect x="0" y="31" width="64" height="3" fill="#000" />
        <rect x="18" y="28" width="6" height="9" rx="2" fill="#000" />
        <rect x="40" y="28" width="6" height="9" rx="2" fill="#000" />
        <circle cx="51" cy="19" r="9" fill="#000" />
      </mask>
      <g mask={`url(#${cut})`} className="logo-case">
        <path d="M25 20v-4a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v4" fill="none" strokeWidth="4" strokeLinecap="round" />
        <rect x="8" y="19" width="48" height="33" rx="7" />
      </g>
      <circle className="logo-dot" cx="51" cy="19" r="6" />
    </svg>
  );
}

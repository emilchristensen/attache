---
name: Attache Dashboard
description: A reading desk for a single working day, in warm paper and blue-black ink.
colors:
  warm-desk-paper: "#f7f6ef"
  fresh-sheet: "#fffef8"
  sunken-step: "#ecece6"
  morning-amber: "#f7dfaf"
  blue-black-ink: "#192d32"
  ink-secondary: "#46595b"
  ink-meta: "#526466"
  rule: "#d3d8d0"
  control-line: "#798482"
  deep-teal-key: "#204d57"
  focus-blue: "#164d84"
  clasp-brass: "#a8701f"
  clasp-brass-ink: "#7a4d00"
  danger-red: "#a3261c"
  hue-blue: "#164d84"
  hue-blue-soft: "#e3e9ea"
  hue-rust: "#8a3d22"
  hue-rust-soft: "#f1e7de"
  hue-plum: "#713760"
  hue-plum-soft: "#eee6e6"
  hue-green: "#215b48"
  hue-green-soft: "#e4eae3"
  hue-amber: "#7a4d00"
  hue-amber-soft: "#efe9da"
  hue-red: "#a3261c"
  hue-red-soft: "#f4e4de"
  hue-slate: "#4d5e66"
  hue-slate-soft: "#eaebe6"
  case-copper: "#ba6249"
  logo-brass: "#c38942"
  dark-deep-green-slate: "#192628"
  dark-sheet: "#202f32"
  dark-sunken-step: "#263233"
  dark-morning-amber: "#43351e"
  dark-pale-ink: "#f6f3de"
  dark-ink-secondary: "#c0d0c9"
  dark-ink-meta: "#a9bab4"
  dark-rule: "#435554"
  dark-control-line: "#91aaa3"
  dark-key: "#b4ded9"
  dark-focus-blue: "#a1cdff"
  dark-clasp-brass: "#d9a55a"
  dark-clasp-brass-ink: "#f3c97a"
  dark-danger-red: "#ffaca3"
typography:
  brand:
    fontFamily: "Georgia, 'Times New Roman', 'DejaVu Serif', serif"
    fontSize: "27px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.04em"
  display:
    fontFamily: "Georgia, 'Times New Roman', 'DejaVu Serif', serif"
    fontSize: "36px"
    fontWeight: 500
    lineHeight: "42px"
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Georgia, 'Times New Roman', 'DejaVu Serif', serif"
    fontSize: "29px"
    fontWeight: 500
    lineHeight: "35px"
    letterSpacing: "-0.02em"
  headline-detail:
    fontFamily: "Georgia, 'Times New Roman', 'DejaVu Serif', serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: "28px"
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "22px"
    letterSpacing: "-0.01em"
    fontFeature: "'cv11', 'ss03'"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "23px"
    fontFeature: "'cv11', 'ss03'"
  control:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
    fontFeature: "'cv11', 'ss03'"
  meta:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "19px"
    fontFeature: "'cv11', 'ss03', 'tnum'"
  label:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "18px"
    letterSpacing: "0.06em"
rounded:
  tag: "4px"
  sm: "6px"
  stamp: "8px"
  card: "10px"
  pill: "999px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "36px"
  s-7: "48px"
components:
  button-primary:
    backgroundColor: "{colors.blue-black-ink}"
    textColor: "{colors.warm-desk-paper}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.fresh-sheet}"
    textColor: "{colors.blue-black-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.sunken-step}"
  button-ghost:
    textColor: "{colors.ink-secondary}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
  button-small:
    typography: "{typography.meta}"
    rounded: "{rounded.sm}"
    padding: "3px 9px"
  input:
    backgroundColor: "{colors.fresh-sheet}"
    textColor: "{colors.blue-black-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  search-field:
    backgroundColor: "{colors.fresh-sheet}"
    textColor: "{colors.deep-teal-key}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: "0 16px"
    height: "54px"
  nav-link:
    textColor: "{colors.ink-secondary}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "8px 9px"
  nav-link-current:
    backgroundColor: "{colors.blue-black-ink}"
    textColor: "{colors.warm-desk-paper}"
  chip:
    textColor: "{colors.ink-secondary}"
    typography: "{typography.control}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "36px"
  chip-selected:
    backgroundColor: "{colors.blue-black-ink}"
    textColor: "{colors.warm-desk-paper}"
  tag:
    backgroundColor: "{colors.sunken-step}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.tag}"
    padding: "0 7px"
    height: "20px"
  tag-attention:
    textColor: "{colors.clasp-brass-ink}"
    rounded: "{rounded.tag}"
    padding: "0 7px"
    height: "20px"
  type-stamp:
    rounded: "{rounded.stamp}"
    size: "34px"
  card:
    backgroundColor: "{colors.fresh-sheet}"
    rounded: "{rounded.card}"
    padding: "14px 16px"
  feature-spread:
    backgroundColor: "{colors.morning-amber}"
    textColor: "{colors.blue-black-ink}"
    rounded: "{rounded.card}"
    padding: "18px 24px"
  attention-dot:
    backgroundColor: "{colors.clasp-brass}"
    rounded: "{rounded.pill}"
    size: "8px"
---

# Design System: Attache Dashboard

## Overview

**Creative North Star: "The Reading Desk"**

The Dashboard is a desk laid out for one working day.
Warm paper sits under blue-black ink, the search field is the first thing within reach, what is timely now gets one sheet of its own, and recurring work reads like a ruled index.
The owner should recognise a request from its left edge and decide from its subject whether to read further.

The mood is calm, exact and literate.
Calm, because nothing pulses, shimmers, slides or re-sorts on its own, and an empty or healthy state is one quiet line rather than a celebration.
Exact, because every time is in tabular figures, every count is precise or written as a lower bound, and every state is said in words beside its glyph.
Literate, because Georgia gives page and section titles an editorial cadence while Inter keeps everything the owner acts on plain.

Density is that of a well-set index: generous 14 px row padding, 1 px rules between rows, and one 1072 px reading column on every screen.
Dark mode is the same desk at night: the paper becomes deep green slate, the ink becomes pale cream, and the morning spread becomes amber-brown.
The theme follows the system and never offers its own toggle.

**Key Characteristics:**

- Warm paper canvas, a slightly brighter sheet for cards and fields, and blue-black ink.
- Georgia for page, section and detail titles; Inter for everything else; system mono for times, keys, paths and kind captions.
- Flat ruled rows on the canvas, square at their ends, separated by 1 px rules and grouped under a 2 px ink rule.
- Colour appears only in a kind's stamp and word, from seven role hues, and never alone.
- The brass Attention dot means one thing: a decision waits.
- Shadow only on what floats above the page.

## Colors

A warm, low-chroma paper-and-ink palette with seven muted role hues and one brass accent that is rationed to decisions.

All values live in `apps/web/src/styles/tokens.css`, and `apps/web/test/contrast.test.ts` measures every text pair (4.5:1) and non-text pair (3:1) in both themes on the surfaces they sit on.
Change a value there and nowhere else; the frontmatter mirrors it.

### Primary

- **Blue-Black Ink** (`blue-black-ink`): the strongest text, the solid primary button, the current screen's tab in the masthead, a selected chip, and the 2 px rule over every list and ruled section title.
  In dark mode it becomes **Pale Ink** (`dark-pale-ink`), and the primary button inverts with it.
- **Deep Teal Key** (`deep-teal-key`): links, the edge of every text field (9:1 on the sheet, so the field's position never depends on a tint), the search field's edge and icon, and the left rule on a Markdown quote.

### Secondary

- **Clasp Brass** (`clasp-brass`): the Attention dot only, beside the logo and beside a decision count.
  **Clasp Brass Ink** (`clasp-brass-ink`) is the brass that text can use, in an attention tag on a 14% brass tint.
- **Morning Amber** (`morning-amber`): the feature spread behind a lead morning briefing in For you now, and nothing else.

### Tertiary

The seven role hues each have a strong step (the kind word, the stamped glyph, a tag's words) and a soft step (the stamp's or tag's tint, 12% of the hue on paper in light, 16% in dark).
A component never names a hue's tokens: it puts `hueClass(hue)` from `apps/web/src/theme/hues.ts` on an element, and everything inside reads `--c` and `--c-soft`.

- **Blue** (`hue-blue`): reviews, pull requests, meetings and Jira work; also a Draft in Approvals.
- **Rust** (`hue-rust`): replies, deadlines and Replication; also the contour of the sun on the morning spread.
- **Plum** (`hue-plum`): mentions and direct messages; also a Proposal in Approvals.
- **Green** (`hue-green`): assigned work, invites and facts to check.
- **Amber** (`hue-amber`): something the owner can fix, or something only partly read.
- **Red** (`hue-red`): failed or refused.
- **Slate** (`hue-slate`): not known.

### Neutral

- **Warm Desk Paper** (`warm-desk-paper`): the page canvas, behind every list.
- **Fresh Sheet** (`fresh-sheet`): cards, fields, the masthead band, dialogs, the note reader and job detail.
- **Sunken Step** (`sunken-step`): code blocks, keys, a plain tag's fill, the secondary button's hover, still loading placeholders.
- **Ink Secondary** (`ink-secondary`) and **Ink Meta** (`ink-meta`): secondary text, then metadata, source lines and quiet state words.
- **Rule** (`rule`): decorative 1 px lines between rows and around cards.
- **Control Line** (`control-line`): the outline of a secondary button, a chip and an outlined tag, at 3:1 or better.
- **Focus Blue** (`focus-blue`): the focus ring and only the focus ring; under forced colours it becomes the system's `Highlight`.
- **Danger Red** (`danger-red`): error text, a field with a problem, a danger button's words.
- **Case Copper** (`case-copper`) and **Logo Brass** (`logo-brass`): the logo's own colours, identical in both themes and never used for text.
- Row states are ink at low alpha: hover at 4% (`--row-hover`), selected at 8% (`--row-on`); in dark mode pale ink at 5% and 10%.

### Named Rules

**The Brass Means Decide Rule.** The Attention dot follows the Decision count and nothing else.
It never means new, unread, changed or offline, and brass is never used as a general accent.

**The Colour Lives in the Stamp Rule.** A row's hue appears only in its kind stamp and kind word.
Rows keep flat 1 px rules: no tinted group headers, no coloured side bars, no tinted row backgrounds.

**The Never Alone Rule.** A hue always comes with a glyph and a word, so every kind stays distinguishable in grayscale and under colour-vision simulation.

**The Healthy Is Quiet Rule.** A working state is a word in Ink Meta and nothing more.
Tags are for exceptions only, and there is no green "OK" tag.

## Typography

**Display Font:** Georgia (with Times New Roman, DejaVu Serif, serif), the system's own, never downloaded.
**Body Font:** Inter (with -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif), one variable Latin face bundled by Attache and capped at 150 KB.
**Label/Mono Font:** the system monospace (ui-monospace, SF Mono, Menlo, Consolas).

**Character:** Georgia gives page titles and section names the cadence of a well-set document, and Inter keeps subjects, controls and body text plain and legible.
Inter runs with its single-storey a and open digits (`cv11`, `ss03`), and no synthetic bold or italic.

### Hierarchy

- **Brand** (Georgia 700, 27 px, line height 1, -0.04em): "Attache" beside the logo in the masthead; 30 px in Setup, with "setup" after it at weight 400 in Ink Secondary.
- **Display** (Georgia 500, 36 px / 42 px, -0.02em): the one page title (h1) per screen, often followed on the same line by a short Ink Secondary sentence saying what the screen holds.
- **Headline** (Georgia 500, 29 px / 35 px, -0.02em): section headings (h2), such as For you now, Inbox, Drafts to send, Running and Finished, and a lead Heads-up's subject.
- **Headline Detail** (Georgia 500, 22 px / 28 px): the title of the one thing a detail pane shows (a note, a job).
- **Title** (Inter 600, 16 px / 22 px, -0.01em): row subjects, card headings (h3), a disclosure's title.
- **Body** (Inter 400, 16 px / 23 px): running text, field values, a Draft's text as its reading surface.
- **Control** (Inter 500, 14 px / 20 px): buttons, navigation, tabs, chips, field labels' companions.
- **Meta** (Inter 400, 13 px / 19 px): source lines, help text, times standing on their own, state words.
- **Label** (mono 600, 12 px / 18 px, 0.06em, uppercase): the kind over a detail title (PERSON, MEETING CAPTURE), the Home breadcrumb with the date, a results group heading (PASSAGES).
- **Mono** (13 px): times in timelines, paths, file and line citations, keys (`kbd` at 500 12 px on the sheet with a Control Line inset).

### Named Rules

**The Two Voices Rule.** Georgia names places: the page, its sections, the thing being read.
Inter carries everything the owner reads in a row or acts on.
Never set a button, row subject or field in Georgia.

**The Tabular Times Rule.** Every `time` and every count uses tabular figures, so times line up down a list and a count never jitters as it changes.

**The Roman Quotes Rule.** The bundled face has no italic, so quotes and emphasis stay roman; a quote is marked by its rule or its label, never by slanting.

## Layout

Every screen sits in one reading column: 1072 px at most, centred inside 36 px gutters (16 px at 720 px and below).
The masthead, any frame-wide notice and the page share that column, and every row of the frame reserves the same scrollbar gutter, so the mark, a notice and the content start at the same x.
The page is the only scroller.
A narrower 824 px column holds the long forms of Connections and Settings.

Spacing runs on a 4 px base: 4, 8, 12, 16, 24, 36 and 48 px.
Groups of controls wrap with 8 px between neighbours.
List rows take 14 px vertical padding, cards 14 x 16 px, a lead Heads-up 18 x 24 px.

A list beside its detail (Brain, Jobs, Settings) is a two-column split: the list at 260 to 340 px, a 18 px gap, then the detail.
On a wide window the detail sticks under the masthead and scrolls on its own; at 720 px and below it stacks under the list and scrolls with the page.

Breakpoints:

- At 1120 px and below the masthead tightens (brand 24 px) and its Search and this Machine's button keep their icons and lose their words.
- At 960 px and below a bottom bar takes the screens (Home, Approvals, Search, Brain, More), and the masthead drops to 56 px with only the mark (brand 22 px), plus this Machine only while the live connection is lost.
- At 720 px and below the gutters drop to 16 px, the page title to 30 / 36 px, section headings to 26 / 31 px, and splits stack.
- Below 320 px, while the connection is lost, the briefcase alone is the mark.
Everything works at 320 px and at 200% zoom with no sideways scrolling.
On a phone or with any coarse pointer, every control is a 44 x 44 px target.

### Screens

- **Home:** a compact heading (mono breadcrumb "HOME / TUESDAY 24 NOVEMBER"), the full-width search field with Browse beside it, For you now (a lead Heads-up card, compact follower lines, or one quiet ruled line when nothing is timely), the Connections line (one ruled line when all is good, otherwise a ruled head and one row per problem), then the Inbox as one continuous ruled list under its 2 px ink rule, and Recently added as a closing ruled line.
- **Inbox row:** a 185 px kind column (stamp and word), the subject over its source line, and the time right-aligned; the whole line is the click target, and an open row's detail lines up under the subject column.
  At 720 px and below the stamp and kind come first, then the whole subject, then source and time.
- **Approvals:** the page title with its sentence, Waiting and Finished tabs, then ruled groups (Drafts to send, Changes to the Brain), each headed by a small stamp, a Georgia heading and one sentence saying what deciding does.
  Rows follow the Inbox's grid.
- **A Draft's page:** Back to Approvals, the kind and destination, the Georgia title, a version line, a three-step line (Draft, Approved, Sent) with numbered circles joined by rules, the message it answers as a ruled quote, the text as a full-width field at reading size, then the decision buttons and, below, its context in disclosures.
- **Brain:** title with a menu button, the search field, Library and Recent saves tabs, then a three-part split: collections as plain words (one row of chips over the list at 960 px and below), a collection's notes as ruled rows, and the note reader as a sheet with ruled section titles (Current state, History).
- **Connections:** the Reader line, then groups (Notes, Work sources, Harnesses, Model) whose headings share the rows' four-column grid (name and state, account, may read and write, last read); each row opens in place, and what is not set up is a small outlined tile with a chevron.
  At 720 px and below the columns stack and each cell names itself.
- **Jobs:** the research field with Research and Diagnostics, then a quiet table of ruled groups (Running, Finished) beside the job detail sheet with ruled section titles (Result, Events).
- **Settings:** a section list in four labelled groups (Attache, Brain, Machines, Service) beside the one section the address names; at 960 px and below the list is Settings' first screen and a section replaces it, with the way back above.
- **Setup:** two panes, the large logo, "Attache setup" and five numbered steps on the left, the step's Georgia heading, sentence and form on the right, with Back and Continue held at the bottom of the window.
  Pairing and service recovery are one compact form, centred under the large logo.
- **Search palette:** off Home, a sheet near the top of the window with "Search the Brain", the same field and results, a Go to group of matching screens and Settings sections, and a footer saying how results were ranked.

### Named Rules

**The One Column Rule.** Nothing on any screen leaves the 1072 px column or its gutters, and no screen scrolls sideways.

**The Nothing Jumps Rule.** A place that will fill keeps its height while empty: Show new items holds its row, For you now keeps a quiet line, and an older query's results stay dimmed for their height until the new answer comes.

## Elevation & Depth

The Dashboard is flat at rest.
Depth comes from tone and line: the canvas, a brighter sheet with a 1 px rule for cards and detail panes, and the sunken step for code and keys.
A shadow means one thing: this layer floats above the page and will go away.
Toasts, dialogs and sheets, the search results under the field, menus that open under their button, this Machine's panel and the evidence panel carry it; nothing else does.
The search field's 3 px Rule-coloured underline is a ruled edge, not a shadow, and marks it as the page's first action.
Under a dialog the page dims behind a deep green-black backdrop at 60% (66% in dark).

### Shadow Vocabulary

- **Float** (`box-shadow: 0 1px 2px rgba(25, 45, 50, 0.06), 0 16px 40px -8px rgba(25, 45, 50, 0.18)`; dark `0 1px 2px rgba(0, 0, 0, 0.4), 0 18px 44px -8px rgba(0, 0, 0, 0.6)`): every floating layer.
- **Ruled edge** (`box-shadow: 0 3px 0 var(--rule)`): the search field only.

### Named Rules

**The Floating-Only Rule.** A shadow is never decoration.
If a layer does not float above the page and leave again, it has no shadow.

## Shapes

Corners are gentle and few: 6 px for buttons and fields, 4 px for tags and keys, 8 px for a kind stamp (6 px for the small 25 px stamp), and 10 px for cards, sheets, the search field, the lead Heads-up and dialogs.
Chips and the progress bar are fully round.
List rows are square, so the rule under each row runs straight to its ends.
Borders are 1 px: Rule for decoration, Control Line for a secondary control, Deep Teal Key for a field (1.5 px on the search field).
Section and list headings sit on a 2 px ink rule.
The one illustration is the morning spread's low sun: concentric rust contour rings at 28% opacity, clipped into the card's bottom-right margin, decorative only.

## Components

Plain and exact: one solid action, outlined alternatives, flat rows, and nothing on screen that does not say something.

### Buttons

- **Shape:** gently rounded (6 px), 36 px tall to match a one-line field beside it; 44 px with a coarse pointer.
- **Primary:** solid Blue-Black Ink with Warm Desk Paper text, 7 x 12 px; hover mixes 14% canvas into the ink.
  One primary action per decision.
- **Secondary:** Fresh Sheet with a 1 px Control Line edge and ink text; hover fills with the Sunken Step.
- **Ghost:** no fill or edge, Ink Secondary text; hover takes the 4% row tint and full ink.
  Used for Got it, Back and quiet actions.
- **Danger:** a secondary or ghost button with Danger Red words, never a red fill.
- **Small:** 3 x 9 px at the meta size.
- **Disabled:** 55% opacity with a not-allowed cursor; the button keeps its words, so Send v1 still says what it would do.

### Chips

- **Style:** fully round, 36 px tall, 1 px Control Line edge, Ink Secondary words at the control size.
- **State:** the chosen chip is solid ink with paper words; hover takes the row tint.
  Used for Recent saves' filters and the collections on a narrow screen, in one sideways-scrolling row.

### Tags

- **Style:** 20 px tall, 4 px corners, 600 12 px Inter, a Sunken Step fill and Ink Secondary words.
- **Variants:** attention (brass tint, Clasp Brass Ink), danger (red tint, Danger Red), outline (Control Line inset), and hue (the hue's tint and strong step), such as "Draft waiting", "unverified", "partly working" and "New person".

### Cards / Containers

- **Corner Style:** 10 px.
- **Background:** Fresh Sheet on the canvas, or transparent for a flat card.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1 px Rule.
- **Internal Padding:** 14 x 16 px; detail sheets (note reader, job detail) 24 px.

### Inputs / Fields

- **Style:** Fresh Sheet, 1 px Deep Teal Key edge, 6 px corners, 6 x 10 px padding at the body size; placeholders in Ink Meta.
- **Labels:** 500 13 px Ink Secondary above the field, with help text in Ink Meta.
- **Focus:** the shared 3 px Focus Blue ring, 1 px outside the edge.
- **Error:** a Danger Red edge doubled with an inset 1 px line, and below it the message in 500 13 px Danger Red with a warning glyph.
- **Checkboxes:** native, tinted with the primary ink, centred on the label's first line; the whole line is the target.

### Search field

The page's first action on Home and the Brain: 54 px tall, Fresh Sheet, a 1.5 px Deep Teal Key edge, 10 px corners, the ruled 3 px underline, a magnifier in the key colour and a `⌘ K` keycap that goes away when the field is narrow.
Results open under it, over the page, as a floating sheet whose rows show a title, a two-line snippet, then kind, part and the file and line in mono.

### Navigation

- **Masthead:** a Fresh Sheet band, 74 px tall, with a 1 px Rule under it: the copper briefcase and "Attache" in Georgia, then the six screens as Control-size links in Ink Secondary with 6 px corners.
- **Current screen:** a solid ink tab with paper words: shape and contrast, not colour alone.
- **Decision count:** beside a screen's name, the number in mono 600 12 px inside a 1 px box in the name's own colour.
- **Right side:** Search (off Home) and this Machine's button, both secondary buttons.
- **Bottom bar (960 px and below):** five icon-over-word targets; the current one is the solid ink tab; a count and the brass dot sit on the icon's corner.
- **Tabs:** Control-size words in Ink Meta on one row over a 1 px Rule; the selected tab is full ink over a 2 px ink underline.
  A row too wide for its column scrolls sideways and fades before an arrow.

### Ruled list rows

The signature pattern of every list: square rows on the canvas, 1 px Rule between them, a 2 px ink rule above the group.
Hover takes the 4% row tint.
Selected takes the 8% fill and a 3 px inset ink bar at the start, never an outline.
A decided row collapses to one line with Undo in its place.

### Kind stamp

A 34 px square with 8 px corners in a hue's soft tint, holding one 19 px rounded line glyph (stroke 1.8) in the hue's strong step, always followed by the kind word in 600 Inter in the same hue.
The small stamp is 25 px with 6 px corners.
Under forced colours the stamp keeps a 1 px `CanvasText` edge.

### Feature spread

Only a lead morning briefing in For you now: the card in Morning Amber with no edge, the low rust sun etched into its outer margin, its words held to 76% of the width (86% on a phone) so they clear the sun, and controls on it taking the field's stronger Deep Teal Key edge because the plain outline is under 3:1 on amber.

### Attention dot

An 8 px brass circle beside the logo, beside the Inbox heading's count and on the bottom bar's icon corner.
Under forced colours it stays drawn.

### States: loading, empty, partial, error

- **Loading:** still Sunken Step bars at 4 px corners: no shimmer, no pulse.
- **Empty:** a dashed Control Line box at 10 px corners, centred Ink Meta words, saying what was read.
- **Partial:** a solid amber edge, left-aligned, saying what could not be read.
- **Error:** a solid red edge with the failure in Danger Red bold and Retry; a failure is never shown as an empty list.
- **Toast:** a floating sheet at the bottom centre, at most 520 px, with a red edge for an error and a green edge for a success.

## Do's and Don'ts

### Do:

- **Do** take every colour from `apps/web/src/styles/tokens.css` and let `contrast.test.ts` prove it: 4.5:1 for text and 3:1 for edges in both themes.
- **Do** use `hueClass(hue)` and `--c` / `--c-soft` for a kind's colour, and pair every hue with its glyph and word.
- **Do** set page, section and detail titles in Georgia, and every row subject, control and field in Inter.
- **Do** put lists on the canvas as square ruled rows under a 2 px ink rule, and put detail on a Fresh Sheet with a 1 px Rule and 10 px corners.
- **Do** show focus as the 3 px Focus Blue outline and selection as an ink fill or inset ink bar, so the two can never be confused.
- **Do** keep the place of anything that will fill, so arrivals never move the list under the pointer.
- **Do** give every control a 44 x 44 px target on a phone or with a coarse pointer, and keep every screen working at 320 px and 200% zoom.
- **Do** stop every transition and animation under reduced motion; the only motion at all is a 0.15 s chevron turn and the progress bar's width.

### Don't:

- **Don't** use the brass dot or brass colour for anything but a waiting decision: not new, unread, changed, offline or decoration.
- **Don't** tint rows, group headers or side bars with a hue, or add a coloured bar to a row.
- **Don't** add a green tag for a healthy state; say the state quietly in words.
- **Don't** use the Morning Amber spread for anything but a lead morning briefing.
- **Don't** add a shadow to anything that does not float above the page.
- **Don't** add shimmer, pulse, auto-advancing cards, sliding transitions or animated re-sorting.
- **Don't** load anything from the internet, including a typeface; Georgia and the mono face are the system's, Inter is bundled.
- **Don't** set text in italic, or use the logo's copper and brass for text.
- **Don't** add a chat box, a conversation surface or a theme toggle.

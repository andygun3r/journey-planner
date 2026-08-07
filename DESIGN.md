---
name: Signaller
description: A UK rail planner built around a real banner-repeater signal — Platform White ground, Rail Navy for authority and structure, Signal Red as the one spotlight colour reserved for action and live alert.
colors:
  rail-navy: "#1c2340"
  rail-navy-deep: "#14161f"
  signal-red: "#d6352c"
  signal-red-deep: "#b23a2e"
  platform-white: "#f6f4f0"
  surface: "#ffffff"
  ink: "#14161f"
  ink-muted: "#4a4e5c"
  rule: "rgba(20,22,31,0.08)"
  on-navy: "#ffffff"
  on-red: "#ffffff"
  signal-green: "#2e7d46"
  signal-amber: "#a05500"
typography:
  display:
    fontFamily: "Archivo, Inter, system-ui, sans-serif"
    fontSize: "48px"
    fontWeight: 800
    lineHeight: 1.05
  h1:
    fontFamily: "Archivo, Inter, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 700
  h2:
    fontFamily: "Archivo, Inter, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.5
  time:
    fontFamily: "Inter, system-ui, sans-serif"
    fontWeight: 700
    fontFeature: "tnum"
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "0.1em"
rounded:
  control: "10px"
  card: "18px"
  pill: "999px"
spacing:
  xs: "0.4rem"
  sm: "0.65rem"
  md: "1rem"
  lg: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.rail-navy}"
    textColor: "{colors.on-navy}"
    rounded: "{rounded.pill}"
    padding: "0 1.5rem"
    height: "48px"
  button-live:
    backgroundColor: "{colors.signal-red}"
    textColor: "{colors.on-red}"
    rounded: "{rounded.pill}"
    padding: "0 1.5rem"
    height: "48px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "1rem"
  status-card:
    backgroundColor: "{colors.rail-navy}"
    textColor: "{colors.on-navy}"
    rounded: "{rounded.card}"
    padding: "1.25rem"
  chip-live:
    backgroundColor: "rgba(214,53,44,0.08)"
    textColor: "{colors.signal-red-deep}"
    rounded: "{rounded.pill}"
    padding: "0.22rem 0.65rem"
---

# Design System: Signaller

## Overview

**Creative North Star: "The Signal, Not the Chevron"**

Signaller is named for the person who tells trains where to go — calm, precise,
always in control. The mark follows the name literally: a real UK rail banner
repeater signal, a white disc rimmed in navy with a solid navy arm fixed at the
"off"/clear angle. That single honest object — not an abstract logotype, not a
borrowed heritage symbol — sets the whole register: direct, unambiguous, built
around signage rather than software chrome.

This is the second visual world this project has worn. The first (Mainline: a
red/blue duotone evoking the incoming Great British Railways double-arrow) is
kept only as evidence of what didn't fit — the user commissioned a fresh,
independently-designed brand identity (see `data/design/`) and asked for a full
replacement, not a re-tint. Signaller drops the double-arrow entirely, drops
Rail Blue for Rail Navy, and drops dark mode altogether: there is exactly one
theme, designed properly, rather than a light default plus an alternate to
maintain.

**Key Characteristics:**
- Platform White ground (~70%), Rail Navy for structure and authority (~20%),
  Signal Red as the one spotlight colour for action/live alert (~10%).
- The header is a full-bleed Rail Navy band on every screen size — the app's
  one constant "signal box" surface — carrying the mark, wordmark and desktop
  nav; a fixed bottom tab bar carries primary nav on mobile.
- The home dashboard's next-departure card is a signature navy "journey status
  card": Archivo route label, green status dot, Display-scale time on white,
  translucent white rows beneath for what's coming after.
- Archivo (500–800) for headlines, the logotype, section labels and any
  signage-like UI moment; Inter (400–600) for body copy, timetables and
  controls, tabular figures for times and codes throughout.
- Generously rounded: cards 18px, controls/chips 10px, buttons and status
  chips fully pill-shaped.
- Light only. No dark theme, no OS-driven switching, no toggle.

## Colors

A white-and-navy ground with Signal Red doing all the pointing.

### Primary
- **Rail Navy** (#1c2340): Authority and structure — the header band, the home
  dashboard's status card, primary buttons, nav, focus rings, primary text.
  Calm, always present, never shouting.
- **Rail Navy Deep** (#14161f): Pressed/hover state of navy actions; also the
  footer/darkest surface.
- **Rail Navy Tint** (#e7e8ee): Light wash behind selected nav state.

### Secondary
- **Signal Red** (#d6352c): The one spotlight colour — live status, delays,
  cancellations, disruption CTAs, the live countdown, the tab-bar's live-alert
  dot. Reserved for a single action or alert per screen; never a background
  fill for a large area.
- **Signal Red Deep** (#b23a2e): Pressed/hover state of red actions; disruption
  headline text on light cards.

### Neutral
- **Platform White** (#f6f4f0): Page ground — breathing room, not stark white.
- **Surface** (#ffffff): Card fill — cards float on Platform White with a soft
  shadow, or on Rail Navy as bright inset panels.
- **Ink** (#14161f): Primary text on light surfaces.
- **Ink Muted** (#4a4e5c): Secondary text, captions, labels (≥4.5:1 on white
  and on Platform White).
- **Rule** (rgba(20,22,31,0.08)): Hairline used sparingly inside cards; dashed
  at 0.2 opacity for editorial rows (voice/story-style sections).

### Signal (live status)
- **Signal Green** (#2e7d46): On time / good service.
- **Signal Amber** (#a05500): Minor delay (under 10 minutes).
- **Signal Red** (#d6352c): Cancelled / severe disruption — deliberately the
  same red as the brand's one accent, so "the app is pointing at something
  here" and "this train is in trouble" reinforce each other.

### Named Rules
**The Spotlight Rule.** Signal Red is the only saturated accent doing brand
work, and it lights up at most one thing per screen — an action, an alert, a
live delta. Rail Navy carries every other coloured surface (header, status
card, primary buttons); it is structure, not decoration.

**The Signal-Text Rule.** Colour never stands alone on live status: a chip or
label always states the condition in words alongside its colour.

**The One-Theme Rule.** There is no dark theme. Signaller is designed once,
properly, for Platform White — not maintained as two parallel palettes.

## Typography

**Display / Headline Font:** Archivo (500–800)
**Body / UI Font:** Inter (400–600)
**Time / Data:** Inter, `font-variant-numeric: tabular-nums`

**Character:** Archivo carries anything that needs to read like signage —
headlines, the wordmark, section labels, card eyebrows — geometric and
unmistakable at a glance, in the spirit of transit lettering. Inter carries
everything meant to be read at length or scanned quickly: body copy, timetable
rows, controls. Times are always tabular so departure boards align in columns.

### Hierarchy
- **Display** (Archivo 800, 48px, 1.05): The next-departure time on the home
  status card — the single largest, boldest number in the app.
- **H1** (Archivo 700, 32px): Page titles, station names.
- **H2** (Archivo 700, 22px): Section headers, card-group headers.
- **Body** (Inter 400, 17px, 1.5): Prose, controls, disruption copy.
- **Time / data** (Inter 700, tabular-nums): Departure/arrival times,
  countdowns, platform numbers.
- **Label** (Inter 600, 13px, +0.1em, often uppercase): Chip text, card
  eyebrows, tab-bar labels.

## Layout

Mobile-first: every surface is designed at phone width first, then widened to
a centred column (max 52rem) on desktop. The header is a full-bleed Rail Navy
band at every width, holding the mark + wordmark and (desktop only) the text
nav; **the fixed bottom tab bar carries primary navigation on mobile** (Plan ·
Boards · Map · Commute · Status — icon + label, active tab in Rail Navy, a
Signal Red dot badge when a tab has a live alert). Cards float on Platform
White with a soft rest shadow; the home dashboard's status card is the one
full-navy card, its own rows in translucent white rather than default card
white. Spacing rhythm: 0.65rem within a card, 1rem between cards, 1.5rem
between sections, more space above a heading than below it.

**There is exactly one theme.** No `prefers-color-scheme` switch, no toggle,
no `data-theme` attribute — Platform White and Rail Navy are the only ground
colours the app ever renders, on every device, every time.

## Elevation & Depth

Cards carry a soft, cool-toned rest shadow on Platform White — enough to read
as "a distinct rounded thing," not a heavy native-app drop shadow. The Rail
Navy header and the home status card are flush, full-bleed surfaces; nothing
about them needs elevation, they *are* the ground for that region.

### Shadow Vocabulary
- **Card rest** (`0 1px 3px rgba(20,22,31,0.06), 0 6px 16px rgba(20,22,31,0.08)`):
  Default elevation for every white card — board rows, journey cards, panels.
- **Card pressed** (`0 1px 2px rgba(20,22,31,0.08)`): Active/pressed state.
- **Overlay** (`0 12px 32px rgba(0,0,0,0.18)`): Dropdowns, sheets, modals.

## Shapes

Cards and panels: 18px radius. Small chips and inputs: 10px. Primary buttons
and status chips: fully pill-shaped (999px). The signal mark itself is a
circle — the one shape in the system with no radius token, because it's a
literal disc, not a rounded rectangle.

## Components

### The Signal Mark (signature)
A real UK rail banner repeater: a white disc, rimmed in navy (5% of diameter),
with a solid navy arm (13% of diameter thick, 130% of diameter wide) fixed at
45° — the "off"/clear position, the only angle it is ever shown at. Never
recoloured, stretched, rotated off-angle, or thinned. Minimum size 24px
digital; below that, the icon carries alone with no wordmark.
[components/signal-mark.tsx](apps/web/components/signal-mark.tsx)

### Buttons
- **Shape:** Pill (999px radius), 48px min height.
- **Primary:** Rail Navy fill, white text, weight 700. Hover → Rail Navy Deep.
- **Live/urgent action** ("Rebook automatically", "Track this train"): Signal
  Red fill, white text — reserved for genuinely live/urgent actions only.
- **Secondary:** White fill, ink text, hairline border.

### Chips (status)
- **Style:** Pill, tinted fill in the signal colour (~10–14% wash on light
  cards; a brighter ~12% white wash on the navy status card), full-strength
  text of that colour, no border. Always paired with a word ("On time", "12
  min late").
- **Live badge:** Small Signal Red dot with a white ring, used on the tab bar
  and card corners to mark "this journey is live-tracked."

### The Journey Status Card (home dashboard, signature)
Full Rail Navy background, 18px radius, Archivo route label (tracked
uppercase), a green live-status dot, real elevation. The next train renders
as a bright white inset row at Display scale (48px/800); trains after it sit
as translucent white rows (rgba(255,255,255,0.08)) beneath. A disruption
inside this card is never a full-bleed red banner — it stays information, not
interruption.

### Departure / Board Cards
- **Corner Style:** 18px radius.
- **Background:** White, floating on Platform White.
- **Shadow Strategy:** Card-rest shadow always on; Card-pressed on `:active`.
- **Border:** None at rest; a 2px Rail Navy border only on the "next train" /
  "here" row.
- **Internal Padding:** 1rem, 48px+ touch targets for the whole row.

### Inputs / Fields
- **Style:** Off-white fill, 10px radius, 48px height.
- **Focus:** 2px Rail Navy ring, 2px offset.

### Navigation
- **Header (every width):** Full-bleed Rail Navy band — mark + wordmark left,
  (desktop) text nav right, active link underlined in Signal Red.
- **Mobile (signature):** Fixed bottom tab bar, 5 destinations (Plan · Boards
  · Map · Commute · Status), icon + label, active tab in Rail Navy, a Signal
  Red dot badge on any tab with a live alert. Safe-area aware.

## Do's and Don'ts

### Do:
- **Do** treat Signal Red as a spotlight — one action or alert per screen, never
  a background fill.
- **Do** keep the header a full-bleed Rail Navy band at every width; it's the
  app's one constant "signal box" surface.
- **Do** build the home dashboard's next-departure card as full Rail Navy with
  a Display-scale white inset row for the train to catch.
- **Do** give mobile a fixed bottom tab bar with icon + label and a Signal Red
  live-alert dot.
- **Do** round every corner generously — pill buttons/chips, 18px cards, 10px
  inputs — except the mark itself, which is a true circle.
- **Do** keep every signal chip paired with text stating the condition.

### Don't:
- **Don't** reintroduce a second saturated accent — Signal Red does all the
  pointing; Rail Navy is structure, not decoration.
- **Don't** ship a dark theme, a `prefers-color-scheme` switch, or a toggle —
  there is exactly one theme.
- **Don't** show the signal mark's arm at any angle but 45°, recolour it, or
  thin its stroke.
- **Don't** reintroduce the double-arrow mark or Rail Blue from the previous
  (Mainline) world — this is a full replacement, not a re-tint.
- **Don't** square off corners; 18px/10px/pill is the form language.

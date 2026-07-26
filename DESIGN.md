---
name: Mainline
description: A UK rail planner as a bold red/blue duotone native app — the double-arrow spirit of the incoming Great British Railways identity, built for touch.
colors:
  rail-blue: "#0033a0"
  rail-blue-deep: "#00227a"
  rail-blue-tint: "#e7edfb"
  rail-red: "#d4202c"
  rail-red-deep: "#a91824"
  rail-red-tint: "#fceaeb"
  paper: "#ffffff"
  surface: "#f4f5f8"
  surface-raised: "#ffffff"
  ink: "#12141c"
  ink-muted: "#5c6070"
  rule: "#e2e4ec"
  on-blue: "#ffffff"
  on-red: "#ffffff"
  signal-green: "#076d3a"
  signal-amber: "#a05500"
  signal-danger: "#d4202c"
typography:
  display:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 4vw, 2.1rem)"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  time:
    fontFamily: "Inter, system-ui, sans-serif"
    fontWeight: 800
    fontFeature: "tnum"
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    letterSpacing: "0.04em"
rounded:
  sm: "10px"
  md: "16px"
  lg: "22px"
  pill: "999px"
spacing:
  xs: "0.4rem"
  sm: "0.65rem"
  md: "1rem"
  lg: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.rail-blue}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.pill}"
    padding: "0 1.5rem"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.rail-blue-deep}"
  card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "1rem"
  chip-live:
    backgroundColor: "{colors.rail-red-tint}"
    textColor: "{colors.rail-red-deep}"
    rounded: "{rounded.pill}"
    padding: "0.2rem 0.65rem"
---

# Design System: Mainline

## Overview

**Creative North Star: "The Departures App"**

Mainline now reads as a native transit app — the kind you'd expect preinstalled on a phone for the incoming Great British Railways network — rather than a printed identity manual. It keeps the one piece of heritage worth keeping, the double-arrow, and rebuilds everything else around it: a bold **red/blue duotone** on white, used as two confident equal partners rather than one rare institutional colour; soft rounded cards instead of ruled hairline tables; a bottom tab bar on mobile instead of a text-link header. This is the second visual world this project has worn — the first (a strict British Rail 1965 manual pastiche, square forms, one rare blue) is kept only as evidence of what didn't fit; the user explicitly asked for something louder, warmer and more phone-native.

Blue is the calm, structural colour — navigation, primary actions, "you are here." Red is the live, urgent colour — delays, alerts, the countdown-to-departure state, the tab-bar's live indicator. Together they read instantly as *this network's* colours without literally reproducing GBR's mark. White and a cool light-grey surface keep density legible; cards carry real shadow now (a native app has real elevation, unlike a printed page), and corners are generously rounded throughout.

**Key Characteristics:**
- White ground, light-first; red and blue both carry real UI weight (duotone, not one-accent).
- Blue = structural/navigational/primary action. Red = live/urgent/alert/countdown.
- Cards, not hairline tables — the departure board is a stack of rounded rows with real elevation.
- Bottom tab bar for primary navigation on mobile; the desktop header keeps a slimmer top bar.
- Generously rounded corners (10–22px) everywhere; pill-shaped primary buttons and status chips.
- Inter throughout, tabular figures for times; weight and size carry hierarchy.

## Colors

A white-and-cool-grey ground with a bold blue/red duotone doing the identity work.

### Primary
- **Rail Blue** (#0033a0): Navigation, primary buttons, links, focus, the "on time / here" state, the double-arrow. The calm, structural colour — always present, never shouting.
- **Rail Blue Deep** (#00227a): Pressed/hover state of blue actions.
- **Rail Blue Tint** (#e7edfb): Light wash behind blue chips, selected nav item, "here" row highlight.

### Secondary
- **Rail Red** (#d4202c): Live/urgent signal — delays, cancellations, the live countdown pill, the tab-bar's live-alert badge, the primary CTA on the live board ("Track this train"). Loud on purpose; it is the network's live nervous system.
- **Rail Red Deep** (#a91824): Pressed/hover state of red actions.
- **Rail Red Tint** (#fceaeb): Light wash behind red chips and alert cards.

### Neutral
- **Paper** (#ffffff): Page ground.
- **Surface** (#f4f5f8): Cool light-grey backdrop behind card stacks, distinguishing them from pure-white cards.
- **Surface Raised** (#ffffff): Card fill — white cards float on the grey surface.
- **Ink** (#12141c): Primary text.
- **Ink Muted** (#5c6070): Secondary text, captions, labels (≥4.5:1 on white and on surface).
- **Rule** (#e2e4ec): Hairlines used sparingly inside cards (list dividers), never as the primary structuring device.

### Signal (live status)
- **Signal Green** (#076d3a): On time / good service.
- **Signal Amber** (#a05500): Minor delay.
- **Signal Danger** (#d4202c): Cancelled / severe disruption — deliberately the same red as the brand's live colour, so "the app is red here" and "this train is in trouble" reinforce each other.

### Named Rules
**The Two-Colour Rule.** Blue and red are the only saturated colours doing brand work. Blue is calm and structural; red is live and urgent. Neither decorates a panel for its own sake — every use is navigation, action, live status, or focus.

**The Signal-Text Rule.** Colour never stands alone on live status: a chip or label always states the condition in words alongside its colour.

## Typography

**Display / Body Font:** Inter (system-ui, sans-serif fallback)
**Time / Data:** Inter, `font-variant-numeric: tabular-nums`

**Character:** One grotesque family, used the way a native app's system font is used — utilitarian, extremely legible, hierarchy from weight and size only. Times are always tabular so departure boards align in columns even as cards, not just as ruled tables.

### Hierarchy
- **Display** (800, clamp(1.5–2.1rem), 1.08, -0.02em): Page titles, station names.
- **Section title** (700, 1.05–1.3rem): Card-group headers.
- **Body** (400, 0.9375rem, 1.5): Prose, controls.
- **Time / data** (800, 1.15–1.4rem, tabular-nums): Departure/arrival times, countdowns — heavier than before, since it now competes with card chrome for attention.
- **Label** (700, 0.72rem, +0.04em, often uppercase): Chip text, card eyebrows, tab-bar labels.

## Layout

A single centred column (max 52rem) on desktop, but the primary interaction model is now **card stacks on a grey surface**, not a ruled table on paper. Each departure/journey is its own rounded card with internal padding and a touch-scaled target (≥48px), with visible gaps between cards (0.65rem) rather than hairline dividers. The live map still breaks out to viewport width. Desktop keeps a slim top bar (wordmark + double-arrow + text nav + theme toggle); **mobile switches to a fixed bottom tab bar** (5 primary destinations, icon + label, the active tab in blue with a red dot badge when there's a live alert). Spacing rhythm: 0.65rem within a card, 1rem between cards, 1.5rem between sections, more space above a heading than below it.

**Theme switching is explicit, not OS-driven.** Light is the default regardless of `prefers-color-scheme`; dark is a deliberate visitor choice via the top-bar toggle ([components/theme-toggle.tsx](apps/web/components/theme-toggle.tsx)), persisted in `localStorage` and applied pre-paint to avoid a flash. Dark gets its own vivid red/blue duotone (`#5c86ff` / `#ff4d55` on `#0b0e17`), not a muted/lifted copy of the light palette.

## Elevation & Depth

**Real elevation, native-app style.** Unlike the previous flat-paper doctrine, cards now sit visibly above the grey surface: a soft, cool-toned drop shadow at rest, deepening slightly on hover/press for interactive cards. This is the one deliberate reversal from the prior world — a phone app has depth; a printed manual does not.

### Shadow Vocabulary
- **Card rest** (`box-shadow: 0 1px 3px rgba(18,20,28,0.06), 0 6px 16px rgba(18,20,28,0.08)`): Default elevation for every card (board rows, journey cards, panels).
- **Card pressed/active** (`box-shadow: 0 1px 2px rgba(18,20,28,0.08)`): Active/pressed state — flattens slightly, like a real button depressing.
- **Overlay** (`box-shadow: 0 12px 32px rgba(0,0,0,0.18)`): Dropdowns, sheets, modals — floats highest.

### Named Rules
**The Real-Elevation Rule.** Every card carries the rest shadow; nothing sits flush with the grey surface except the surface itself and true full-bleed sections (the map, the tab bar).

## Shapes

Generously rounded, native-app forms. Cards and panels: 16px radius. Small chips and inputs: 10px. Primary buttons and status chips: fully pill-shaped (999px) — the opposite of the previous square-cornered doctrine. The double-arrow is drawn in blue-over-red (the upper arrow blue, the lower red) so the two brand colours meet in the one shared mark.

## Components

### Buttons
- **Shape:** Pill (999px radius), 48px min height.
- **Primary:** Rail Blue fill, white text, weight 700. Hover → Rail Blue Deep. Press → flattens (Real-Elevation Rule).
- **Live/urgent action** ("Track this train"): Rail Red fill, white text — reserved for genuinely live/urgent actions only.
- **Secondary:** White fill, ink text, 1.5px ink-10%-tint border.

### Chips (status)
- **Style:** Pill, tinted fill in the signal colour (10–14% wash), full-strength text of that colour, no border. Always paired with a word ("On time", "12 min late").
- **Live badge:** Small red dot + white ring, used on the tab bar and card corners to mark "this journey is live-tracked."

### Cards (departure board rows, journey results, panels — signature)
- **Corner Style:** 16px radius.
- **Background:** White, floating on the grey Surface.
- **Shadow Strategy:** Card-rest shadow always on; Card-pressed on `:active`.
- **Border:** None at rest (shadow does the separating); a 2px Rail-Blue border only on the "next train" / "here" card.
- **Internal Padding:** 1rem, 48px+ touch targets for the whole row.

### Inputs / Fields
- **Style:** White fill, 10px radius, 1.5px rule border, 48px height.
- **Focus:** 2px Rail-Blue ring, 2px offset — no longer a hairline outline.

### Navigation
- **Desktop:** Slim top bar, wordmark + double-arrow left, text links right, active link in Rail Blue with a pill-shaped underline chip.
- **Mobile (signature):** Fixed bottom tab bar, 5 destinations (Plan · Boards · Map · Commute · Status), icon + label, active tab's icon+label in Rail Blue, a small red dot badge on any tab with a live alert. Safe-area aware.

### Double-arrow mark (signature)
The British Rail symbol, now two-tone: the upper (right-pointing) arrow in Rail Blue, the lower (left-pointing) arrow in Rail Red — the one place the two brand colours are literally joined.

## Do's and Don'ts

### Do:
- **Do** use both blue and red as real UI colours — blue for structure/navigation/primary action, red for live/urgent/alerts.
- **Do** build the departure board and journey results as a card stack with real elevation, not a ruled table.
- **Do** give mobile a fixed bottom tab bar with icon + label and a red live-alert dot.
- **Do** round every corner generously — pill buttons/chips, 16px cards, 10px inputs.
- **Do** keep every signal chip paired with text stating the condition.

### Don't:
- **Don't** reduce back to one rare "institutional" accent colour — this world is a confident duotone.
- **Don't** flatten cards to hairline-only structure; the Real-Elevation Rule requires a visible rest shadow on every card.
- **Don't** square off corners again; pill/16px/10px is the form language now.
- **Don't** literally reproduce the real Great British Railways mark or claim official affiliation — this evokes the family, it is not the identity.
- **Don't** reintroduce the previous world's violet accent, dark-by-default, or "LLM-generic" gradients/glows-as-decoration.

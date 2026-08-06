# Handoff: Signaller Brand Identity

## Overview
Signaller is a UK journey-planning app (rail first, expanding to other transport). This package hands off the brand identity — logo, colour, type, voice, iconography, imagery direction, and UI examples — for implementation in the app codebase.

## About the Design Files
The bundled .dc.html files are **design references** built as interactive HTML prototypes, not production code. Do not embed or copy their markup directly. Recreate the visual system in the app's existing environment (React Native, SwiftUI, Android Views, web, whatever the codebase already uses), using its established component/styling patterns.

## Fidelity
**High-fidelity.** All colors, type sizes/weights, spacing and the logo construction below are final values, not placeholders.

## Logo / Mark
- Concept: a UK rail banner repeater signal — a white disc, rimmed in navy, with a solid navy arm through its centre, fixed at 45° (the "off/clear" position). Never shown at any other angle.
- Construction: arm width = 130% of disc diameter; arm thickness = 13% of disc diameter; rim border = 5% of disc diameter (navy #1C2340), drawn on a white disc.
- Clear space: equal to the mark's own height on all sides.
- Minimum size: 24px digital / 10mm print. Below that, drop the wordmark, icon only.
- Don'ts: never recolour, stretch/squash, rotate the arm off the 45° angle, or thin the arm stroke.
- Lockup: mark + "Signaller" wordmark in Archivo 800, either navy-on-white or white-on-navy. Icon-only version available for small placements (favicons, app icon, avatars).
- See `Signaller Logo Concepts.dc.html` for earlier rejected directions (arrow mark, signal lamp, semaphore disc) kept for reference/rationale only — do not implement those.

## Design Tokens

### Colour
- Signal Red: #D6352C — actions, alerts, single accent per screen (~10% of any layout)
- Rail Navy: #1C2340 — authority, dark surfaces, primary text (~20%)
- Platform White: #F6F4F0 — backgrounds, breathing room (~70%)
- Ink: #14161F — body text on light surfaces
- Status — On time: #4CAF6D
- Status — Minor delay: #E4B676
- Status — Disruption: #D6352C
- Usage ratio target across any screen: ~70% white/off-white, 20% navy, 10% red. Red is reserved for one action or alert at a time — never a large background fill.

### Typography
- Archivo (weights 500–800): headlines, the logotype, section labels, any signage-like UI moment.
- Inter (weights 400–600): body copy, UI labels, timetables, long-form text.
- Scale: Display 48px/800, H1 32px/700, H2 22px/700, Body 17px/400, Label 13px/600 (uppercase, tracked +0.1em typical for labels).

### Spacing / Shape
- Cards: 12–20px border radius depending on size (small list rows 12px, feature cards 18–20px).
- Dividers: 1px solid rgba(20,22,31,0.08) on light, or 1px dashed rgba(20,22,31,0.2) for editorial rows (voice/story sections) — avoid uniform bordered grids; prefer editorial rows and dashed dividers over boxed cards.
- Icons: 2px stroke on a 24px grid, navy or white only — never red (red stays reserved for live alerts).

## Voice & Tone
Three pillars — apply directly to UI copy and error/alert states:
1. Confident & concise — lead with the answer, trim to what the traveller needs to act. ("Next train 08:41, Platform 4.")
2. Warm underneath — sound like a helpful person, not a terms page. ("We've held your alert — no need to reset it.")
3. Technical when it counts — be exact with times, platforms, causes. ("Delayed 12 min — signalling fault near Slough.")
Avoid corporate hedging ("unfortunately there may be some changes...", "delays possible due to circumstances beyond our control").

## Imagery Direction
Real platforms, real commuters — documentary, not staged. Natural light, candid framing, cool-leaning muted grade. No stock-photo smiling-at-camera shots. Never depict a specific operator's livery/branding.

## Screens / UI Reference
### Journey status card (dark)
Navy background (#1C2340), route label (Archivo 700/15px, tracked), green status dot, time in Archivo 800/48px, meta line in Inter 14px #9AA0BD, two pill actions at 10px radius, translucent white fill (rgba(255,255,255,0.1)).

### Disruption alert card (light)
White card, 20px radius, red status dot + "SERVICE DISRUPTION" label (Archivo 700/15px navy), body in Inter 15px #3C3F4C, single red CTA pill (#D6352C bg, white text, 8px radius).

### App home screen (mobile, dark theme)
Navy full-bleed background. Header: icon mark + wordmark. Understated search field (translucent white pill). Next-departure card: white, 18px radius, on-time dot + time at Display scale. Disruption card directly below: red-tinted translucent card (rgba(214,53,44,0.08) bg, rgba(214,53,44,0.3) border) — NOT a full-bleed banner, reads as information not interruption; body text must be light (rgba(255,255,255,0.85)) for contrast on the dark card, not the light-surface grey (#3C3F4C) used on white cards. "Upcoming" list below as compact white rows with a trailing status dot.

## Files
- `Signaller Brand Guidelines.dc.html` — full guidelines: story, logo, colour, type, voice, iconography, imagery, UI examples (cards + app screen).
- `Signaller Logo Concepts.dc.html` — rejected/exploratory logo directions, for rationale only.

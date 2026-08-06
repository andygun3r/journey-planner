# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

UK rail commuters and travellers — starting with Andrew, a daily commuter. Context of use: standing on a platform or walking to the station, often at 7am/6pm in poor light, one-handed on a phone, needing an answer in seconds. The job: "which train do I catch, is it on time, and what platform?" Secondary: planning longer one-off journeys with changes.

## Product Purpose

Signaller is a fast, self-reliant UK rail journey + commute planner: its own routing engine (MOTIS) over the national timetable, live Darwin data, indicative fares. It exists because the user has RDG data access but no National Rail journey planner licence — so it computes everything itself. Success: answers that are faster and calmer than nationalrail.co.uk, trustworthy live status, complex routes handled without fuss.

## Positioning

A planner that *computes* rather than *proxies*: it runs its own MOTIS routing engine over the national timetable and layers live Darwin + Network Rail feeds and indicative fares. That self-reliance — and the depth it unlocks (journey-wide live status, between-station positioning, signalling-diagram aspects) — is what a retail-facing rail site could not truthfully replicate. It is operational rail kit, not a ticket shop.

## Operating Context

- **Primary scene:** phone in hand on a platform or on the walk in, at 7am / 6pm, one-handed, glanceable in seconds and readable at arm's length in poor light.
- **Live sources:** LDBWS is the board's primary live source; Darwin Push Port and Network Rail (TRUST/TD) are the deeper feeds behind journey-wide status, positioning and signalling. The board still works when ingest services are down.
- **Core surfaces:** journey search & results, live departure board, per-service calling pattern with live progress, live train map, commute editor/dashboard, disruptions.
- **Terminology:** CRS/TIPLOC/NLC/STANOX station codes, TOCs (operators), platforms, calling points, "expected" vs scheduled times.

## Capabilities and Constraints

- Own MOTIS routing engine over the national DTD timetable; indicative fares from DTD Fares.
- Live departure boards (LDBWS), journey-wide live status and SSE deltas (Darwin), between-station positioning and signalling aspects (Network Rail TRUST/TD + SOP maps), disruptions and TOC service indicators.
- Commute modelling: weekly schedule, holidays, smart-focus dashboard, commute alerts.
- Status truth-telling: exact minutes, real platforms, honest uncertainty ("no report yet"), never vague reassurance. Signalling coverage is partial (unmapped areas degrade to track occupancy) — the UI must state such limits rather than imply full coverage.
- Personal project; each data feed's licence must be checked before any public deployment.

## Brand Commitments

- **Name / wordmark:** "Signaller."
- **Voice:** precise, operational, unflappable — professional rail kit, departure-board energy, tabular clarity, high information density with zero fluff. Reads like equipment used by someone who runs the railway, not marketing aimed at a ticket buyer.
- **Visual direction (user-volunteered, binding — superseded 2026-07-25, to be developed in new-work, not here):**
  - Anchor world: **bold red/blue duotone on white, evoking the incoming Great British Railways identity** without copying it — the double-arrow carries forward, but blue and red are used as equal partners (not one rare institutional colour), confidently across buttons, headers and status.
  - **Native app register, not printed manual**: rounded shapes (not square/hairline BR forms), card-based screens for the departure board and journey results, a bottom tab bar on mobile. Reads as a modern transit app, not a corporate identity document.
  - **Light-first, and light by default regardless of OS preference**: the app does not auto-switch to dark based on `prefers-color-scheme` (an earlier OS-driven build was mistaken for a bug by the user). Dark is reachable only via an explicit in-app toggle, persisted per visitor, and gets its own full red/blue duotone treatment rather than a muted/lifted version of the light palette.
  - **Typography:** Inter for body/UI (with tabular figures for times and codes).
  - Superseded: the previous British-Rail-1965-manual anchor (square forms, hairline rules, one rare Rail Blue, ruled-timetable grammar) — kept only as evidence of what was tried, not a base to polish forward.
- **Anti-references:**
  - Trainline / corporate rail retail — this is a planner, not a shop; no upsell energy, no promotional colour.
  - "LLM-designed" default dark/violet/system-font look — treated as evidence and anti-reference, not a base to polish.
  - Retro pastiche / nostalgia theme park — heritage cues (the double-arrow) inform, but the result stays modern and app-native.
  - A generic SaaS dashboard of same-size icon+heading+text cards is still out — cards here are earned by the mobile-app brief and carry real timetable content, not filler tiles.

## Design Principles

1. **Time is the interface** — departure/arrival times and live deltas are the primary content; everything else supports them.
2. **Density with discipline** — commuters want many trains visible at once; achieve density through tabular alignment and consistent rhythm, never clutter.
3. **Live state is loud, chrome is quiet** — delays, cancellations and platform changes get the colour and motion budget; static UI stays restrained.
4. **One-hand, five-second use** — every core answer (next train, is it on time) reachable in one tap and readable at arm's length.
5. **Trust through precision** — exact minutes, real platforms, honest uncertainty, never vague reassurance.

## Accessibility & Inclusion

WCAG 2.2 AA. **Light theme designed first** (ink-on-paper, British Rail heritage) with a proper dark theme as a first-class alternative; both meeting ≥4.5:1 body contrast. Status never conveyed by colour alone (icons/text deltas accompany red/amber/green). Reduced-motion alternatives for all live-update animation. Touch targets ≥44px for platform use with gloves/one hand.

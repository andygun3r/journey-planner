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
- **Visual direction (current, shipped 2026-08-07 — see DESIGN.md for the full system):**
  - Anchor world: a real UK rail **banner repeater signal** as the brand mark — white disc, navy rim, navy arm fixed at the "off"/clear 45° angle. Platform White ground (~70%), Rail Navy for structure/authority (~20% — full-bleed header, primary buttons, the home status card), Signal Red as the one spotlight accent for live status/action (~10%).
  - **Mobile-first, native app register**: designed at phone width first, then widened. Generously rounded shapes (18px cards, 10px controls, pill buttons/chips — the mark itself stays a true circle), a fixed bottom tab bar on mobile, a full-bleed Rail Navy header at every width.
  - **Light only.** No dark theme, no `prefers-color-scheme` switching, no toggle — the previous world's explicit dark alternative was dropped entirely rather than redesigned.
  - **Typography:** Archivo (500–800) for headlines, the wordmark and any signage-like UI moment; Inter (400–600) for body/UI/timetables, with tabular figures for times and codes.
  - Superseded: the Mainline red/blue GBR-evoking duotone (double-arrow mark, Rail Blue/Rail Red, dark-mode toggle) — kept only as evidence of what was tried, not a base to polish forward. Before that, an even earlier British-Rail-1965-manual anchor (square forms, hairline rules) — also superseded.
- **Anti-references:**
  - Trainline / corporate rail retail — this is a planner, not a shop; no upsell energy, no promotional colour.
  - "LLM-designed" default dark/violet/system-font look — treated as evidence and anti-reference, not a base to polish.
  - Retro pastiche / nostalgia theme park — the signal mark is a real, working piece of rail equipment rendered honestly, not vintage decoration.
  - A generic SaaS dashboard of same-size icon+heading+text cards is still out — cards here carry real timetable content, not filler tiles.
  - The previous Mainline double-arrow/red-blue duotone world and its dark theme — fully retired, not a fallback.

## Design Principles

1. **Time is the interface** — departure/arrival times and live deltas are the primary content; everything else supports them.
2. **Density with discipline** — commuters want many trains visible at once; achieve density through tabular alignment and consistent rhythm, never clutter.
3. **Live state is loud, chrome is quiet** — delays, cancellations and platform changes get the colour and motion budget; static UI stays restrained.
4. **One-hand, five-second use** — every core answer (next train, is it on time) reachable in one tap and readable at arm's length.
5. **Trust through precision** — exact minutes, real platforms, honest uncertainty, never vague reassurance.

## Accessibility & Inclusion

WCAG 2.2 AA. **One theme, designed properly**: ink-on-Platform-White, ≥4.5:1 body contrast — there is no dark alternative to maintain in parallel. Status never conveyed by colour alone (icons/text deltas accompany red/amber/green). Reduced-motion alternatives for all live-update animation. Touch targets ≥44px for platform use with gloves/one hand.

**Opt-in exception:** signed-in users can enable an alternate high-contrast theme plus reduced motion, larger text and strengthened non-colour cues from `/settings` — for accessibility need, not preference browsing. This does not reinstate the retired dark theme or any `prefers-color-scheme` auto-switching: the one-theme default is unchanged for every signed-out visitor and every signed-in user who doesn't opt in.

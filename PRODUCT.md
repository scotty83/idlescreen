# Product

## Register

product

## Users

Company staff in private offices, each with a Cisco Board Pro (gen1 or gen2) — a 55" 4K touch video device that idles most of the day. They glance at the display from their desk, 3–6 feet away, dozens of times a day: before leaving for a train, while getting coffee, during a pause. They configure it once from their phone or by touch, then mostly never think about it again. No logins, no accounts.

## Product Purpose

A personal, glanceable signage dashboard that makes an idle meeting device useful: weather, NYC Subway / LIRR / NJ Transit departures, market indices, public-domain art, and small daily delights. Success = a user can answer "when's my train?" or "do I need a coat?" from their chair in under two seconds, and the display feels like theirs, not the company's.

## Brand Personality

Calm utility. Quiet, glanceable, professional — information first, zero flash. A well-made instrument in the corner of the office. Three words: composed, legible, unobtrusive.

## Anti-references

- Corporate BI dashboards (KPI tiles, enterprise chrome, dense grids of charts).
- Consumer smart-display kitsch (bubbly cards, mascots, oversized decorative weather art).
- Anything that reads "digital menu board" — rotating promos, attention-grabbing motion.

## Design Principles

1. **Two-second reads.** Every widget's primary fact (minutes, degrees, track) is legible and findable at 6 ft without searching.
2. **The data is the decoration.** MTA bullet colors, market sparklines, and artwork carry the visual interest; the chrome stays neutral.
3. **Calm motion only.** Slow crossfades and value updates in place; nothing slides, bounces, or demands attention.
4. **Degrade visibly, never blankly.** Stale data dims and gets a timestamp; a dead feed never becomes an empty screen.
5. **Personal, not corporate.** Greeting, chosen stations, chosen art — the display should feel owned by the person in the room.

## Accessibility & Inclusion

- 55" 4K panel at 1920×1080 logical, viewed at 3–6 ft: primary text ≥ 20 px with an 18 px floor for secondary meta text, primary data ≥ 34 px, muted tints ≥ 4.5:1 contrast on card backgrounds.
- Touch targets ≥ 56 px on the settings surfaces (standing user, arm's length).
- Color is never the only signal (route letters inside bullets, ▲/▼ plus sign on market deltas).
- Reduced-motion users: crossfades are the only animation; all are removable via prefers-reduced-motion without losing content.
- Web engine constraint (gen1 Board Pro): animate only transform/opacity; no WebGL, filters, or heavy shadows on animated elements.

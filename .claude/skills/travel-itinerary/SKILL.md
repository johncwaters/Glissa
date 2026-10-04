---
name: travel-itinerary
description: Consolidate trip confirmations and identify missing calendar coverage.
---

1. Identify the named trip, or search the next 60 days.
2. Search mail for airline, hotel, rail, car, `confirmation`, and `itinerary` messages.
3. Write `travel/<yyyy-mm>-<destination>.md` with headings `Flights`, `Lodging`, `Ground`, `Confirmations`, and `Calendar gaps`.
4. Fill `Ground` through the `travel-search` skill, one run per airport-to-lodging leg, `journey` when both ends are in London and `route` otherwise, recording the returned duration.
5. Under `Flights`, price an uncovered outbound and its uncovered return in one `flights` run carrying the `return` date and record its single round-trip total once against the pair, and give each further uncovered leg a run of its own. An itinerary build is the one exception to the `travel-search` one-search-per-question rule and spends one search per uncovered pair or leg; every price carries the date it was quoted, because an undated quote reads as current and a priced leg makes the tentative hold actionable in the same session.
6. Include confirmation codes only; never include card data.
7. List travel segments with no calendar event under `Calendar gaps`.
8. Offer tentative calendar holds only after listing them, then create, move, or retitle them only through [calendar-write](../calendar-write/SKILL.md), never the Google Calendar connector, because the connector reaches only john@johncwaters.com and not the trip calendar.
9. Reply with the link printed by `node scripts/serve-results.mjs url <path>` for the travel file.

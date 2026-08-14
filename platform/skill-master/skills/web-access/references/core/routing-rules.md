# Routing Rules (v1)

This repository is a single routed skill with three modes: `generic`, `amzlisting`, `amzh10`.

Routing is "soft": it selects a best default mode, but the user can explicitly override it in plain text.

## Priority Order

1. **Explicit mode hint in the user's message** (wins over everything else)
2. **Explicit URL/domain match**
3. **Best-effort heuristics from task wording and page characteristics**
4. **Fallback** to `generic`

## Explicit Triggers (Highest Priority)

If the user's text includes any of the following, route to that mode even if the URL suggests otherwise:

- `/web access amzlisting`
- `/web access amzh10`
- `/web access generic`
- `use web access amzlisting`
- `use web access amzh10`
- `use web access generic`
- `用web access跑amzlisting`
- `用web access跑amzh10`
- `用web access跑generic`

## URL/Domain Heuristics

- `members.helium10.com` -> `amzh10`
- Amazon retail marketplaces (`amazon.<suffix>` and `www.amazon.<suffix>`) -> `amzlisting`
  - Non-retail Amazon hosts (for example, `sellercentral.amazon.com`) do not qualify and should fall back to `generic`.
- raw ASIN-only input is case-insensitive (`^[A-Za-z0-9]{10}$`) -> `amzlisting`
  - Normalize the ASIN to uppercase and load the canonical Amazon PDP URL.

## Best-Effort Heuristics (Tier 3)

When there is no explicit mode hint and no explicit URL/domain match, use best-effort heuristics from task wording and page characteristics to pick a default mode. This tier is intentionally fuzzy and may be wrong.

- `amzlisting` signals (examples):
  - task wording: ASIN, "PDP", "product listing", "bullets", "variations", "seller", "buy box"
  - page characteristics: an obvious Amazon product-detail layout, ASIN displayed, variation selectors
- `amzh10` signals (examples):
  - task wording: "Helium 10", "Cerebro", "Black Box", "Magnet"
  - page characteristics: Helium 10 members app UI, tool navigation, results tables

If the signal is weak or mixed, ask a single clarifying question or default to `generic`.

## Pack Notes

- `amzlisting` writes item captures to a deterministic local capture path: `<capturesRoot>/<profile>/amzlisting/<YYYY-MM-DD>/<ASIN>.json`.
- Amazon dog pages are business-status captures (`status = "dog"`), not crawler failures.

## Fallback

If no explicit hint and no matching domain heuristic applies, route to `generic`.

# Handoff — 2026-09-29

Scoreboard CPU fix: `write-worker-feeds.mjs` now publishes `<league>.prices.json`
with only the raw Kalshi fields consumed by scoreboard's existing join, and one
`<league>.history.<marketTicker>.json` per chart. The full archive remains available.
The data publisher replaces generated history files for its own league only.

Validated against the real September 29 NCAAF archive: compact prices 436,072 bytes
versus 8,811,868 bytes full archive; scoreboard's derived cache is exactly equal,
and all 237 extracted histories retain every point and the publisher timestamp.
Script syntax checks pass. No synthetic data used.

Consumer changes are in `/Users/michaelsoueid/Code/scoreboard` on
`restore-simple-football`. Publish these assets before deploying the consumer.
Rollback: old consumers still read the unchanged full archives; reverting this
publisher requires reverting the new consumer first.

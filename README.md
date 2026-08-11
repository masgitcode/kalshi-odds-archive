# kalshi-odds-archive

Periodic public snapshots of [Kalshi](https://kalshi.com) NFL game-market prices
and price history, published as JSON.

Kalshi's market-data endpoints are public and need no authentication, but they
are not reachable from everywhere: Kalshi rate-limits by IP and returns `429` to
Cloudflare's shared egress addresses, and `403` to any request carrying an
`Origin` header — so a browser cannot call them either. This repository fetches
on a GitHub-hosted runner, which Kalshi does serve, and republishes the result
so that consumers in those environments can read it.

## Where the data is

The `data` branch, rebuilt and force-pushed on every run:

| file | contents |
|---|---|
| `nfl.json` | full snapshot — events, settled events, price history |
| `nfl.meta.json` | just the counts and `generatedAt`, for cheap freshness checks |

Raw URLs:

```
https://raw.githubusercontent.com/masgitcode/kalshi-odds-archive/data/nfl.json
https://raw.githubusercontent.com/masgitcode/kalshi-odds-archive/data/nfl.meta.json
```

`raw.githubusercontent.com` serves these with `cache-control: max-age=300`, so a
reader can see a snapshot up to five minutes older than the one just published.

## Freshness

**Assume roughly hourly. Do not design for the requested cadence.**

The workflow asks for a run every 10 minutes and also once an hour. On free
public runners GitHub honours the hourly line and largely ignores the rest —
measured here, `*/10` produced one run in 51 minutes and an offset sub-hourly
cron produced none in 41. That is GitHub's scheduler, not a fault in this repo,
and no cron expression fixes it.

So: **trust `generatedAt`, never the schedule.** Add raw's five-minute cache on
top, and a consumer's staleness threshold should sit comfortably above an hour.
A threshold tuned to the requested 10-minute cadence will reject most real
snapshots and silently render this feed useless.

The `data` branch is force-pushed, so it is always exactly one commit deep.
There is no historical archive of snapshots — each run replaces the last. The
price *history* inside each snapshot covers 14 days at hourly resolution, so the
long view lives inside the file rather than in git.

## Shape of a snapshot

```jsonc
{
  "version": "v1",
  "league": "nfl",
  "generatedAt": "2026-08-11T20:38:09.188Z",
  "eventCount": 33,
  "settledCount": 4,
  "historyCount": 17,
  "events": [ /* Kalshi events, verbatim, with nested markets */ ],
  "settledEvents": [ /* recently settled, for charting finished games */ ],
  "history": [
    {
      "marketTicker": "KXNFLGAME-26AUG13DETCIN-CIN",
      "eventTicker": "KXNFLGAME-26AUG13DETCIN",
      "side": "home",
      "points":     [ { "t": 1760000000, "c": 62 } ],  // hourly, 14 days
      "finePoints": [ { "t": 1760000060, "c": 63 } ]   // 1-minute, 24 hours
    }
  ]
}
```

`t` is epoch seconds, `c` is price in cents (0–100).

**`events` is Kalshi's array verbatim, deliberately un-joined.** Matching a
market to a game needs three fiddly rules — the ticker's date is the *Eastern*
game date rather than UTC, teams must be read from `sub_title` because splitting
the ticker is ambiguous (`LACHOU`), and a few abbreviations differ between
providers. Doing that join here would mean maintaining it in two places, so it
stays with the consumer.

Settled markets carry no usable price — the contract has resolved to 0 or 100 —
and are included only so a finished game can still show its price history.

## Guarantees, such as they are

The fetch **refuses to publish an empty slate.** If Kalshi returns no open
events, or every candlestick request fails, the run exits non-zero and the
previous snapshot stays in place. An empty file is worse than a stale one: a
consumer cannot distinguish it from "no market exists."

This is a personal project published as-is, on a best-effort schedule, with no
uptime commitment. Kalshi is the authority on its own data; if the two disagree,
Kalshi is right.

## Running it yourself

```bash
LEAGUE=nfl OUT_DIR=out node scripts/fetch-kalshi.mjs
```

No dependencies, no credentials, Node 22+.

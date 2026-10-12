import { writeFileSync } from 'node:fs';

// Keep Kalshi values unchanged, but omit fields the scoreboard never reads.
// In particular, chart histories must not be parsed by every cron invocation.
function compactEvent(event) {
  return {
    event_ticker: event.event_ticker,
    sub_title: event.sub_title,
    markets: (event.markets ?? []).map((market) => ({
      ticker: market.ticker,
      yes_sub_title: market.yes_sub_title,
      yes_bid_dollars: market.yes_bid_dollars,
      yes_ask_dollars: market.yes_ask_dollars,
      last_price_dollars: market.last_price_dollars,
    })),
  };
}

export function writeWorkerFeeds(snapshot, outDir) {
  const { league, generatedAt } = snapshot;
  writeFileSync(`${outDir}/${league}.prices.json`, JSON.stringify({
    version: 'v1', league, generatedAt,
    events: snapshot.events.map(compactEvent),
    settledEvents: snapshot.settledEvents.map(compactEvent),
    spreadEvents: (snapshot.spreadEvents ?? []).map(compactEvent),
  }));
  for (const history of snapshot.history) {
    if (!/^[A-Z0-9-]{4,80}$/.test(history.marketTicker)) continue;
    writeFileSync(`${outDir}/${league}.history.${history.marketTicker}.json`, JSON.stringify({
      ...history, version: 'v1', league, cachedAt: generatedAt,
    }));
  }
}

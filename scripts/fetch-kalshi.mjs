// Fetches Kalshi game-market prices and price history and writes them to disk
// as a single JSON snapshot.
//
// Self-contained on purpose. This repository is public and must not depend on
// any private code, so the Kalshi paging and candlestick parsing are inlined
// here rather than imported.
//
// What it deliberately does NOT do: join Kalshi markets to games. The snapshot
// carries Kalshi's RAW events array, so the consumer runs its own join. Keeping
// the join out of here means the Eastern-date ticker rule, the sub_title parse
// and the team-abbreviation map stay in exactly one place downstream instead of
// drifting between two repositories.

import { mkdirSync, writeFileSync } from 'node:fs';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const USER_AGENT = 'kalshi-odds-archive/1.0 (+https://github.com/masgitcode/kalshi-odds-archive)';
const REQUEST_TIMEOUT_MS = 15000;

const SERIES_TICKER = { nfl: 'KXNFLGAME', ncaaf: 'KXNCAAFGAME' };
const PAGE_LIMIT = 200;
const MAX_PAGES = 6;

const LOOKBACK_DAYS = 14;
const PERIOD_INTERVAL_MINUTES = 60;
/**
 * Kalshi offers only 1-minute, 1-hour and 1-day candles (5 and 15 return 400),
 * so an hour-scale zoom cannot come from the hourly series — that window would
 * be a single point. A second minute-resolution series covers 24 hours. 1440
 * candles is well inside Kalshi's 5000-per-request cap.
 *
 * The fine window is anchored to the market's OWN last activity, not wall-clock
 * now: a settled game's last 24 hours of wall-clock time contain nothing, so
 * anchoring to now leaves finished games with no minute data at all.
 */
const FINE_INTERVAL_MINUTES = 1;
const FINE_WINDOW_HOURS = 24;
const HISTORY_HORIZON_DAYS = 8;
const SETTLED_LOOKBACK_DAYS = 10;
/** Politeness gap between candlestick calls so we do not become the problem. */
const REQUEST_SPACING_MS = 400;

const LEAGUE = process.env.LEAGUE ?? 'nfl';
const OUT_DIR = process.env.OUT_DIR ?? 'data';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function kalshiFetchJson(path) {
  const response = await fetch(`${KALSHI_API_BASE}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Kalshi ${response.status} ${response.statusText || ''} for ${path}`);
  }
  return response.json();
}

async function fetchSeriesEvents(seriesTicker, status) {
  const events = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      series_ticker: seriesTicker,
      limit: String(PAGE_LIMIT),
      status,
      with_nested_markets: 'true',
    });
    if (cursor) params.set('cursor', cursor);
    const payload = await kalshiFetchJson(`/events?${params.toString()}`);
    events.push(...(payload.events ?? []));
    cursor = payload.cursor ?? '';
    if (!cursor || (payload.events ?? []).length === 0) break;
  }
  return events;
}

function toCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const cents = Math.round(parsed * 100);
  return cents < 0 || cents > 100 ? null : cents;
}

// Quiet hours carry only previous_dollars, so fall through rather than punching
// holes in the line.
function candleToCents(candle) {
  return (
    toCents(candle?.price?.close_dollars) ??
    toCents(candle?.price?.mean_dollars) ??
    toCents(candle?.yes_bid?.close_dollars) ??
    toCents(candle?.price?.previous_dollars)
  );
}

function parseCandles(payload) {
  const points = [];
  for (const candle of payload?.candlesticks ?? []) {
    const t = Number(candle?.end_period_ts);
    if (!Number.isFinite(t) || t <= 0) continue;
    const c = candleToCents(candle);
    if (c == null) continue;
    points.push({ t, c });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Epoch seconds at midnight for a ticker's date. The date in a Kalshi ticker is
 * the EASTERN game date, not UTC — a game at 02:00 UTC Sunday is a Saturday
 * ticker. Only used for coarse horizon filtering here.
 */
function tickerEpoch(eventTicker) {
  const match = /^[A-Z]+-(\d{2})([A-Z]{3})(\d{2})[A-Z]+$/.exec(eventTicker);
  if (!match) return null;
  const month = MONTHS[match[2]];
  if (!month) return null;
  return Date.UTC(2000 + Number(match[1]), month - 1, Number(match[3])) / 1000;
}

function seriesOf(eventTicker) {
  const index = eventTicker.indexOf('-');
  return index > 0 ? eventTicker.slice(0, index) : null;
}

/** The market ticker for the home side: `<event>-<HOME>`, per sub_title. */
function homeMarketTicker(event) {
  const teams = /^([A-Z0-9]+)\s+vs\.?\s+([A-Z0-9]+)\b/.exec(event?.sub_title ?? '');
  if (!teams) return null;
  const home = teams[2];
  const market = (event?.markets ?? []).find(
    (m) => typeof m?.ticker === 'string' && m.ticker.endsWith(`-${home}`),
  );
  return market?.ticker ?? null;
}

async function main() {
  const series = SERIES_TICKER[LEAGUE];
  if (!series) throw new Error(`Unknown league: ${LEAGUE}`);

  const events = await fetchSeriesEvents(series, 'open');
  console.log(`open events: ${events.length}`);
  if (events.length === 0) {
    // Refusing beats publishing nothing: a consumer cannot tell an empty slate
    // from "no market exists", and the previous snapshot stays valid.
    throw new Error('Kalshi returned no open events; refusing to publish an empty snapshot');
  }

  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - LOOKBACK_DAYS * 24 * 60 * 60;
  const horizonTs = endTs + HISTORY_HORIZON_DAYS * 24 * 60 * 60;
  const settledFloorTs = endTs - SETTLED_LOOKBACK_DAYS * 24 * 60 * 60;

  // Settled events carry no usable price — the contract resolved to 0 or 100 —
  // but they carry tickers, which is what lets a finished game still chart its
  // price history.
  let settledEvents = [];
  try {
    const all = await fetchSeriesEvents(series, 'settled');
    settledEvents = all.filter((event) => {
      const epoch = tickerEpoch(event?.event_ticker ?? '');
      return epoch != null && epoch >= settledFloorTs;
    });
    console.log(`settled events (last ${SETTLED_LOOKBACK_DAYS}d): ${settledEvents.length}`);
  } catch (error) {
    console.warn(`settled fetch failed, continuing without it: ${error.message}`);
  }

  const history = [];
  let failed = 0;

  for (const event of [...events, ...settledEvents]) {
    const eventTicker = event?.event_ticker;
    if (!eventTicker) continue;
    const epoch = tickerEpoch(eventTicker);
    if (epoch == null || epoch > horizonTs || epoch < settledFloorTs) continue;
    const s = seriesOf(eventTicker);
    const marketTicker = homeMarketTicker(event);
    if (!s || !marketTicker) continue;

    const params = new URLSearchParams({
      start_ts: String(startTs),
      end_ts: String(endTs),
      period_interval: String(PERIOD_INTERVAL_MINUTES),
    });

    try {
      const payload = await kalshiFetchJson(
        `/series/${s}/markets/${marketTicker}/candlesticks?${params.toString()}`,
      );
      const points = parseCandles(payload);
      if (points.length === 0) continue;

      let finePoints = [];
      try {
        const lastActivityTs = points[points.length - 1].t;
        const fineParams = new URLSearchParams({
          start_ts: String(lastActivityTs - FINE_WINDOW_HOURS * 60 * 60),
          end_ts: String(lastActivityTs),
          period_interval: String(FINE_INTERVAL_MINUTES),
        });
        const finePayload = await kalshiFetchJson(
          `/series/${s}/markets/${marketTicker}/candlesticks?${fineParams.toString()}`,
        );
        finePoints = parseCandles(finePayload);
        await sleep(REQUEST_SPACING_MS);
      } catch {
        // Optional detail; the hourly series still renders every other range.
      }

      history.push({ marketTicker, eventTicker, side: 'home', points, finePoints });
    } catch (error) {
      failed += 1;
      console.warn(`  history failed for ${marketTicker}: ${error.message}`);
    }
    await sleep(REQUEST_SPACING_MS);
  }

  console.log(`history series: ${history.length} fetched, ${failed} failed`);

  // Total history failure means Kalshi has started refusing runners too, which
  // is worth failing loudly over rather than degrading quietly.
  if (history.length === 0 && failed > 0) {
    throw new Error('Every candlestick request failed');
  }

  const snapshot = {
    version: 'v1',
    league: LEAGUE,
    generatedAt: new Date().toISOString(),
    source: 'kalshi',
    eventCount: events.length,
    settledCount: settledEvents.length,
    historyCount: history.length,
    events,
    settledEvents,
    history,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/${LEAGUE}.json`, JSON.stringify(snapshot));
  writeFileSync(
    `${OUT_DIR}/${LEAGUE}.meta.json`,
    JSON.stringify(
      {
        version: 'v1',
        league: LEAGUE,
        generatedAt: snapshot.generatedAt,
        eventCount: snapshot.eventCount,
        settledCount: snapshot.settledCount,
        historyCount: snapshot.historyCount,
      },
      null,
      2,
    ),
  );

  console.log(
    `wrote ${OUT_DIR}/${LEAGUE}.json — events=${events.length} settled=${settledEvents.length} history=${history.length}`,
  );
}

await main();

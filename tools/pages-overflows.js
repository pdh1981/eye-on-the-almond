#!/usr/bin/env node
/*
 * Eye on the Almond, hosted tester site: one Scottish Water overflow poll.
 *
 * Run every 15 minutes by the GitHub Actions workflow in the site repo
 * (.github/workflows/overflows.yml). It reads Scottish Water's open
 * near-real-time overflow feed, adds new spills in the Almond catchment to
 * the spill log, and writes the files the site reads:
 *
 *   data/live/overflow-events.json   spill log (kept in the repo between runs)
 *   data/live/overflow-summary.json  counts for "The Almond today"
 *   data/live/sw-overflows.json      the feed, catchment only, for the map layer
 *
 * Usage: node pages-overflows.js <site folder>
 * Scottish Water data is open data; nothing from SIEC is touched here.
 */
const fs = require("fs");
const path = require("path");

const site = path.resolve(process.argv[2] || ".");
const out = path.join(site, "data", "live");
fs.mkdirSync(out, { recursive: true });
process.env.OVERFLOW_LOG = path.join(out, "overflow-events.json");
process.env.CATCHMENT_GEOJSON =
  process.env.CATCHMENT_GEOJSON || path.join(site, "data", "almond", "catchment.geojson");

const overflowLog = require("./overflow-log.js");

(async () => {
  const ok = await overflowLog.poll();
  if (!ok) {
    // Keep the last good files; the site says how old they are.
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(path.join(out, "overflow-summary.json"), JSON.stringify(overflowLog.summary()));
  fs.writeFileSync(path.join(out, "sw-overflows.json"), JSON.stringify({ results: overflowLog.latestRows() }));
  const s = overflowLog.summary();
  console.log(`${s.overflowsMonitored} overflows in the catchment, ${s.overflowingNow} overflowing now; log since ${s.logStarted}`);
})();

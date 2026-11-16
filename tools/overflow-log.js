/*
 * Overflow event log for the "Almond today" panel.
 *
 * Scottish Water's near-real-time overflow API only gives the latest and the
 * previous spill for each overflow, so it cannot answer "how many spills this
 * month". This module polls the API every 15 minutes, keeps every spill from
 * overflows in the Almond catchment (keyed by Scottish Water's discharge id)
 * in a local JSON file, and serves counts for the last day, week, month and
 * year. Counts are complete only for the period the log has been running;
 * the summary says from when.
 *
 *   GET /overflows/summary  ->  counts, overflowing now, log start
 *
 * Settings (environment variables):
 *   SW_OVERFLOW_URL   default Scottish Water's open API
 *   OVERFLOW_LOG      default overflow-events.json next to start.command
 *   CATCHMENT_GEOJSON default the app's catchment boundary
 */
const fs = require("fs");
const path = require("path");

const API =
  process.env.SW_OVERFLOW_URL ||
  "https://api.scottishwater.co.uk/overflow-event-monitoring/v1/near-real-time";
const POLL_MS = 15 * 60 * 1000;
const NEAR_DEG = 0.003; // count overflows within ~300 m of the boundary

function firstExisting(paths) {
  return paths.find((p) => p && fs.existsSync(p));
}

const LOG_FILE =
  process.env.OVERFLOW_LOG ||
  path.join(
    fs.existsSync(path.join(__dirname, "..", "start.command"))
      ? path.join(__dirname, "..")
      : path.join(__dirname, "..", ".."),
    "overflow-events.json"
  );
const BOUNDARY = firstExisting([
  process.env.CATCHMENT_GEOJSON,
  path.join(__dirname, "..", "wwwroot", "data", "almond", "catchment.geojson"),
  path.join(__dirname, "..", "..", "wwwroot", "data", "almond", "catchment.geojson")
]);

let rings = [];
try {
  const gj = JSON.parse(fs.readFileSync(BOUNDARY, "utf8"));
  const geoms = (gj.features || [gj]).map((f) => f.geometry || f);
  for (const g of geoms) {
    if (g.type === "Polygon") rings.push(g.coordinates[0]);
    if (g.type === "MultiPolygon") g.coordinates.forEach((p) => rings.push(p[0]));
  }
} catch (e) {
  console.error("Overflow log: no catchment boundary, counting all of Scotland:", e.message);
}

function inside([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function nearEdge([x, y], ring) {
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1], [x2, y2] = ring[i];
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) < NEAR_DEG) return true;
  }
  return false;
}

function inCatchment(pt) {
  if (!rings.length) return true;
  return rings.some((r) => inside(pt, r) || nearEdge(pt, r));
}

let rows = []; // the latest feed rows inside the catchment
let log = { started: null, lastPoll: null, assets: {}, events: {}, now: {} };
try {
  log = { ...log, ...JSON.parse(fs.readFileSync(LOG_FILE, "utf8")) };
} catch (e) {
  /* first run */
}

function save() {
  try {
    fs.writeFileSync(LOG_FILE + ".tmp", JSON.stringify(log));
    fs.renameSync(LOG_FILE + ".tmp", LOG_FILE);
  } catch (e) {
    console.error("Overflow log: could not save:", e.message);
  }
}

function addEvent(id, assetId, start, end, minutes) {
  if (!id || !start) return;
  log.events[id] = { asset: assetId, start, end: end || null, minutes: Number(minutes) || null };
}

async function poll() {
  try {
    const res = await fetch(API, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = (await res.json()).results || [];
    const now = {};
    const kept = [];
    for (const r of all) {
      const pt = [parseFloat(r.DISCHARGE_OVERFLOW_LOCATION_LONGITUDE), parseFloat(r.DISCHARGE_OVERFLOW_LOCATION_LATITUDE)];
      if (isNaN(pt[0]) || isNaN(pt[1]) || !inCatchment(pt)) continue;
      kept.push(r);
      log.assets[r.ASSET_ID] = r.ASSET_NAME || r.ASSET_ID;
      now[r.ASSET_ID] = r.OVERFLOW_STATUS_ID; // 13 overflowing, 14 recent, 15 none, 16 no data
      addEvent(r.OVERFLOW_DISCHARGEID, r.ASSET_ID, r.OVERFLOW_START_DATETIME, r.OVERFLOW_END_DATETIME, r.OVERFLOW_DURATION_MIN);
      addEvent(r.OVERFLOW_DISCHARGEID_PREVIOUS, r.ASSET_ID, r.OVERFLOW_START_DATETIME_PREVIOUS, r.OVERFLOW_END_DATETIME_PREVIOUS, r.OVERFLOW_DURATION_MIN_PREVIOUS);
    }
    rows = kept;
    log.now = now;
    log.lastPoll = new Date().toISOString();
    log.started = log.started || log.lastPoll;
    save();
    return true;
  } catch (e) {
    console.error(new Date().toISOString(), "Overflow log: poll failed:", e.message, e.cause ? `(${e.cause.code || e.cause.message})` : "");
  }
}

const WINDOWS = { day: 1, week: 7, month: 30, year: 365 };

function summary() {
  const nowMs = Date.now();
  const started = log.started ? Date.parse(log.started) : nowMs;
  const events = Object.values(log.events);
  const counts = {};
  for (const [k, days] of Object.entries(WINDOWS)) {
    const from = nowMs - days * 864e5;
    const hits = events.filter((e) => Date.parse(e.start) >= from || (e.end && Date.parse(e.end) >= from));
    counts[k] = {
      spills: hits.length,
      overflows: new Set(hits.map((e) => e.asset)).size,
      minutes: Math.round(hits.reduce((s, e) => s + (e.minutes || 0), 0)),
      // The log only knows about spills since it started (plus each
      // overflow's last two spills at that time), so older windows undercount.
      complete: from >= started
    };
  }
  const status = Object.values(log.now || {});
  return {
    source: "Scottish Water near-real-time overflow monitoring",
    overflowsMonitored: Object.keys(log.assets).length,
    overflowingNow: status.filter((s) => s === "13").length,
    noData: status.filter((s) => s === "16").length,
    logStarted: log.started,
    lastPoll: log.lastPoll,
    counts
  };
}

function start() {
  poll();
  setInterval(poll, POLL_MS).unref();
  console.log(`Overflow log: polling Scottish Water every 15 minutes, saving to ${LOG_FILE}`);
}

module.exports = { start, summary, poll, latestRows: () => rows };

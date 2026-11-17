/*
 * Eye on the Almond: river data page (the charts behind "The Almond today").
 *
 *   trends/#rain    rainfall from SEPA's gauges in the catchment
 *   trends/#spills  sewer overflow spills from the spill log
 *   trends/#health  SEPA's classification of each river stretch
 *
 * Settings come from ../data/almond/indicators.json, the same file as the
 * panel. The spill log is read from overflowEventsUrl (hosted site: the file
 * the GitHub job writes) or from the local helper (<helperUrl>/overflows/events).
 */
(function () {
  "use strict";

  const CLASSES = ["High", "Good", "Moderate", "Poor", "Bad"];
  const CLASS_COLOUR = { High: "#3a7dc9", Good: "#4c9a2a", Moderate: "#e8c124", Poor: "#e07b26", Bad: "#c0392b" };
  const BLUE = "#2f6f9f", AMBER = "#f2a93b", GREY = "#9aa5ae";
  const DAY = 864e5;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v, d = 1) => (v == null || !isFinite(v) ? "–" : v.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const fmtDate = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const fmtWhen = (t) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const charts = [];
  const chart = (id) => {
    const c = echarts.init($(id));
    charts.push(c);
    return c;
  };
  window.addEventListener("resize", () => charts.forEach((c) => c.resize()));

  async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function rangeButtons(el, options, current, onPick) {
    el.innerHTML = "";
    options.forEach(([label, days]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = days === current ? "active" : "";
      b.onclick = () => {
        [...el.children].forEach((x) => (x.className = ""));
        b.className = "active";
        onPick(days);
      };
      el.appendChild(b);
    });
  }

  const tiles = (el, items) =>
    (el.innerHTML = items.map(([v, l]) => `<div class="tile"><b>${v}</b><span>${esc(l)}</span></div>`).join(""));

  // ---------- rainfall ----------
  async function showRain(cfg) {
    const r = cfg.rainfall;
    $("rain-gauges").textContent = r.gauges.map((g) => g.name).join(" and ");
    const now = new Date();
    const from = new Date(now.getFullYear() - 6, now.getMonth(), 1);
    const url = `${r.kiwisUrl}?` + new URLSearchParams({
      service: "kisters", type: "queryServices", datasource: "0", format: "json",
      request: "getTimeseriesValues", returnfields: "Timestamp,Value",
      ts_id: r.gauges.map((g) => g.dayTsId).join(","),
      from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10)
    });
    const series = await getJson(url);
    // Average of the gauges that reported each day.
    const byDay = new Map();
    for (const s of series) for (const [t, v] of s.data || []) {
      if (v == null) continue;
      const d = t.slice(0, 10);
      const e = byDay.get(d) || { sum: 0, n: 0 };
      e.sum += Number(v); e.n++;
      byDay.set(d, e);
    }
    const days = [...byDay.keys()].sort().map((d) => [d, byDay.get(d).sum / byDay.get(d).n]);
    if (!days.length) throw new Error("no rainfall data");
    const last = Date.parse(days[days.length - 1][0]);
    const total = (n) => days.filter(([d]) => Date.parse(d) > last - n * DAY).reduce((s, [, v]) => s + v, 0);
    tiles($("rain-tiles"), [
      [`${fmt(total(1))} mm`, `day to 09:00 ${fmtDate(last)}`],
      [`${fmt(total(7))} mm`, "last 7 days"],
      [`${fmt(total(30))} mm`, "last 30 days"],
      [`${fmt(total(365), 0)} mm`, "last 365 days"]
    ]);

    const daily = chart("rain-daily");
    const drawDaily = (n) => {
      const sel = days.filter(([d]) => Date.parse(d) > last - n * DAY);
      let run = 0;
      const cum = sel.map(([d, v]) => [d, +(run += v).toFixed(1)]);
      daily.setOption({
        grid: { left: 50, right: 60, top: 30, bottom: 40 },
        tooltip: { trigger: "axis", valueFormatter: (v) => `${fmt(v)} mm` },
        legend: { top: 0, data: ["Daily rainfall", "Running total"] },
        xAxis: { type: "time" },
        yAxis: [{ type: "value", name: "mm/day" }, { type: "value", name: "total mm", splitLine: { show: false } }],
        series: [
          { name: "Daily rainfall", type: "bar", data: sel, itemStyle: { color: BLUE }, barMaxWidth: 14 },
          { name: "Running total", type: "line", yAxisIndex: 1, data: cum, showSymbol: false, lineStyle: { color: AMBER, width: 2 }, itemStyle: { color: AMBER } }
        ]
      }, true);
    };
    rangeButtons($("rain-ranges"), [["30 days", 30], ["90 days", 90], ["1 year", 365]], 90, drawDaily);
    drawDaily(90);

    // Monthly totals: the last 12 complete months and this month so far,
    // against the average of the same month in the years before.
    const monthly = new Map();
    for (const [d, v] of days) monthly.set(d.slice(0, 7), (monthly.get(d.slice(0, 7)) || 0) + v);
    const months = [];
    for (let i = 12; i >= 0; i--) {
      const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
    }
    const thisMonth = months[months.length - 1];
    const avgFor = (ym) => {
      const [y, m] = ym.split("-").map(Number);
      const prev = [];
      for (let k = 1; k <= 5; k++) {
        const key = `${y - k}-${String(m).padStart(2, "0")}`;
        if (monthly.has(key)) prev.push(monthly.get(key));
      }
      return prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
    };
    const label = (ym) => new Date(ym + "-01").toLocaleDateString("en-GB", { month: "short", year: "2-digit" }) + (ym === thisMonth ? " (so far)" : "");
    chart("rain-monthly").setOption({
      grid: { left: 50, right: 20, top: 30, bottom: 40 },
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "–" : `${fmt(v, 0)} mm`) },
      legend: { top: 0, data: ["Monthly total", "Average of the 5 years before"] },
      xAxis: { type: "category", data: months.map(label) },
      yAxis: { type: "value", name: "mm" },
      series: [
        { name: "Monthly total", type: "bar", data: months.map((m) => (monthly.has(m) ? +monthly.get(m).toFixed(1) : null)), itemStyle: { color: BLUE }, barMaxWidth: 34 },
        { name: "Average of the 5 years before", type: "line", data: months.map((m) => { const a = avgFor(m); return a == null ? null : +a.toFixed(1); }), lineStyle: { color: AMBER, width: 2 }, itemStyle: { color: AMBER }, symbolSize: 7 }
      ]
    });
    $("rain-monthly-note").textContent = `Daily data from ${fmtDate(days[0][0])}. Where a gauge has gaps, the average uses the gauges that reported.`;
  }

  // ---------- sewer spills ----------
  async function showSpills(cfg) {
    // Relative paths in the settings are from the site root, one level up.
    const url = cfg.overflowEventsUrl
      ? new URL(cfg.overflowEventsUrl, new URL("../", location.href)).href
      : `${cfg.helperUrl}/overflows/events`;
    let log;
    try {
      log = await getJson(url);
    } catch (e) {
      $("spill-log-note").textContent = cfg.overflowEventsUrl
        ? "The spill log could not be loaded. Try again in a few minutes."
        : "The spill log is kept by the local helper. Run start.command to see it.";
      return;
    }
    const assets = log.assets || {};
    const nowStatus = log.now || {};
    const events = Object.values(log.events || {})
      .map((e) => ({ ...e, t: Date.parse(e.start), name: assets[e.asset] || e.asset }))
      .filter((e) => isFinite(e.t))
      .sort((a, b) => a.t - b.t);
    const started = log.started ? Date.parse(log.started) : Date.now();
    const now = Date.now();
    const inLast = (n) => events.filter((e) => e.t >= now - n * DAY || (e.end && Date.parse(e.end) >= now - n * DAY));
    const plus = (n) => (now - n * DAY < started ? "+" : "");
    const overflowing = Object.values(nowStatus).filter((s) => s === "13").length;
    tiles($("spill-tiles"), [
      [Object.keys(assets).length, "overflows monitored"],
      [overflowing, "overflowing now"],
      [inLast(1).length + plus(1), "spills, last 24 hours"],
      [inLast(7).length + plus(7), "spills, last 7 days"],
      [inLast(30).length + plus(30), "spills, last 30 days"],
      [inLast(365).length + plus(365), "spills, last year"]
    ]);
    $("spill-log-note").textContent =
      `The spill log started on ${fmtDate(started)}. Before that it only knows each overflow's last two spills at the time, ` +
      `so counts marked + and the chart before that date are incomplete. Last checked ${fmtWhen(log.lastPoll || started)}.`;

    const daily = chart("spill-daily");
    const draw = (n) => {
      const from = n ? now - n * DAY : events.length ? events[0].t : now;
      const counts = new Map(), hours = new Map();
      for (const e of events) {
        if (e.t < from) continue;
        const d = new Date(e.t).toISOString().slice(0, 10);
        counts.set(d, (counts.get(d) || 0) + 1);
        hours.set(d, (hours.get(d) || 0) + (e.minutes || 0) / 60);
      }
      const keys = [];
      for (let t = Date.parse(new Date(from).toISOString().slice(0, 10)); t <= now; t += DAY) keys.push(new Date(t).toISOString().slice(0, 10));
      daily.setOption({
        grid: { left: 50, right: 60, top: 30, bottom: 40 },
        tooltip: { trigger: "axis" },
        legend: { top: 0, data: ["Spills", "Hours spilling"] },
        xAxis: { type: "time" },
        yAxis: [{ type: "value", name: "spills", minInterval: 1 }, { type: "value", name: "hours", splitLine: { show: false } }],
        series: [
          { name: "Spills", type: "bar", data: keys.map((k) => [k, counts.get(k) || 0]), itemStyle: { color: BLUE }, barMaxWidth: 14 },
          { name: "Hours spilling", type: "line", yAxisIndex: 1, data: keys.map((k) => [k, +(hours.get(k) || 0).toFixed(1)]), showSymbol: false, lineStyle: { color: AMBER, width: 2 }, itemStyle: { color: AMBER } }
        ],
      }, true);
    };
    rangeButtons($("spill-ranges"), [["30 days", 30], ["90 days", 90], ["1 year", 365]], 30, draw);
    draw(30);

    // Table: each overflow with its spills in the last 30 days.
    const from30 = now - 30 * DAY;
    const rows = Object.keys(assets).map((id) => {
      const own = events.filter((e) => e.asset === id);
      const recent = own.filter((e) => e.t >= from30);
      const lastSpill = own.length ? own[own.length - 1] : null;
      return {
        name: assets[id], spills: recent.length,
        hours: recent.reduce((s, e) => s + (e.minutes || 0), 0) / 60,
        last: lastSpill ? lastSpill.t : null, status: nowStatus[id]
      };
    }).sort((a, b) => b.spills - a.spills || b.hours - a.hours || (b.last || 0) - (a.last || 0));
    const statusText = { "13": "Overflowing now", "14": "Spilled recently", "15": "Not overflowing", "16": "No data" };
    $("spill-table-period").textContent = "Spills and hours in the last 30 days";
    $("spill-table").innerHTML =
      "<thead><tr><th>Overflow</th><th class=num>Spills</th><th class=num>Hours</th><th>Last spill started</th><th>Now</th></tr></thead><tbody>" +
      rows.map((r) => `<tr><td>${esc(r.name)}</td><td class=num>${r.spills}</td><td class=num>${fmt(r.hours)}</td><td>${r.last ? fmtWhen(r.last) : "–"}</td><td>${r.status === "13" ? '<span class="pill" style="background:#c0392b">Overflowing now</span>' : esc(statusText[r.status] || "")}</td></tr>`).join("") +
      "</tbody>";
  }

  // ---------- river health ----------
  async function showHealth(cfg) {
    const c = cfg.classification;
    const gj = await getJson("../" + c.url);
    const prop = c.property || "overall_classification";
    const feats = (gj.features || []).map((f) => f.properties || {});
    const year = feats.find((p) => p.classification_year)?.classification_year || c.year;
    $("health-year").textContent = year ? `${year}` : "";
    const count = CLASSES.map((k) => feats.filter((p) => p[prop] === k).length);
    chart("health-chart").setOption({
      grid: { left: 90, right: 30, top: 10, bottom: 30 },
      tooltip: { trigger: "item", formatter: (p) => `${p.name}: ${p.value} stretches` },
      xAxis: { type: "value", minInterval: 1, name: "stretches", nameLocation: "middle", nameGap: 22 },
      yAxis: { type: "category", data: CLASSES.slice().reverse(), inverse: false },
      series: [{
        type: "bar", barMaxWidth: 26,
        data: CLASSES.slice().reverse().map((k) => ({ value: count[CLASSES.indexOf(k)], itemStyle: { color: CLASS_COLOUR[k] } })),
        label: { show: true, position: "right" }
      }]
    });
    const order = (k) => CLASSES.indexOf(k);
    const rows = feats.slice().sort((a, b) => order(b[prop]) - order(a[prop]) || String(a.water_body_name).localeCompare(b.water_body_name));
    $("health-table").innerHTML =
      "<thead><tr><th>Stretch</th><th>River</th><th class=num>Length</th><th>Status</th><th>Certainty</th><th></th></tr></thead><tbody>" +
      rows.map((p) => `<tr><td>${esc(p.water_body_name)}</td><td>${esc(p.river_name)}</td><td class=num>${fmt(p.length_km)} km</td><td><span class="pill" style="background:${CLASS_COLOUR[p[prop]] || GREY};${p[prop] === "Moderate" ? "color:#1d2329" : ""}">${esc(p[prop] || "–")}</span></td><td>${esc(p.certainty_band || "")}</td><td>${p.class_ds_url ? `<a href="${esc(p.class_ds_url)}" target="_blank" rel="noopener">SEPA details</a>` : ""}</td></tr>`).join("") +
      "</tbody>";
  }

  // ---------- views ----------
  const loaded = {};
  let cfg;
  async function show(view) {
    if (!["rain", "spills", "health"].includes(view)) view = "rain";
    document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== view));
    document.querySelectorAll(".views a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
    if (!loaded[view]) {
      loaded[view] = true;
      $("status").textContent = "Loading…";
      try {
        await ({ rain: showRain, spills: showSpills, health: showHealth })[view](cfg);
        $("status").textContent = "";
      } catch (e) {
        loaded[view] = false;
        $("status").textContent = `The data could not be loaded (${e.message}). Try again later.`;
      }
    }
    charts.forEach((c) => c.resize());
  }

  (async function start() {
    cfg = await getJson("../data/almond/indicators.json");
    window.addEventListener("hashchange", () => show(location.hash.slice(1)));
    show(location.hash.slice(1));
  })();
})();

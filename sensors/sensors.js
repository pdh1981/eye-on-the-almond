/*
 * Eye on the Almond: sensor explorer.
 *
 * A companion page to the map for looking at SIEC Forth-ERA sensors and the
 * monthly MOT sampling as time series: pick a site, see everything it
 * measures, tick parameters to chart them (they stay on the chart when you
 * move to another site, so sites can be compared).
 *
 * Data comes from the local SenseH2O helper (start.command), which signs in
 * to SIEC's SensorThings (FROST) server: http://localhost:3003/sta.
 * Add ?sta=<url> to the address to use another SensorThings server.
 *
 * Link to a site with sensors/#site=SEPA02 (Thing name of the platform, or
 * the MOT site code such as MOT-NID-3).
 */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  // On the hosted site (siec-auth.json present) each visitor signs in to SIEC
  // and the page reads SIEC's server directly; see ../siec-auth.js.
  const AUTH = window.SiecAuth;
  let STA = (params.get("sta") || "http://localhost:3003/sta").replace(/\/+$/, "");
  const hosted = () => !!(AUTH && AUTH.enabled());
  // Rough box around the Almond catchment; sites are then checked against the boundary.
  const AREA = "geography'POLYGON((-3.86 55.74,-3.24 55.74,-3.24 56.0,-3.86 56.0,-3.86 55.74))'";
  const NEAR_DEG = 0.003; // count sites within ~300 m of the boundary as inside
  const COLOURS = ["#2f6f9f", "#e0892b", "#2a9d8f", "#6b5b95", "#c0504d", "#4a90c2", "#8c6d31", "#d16ba5"];
  const RANGES = {
    live: [["24 h", 1], ["7 days", 7], ["30 days", 30], ["90 days", 90]],
    mot: [["1 year", 365], ["2 years", 730], ["All", 0]]
  };
  // Ranges count back from each series' latest reading, not from today, so
  // sampling data that stopped a while ago still plots. 0 means everything.
  const DEFAULT_RANGE = { live: 7, mot: 0 };
  const MAX_POINTS = 50000;

  const $ = (id) => document.getElementById(id);
  const state = {
    sites: new Map(), // id -> site
    kind: "live",
    site: null, // selected site id
    range: { live: DEFAULT_RANGE.live, mot: DEFAULT_RANGE.mot },
    series: new Map(), // datastream id -> { site, param, unit, colour, data, kind }
    boundary: [],
    markers: new Map()
  };

  // ---------- helpers ----------
  const fmtNum = (v) =>
    typeof v !== "number" ? String(v ?? "") :
    Math.abs(v) >= 1000 ? v.toLocaleString("en-GB", { maximumFractionDigits: 0 }) :
    v.toLocaleString("en-GB", { maximumFractionDigits: 3 });
  const fmtWhen = (d, kind) =>
    !d ? "" : kind === "mot"
      ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const timeOf = (t) => new Date(String(t).split("/").pop());
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const status = (msg) => ($("status").textContent = msg);

  async function getJson(url) {
    if (hosted()) return AUTH.fetchJson(url);
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /** Follows @iot.nextLink, sending each page back through our STA base. */
  async function getAll(url, limit) {
    const out = [];
    for (let page = 0; url && page < 60 && out.length < limit; page++) {
      const j = await getJson(url);
      out.push(...(j.value || []));
      const next = j["@iot.nextLink"];
      url = next ? STA + next.replace(/^.*?\/v1\.[01]/, "") : null;
    }
    return out;
  }

  function pointOf(loc) {
    const g = loc && loc.type === "Feature" ? loc.geometry : loc;
    return g && g.type === "Point" && Array.isArray(g.coordinates) ? g.coordinates.map(Number) : null;
  }

  // Point in or near the catchment polygon(s)
  function insideRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distToRing([x, y], ring) {
    let best = Infinity;
    for (let i = 1; i < ring.length; i++) {
      const [x1, y1] = ring[i - 1], [x2, y2] = ring[i];
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
    }
    return best;
  }
  function inCatchment(pt) {
    if (!state.boundary.length) return true;
    return state.boundary.some((poly) => insideRing(pt, poly[0]) || distToRing(pt, poly[0]) < NEAR_DEG);
  }

  // ---------- sites ----------
  function siteIdOf(t) {
    if (t.properties && t.properties.parentUid) return t.properties.parentUid;
    const m = /^(.*)-\d+$/.exec(t.name || "");
    return m ? m[1] : t.name;
  }
  function placeOf(desc) {
    const m = / (?:near|on|at) (.+)$/i.exec(desc || "");
    return m ? m[1] : null;
  }

  async function loadSites() {
    const expand =
      "Locations($select=location),Datastreams($select=id,name,unitOfMeasurement;" +
      "$expand=ObservedProperty($select=name),Observations($orderby=phenomenonTime desc;$top=1;$select=result,phenomenonTime))";
    const q = (filter) =>
      `${STA}/Things?` + new URLSearchParams({ $top: "200", $select: "id,name,description,properties", ...(filter ? { $filter: filter } : {}), $expand: expand });
    let things;
    try {
      things = await getAll(q(`st_intersects(Locations/location,${AREA})`), 5000);
    } catch (e) {
      things = await getAll(q(null), 5000); // server without geo filters
    }
    const byName = new Map(things.map((t) => [t.name, t]));
    const sites = new Map();
    for (const t of things) {
      const id = siteIdOf(t);
      const parent = byName.get(id) || t;
      const pt = pointOf(parent.Locations && parent.Locations[0] && parent.Locations[0].location) ||
        pointOf(t.Locations && t.Locations[0] && t.Locations[0].location);
      if (!pt) continue;
      if (!sites.has(id)) {
        const place = placeOf(t.description) || placeOf(parent.description);
        sites.set(id, {
          id, pt, kind: /^MOT/i.test(id) ? "mot" : "live",
          name: place || parent.description || id,
          platform: parent !== t || parent.name === id ? parent.description : "",
          useCase: (parent.properties && parent.properties.useCase) || [],
          params: []
        });
      }
      const site = sites.get(id);
      for (const d of t.Datastreams || []) {
        const prop = (d.ObservedProperty && d.ObservedProperty.name) || d.name;
        if (/^Ancillary$/i.test(prop)) continue; // battery, signal strength
        const unit = ((d.unitOfMeasurement && d.unitOfMeasurement.symbol) || "").trim();
        const o = d.Observations && d.Observations[0];
        site.params.push({
          ds: d["@iot.id"], name: prop, unit: unit === "-" ? "" : unit, group: t.description || "",
          latest: o ? o.result : undefined, when: o ? timeOf(o.phenomenonTime) : null
        });
      }
    }
    for (const s of sites.values()) {
      s.params.sort((a, b) => a.name.localeCompare(b.name));
      const newest = Math.max(0, ...s.params.map((p) => (p.when ? p.when.getTime() : 0)));
      s.newest = newest ? new Date(newest) : null;
      s.inside = inCatchment(s.pt);
      const ageH = newest ? (Date.now() - newest) / 3.6e6 : Infinity;
      s.active = s.kind === "mot" ? ageH < 24 * 62 : ageH < 6;
    }
    state.sites = new Map([...sites].filter(([, s]) => s.params.length > 0));
  }

  // ---------- list and map ----------
  function siteColour(s) {
    // Sampling sites are always shown in purple; live sensors go grey when silent.
    return s.kind === "mot" ? "#6b5b95" : s.active ? "#2a9d8f" : "#9aa4ad";
  }

  function visibleSites() {
    const q = $("search").value.trim().toLowerCase();
    const outside = $("outside").checked;
    return [...state.sites.values()]
      .filter((s) => s.kind === state.kind && (outside || s.inside))
      .filter((s) => !q || (s.name + " " + s.id + " " + s.params.map((p) => p.name).join(" ")).toLowerCase().includes(q))
      .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  }

  function renderList() {
    const list = visibleSites();
    $("site-list").innerHTML = list.length
      ? list.map((s) => `
        <li data-id="${esc(s.id)}" class="${s.id === state.site ? "active" : ""}" tabindex="0">
          <span class="dot" style="background:${siteColour(s)}"></span>
          <div><div class="name">${esc(s.name)} <span class="muted">${esc(s.id)}</span></div>
          <div class="sub">${s.params.length} parameter${s.params.length === 1 ? "" : "s"} · ${s.newest ? "latest " + esc(fmtWhen(s.newest, s.kind)) : "no readings"}</div></div>
        </li>`).join("")
      : `<li class="muted" style="cursor:default">No sites match.</li>`;
    renderMarkers(list);
  }

  let map, layer;
  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true }).setView([55.89, -3.52], 10);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18, attribution: "Imagery © Esri, Maxar, Earthstar Geographics"
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }

  function renderMarkers(list) {
    layer.clearLayers();
    state.markers.clear();
    if (state.boundary.length) {
      L.geoJSON({ type: "MultiPolygon", coordinates: state.boundary }, {
        style: { color: "#f2a93b", weight: 2, fill: false }, interactive: false
      }).addTo(layer);
    }
    for (const s of list) {
      const active = s.id === state.site;
      const m = L.marker([s.pt[1], s.pt[0]], {
        icon: L.divIcon({ className: "", html: `<div class="pin${active ? " active" : ""}" style="background:${siteColour(s)}"></div>`, iconSize: active ? [22, 22] : [16, 16] }),
        title: s.name, zIndexOffset: active ? 1000 : 0
      }).on("click", () => selectSite(s.id));
      m.addTo(layer);
      state.markers.set(s.id, m);
    }
  }

  // ---------- site detail ----------
  function selectSite(id, { pan = true } = {}) {
    const s = state.sites.get(id);
    if (!s) return;
    if (s.kind !== state.kind) setKind(s.kind, false);
    if (!s.inside && !$("outside").checked) $("outside").checked = true;
    state.site = id;
    $("site-empty").hidden = true;
    $("site-detail").hidden = false;
    $("site-name").textContent = `${s.name} (${s.id})`;
    $("site-meta").textContent = [
      s.kind === "mot" ? "Monthly water sampling (MOT)" : "Live sensor",
      s.platform, s.useCase.length ? "Use: " + s.useCase.join(", ") : "",
      s.inside ? "" : "Just outside the catchment"
    ].filter(Boolean).join(" · ");
    renderParams();
    renderList();
    if (pan) map.panTo([s.pt[1], s.pt[0]]);
    writeHash();
  }

  function renderParams() {
    const s = state.sites.get(state.site);
    if (!s) return;
    $("param-rows").innerHTML = s.params.map((p) => {
      const on = state.series.has(String(p.ds));
      const stale = p.when && s.kind === "live" && Date.now() - p.when > 6 * 3.6e6;
      return `<tr data-ds="${esc(p.ds)}" class="${on ? "on" : ""}">
        <td><input type="checkbox" ${on ? "checked" : ""} aria-label="Chart ${esc(p.name)}" /></td>
        <td>${esc(p.name)}${p.unit ? ` <span class="muted">(${esc(p.unit)})</span>` : ""}</td>
        <td class="num ${stale ? "stale" : ""}">${p.latest === undefined ? "–" : esc(fmtNum(p.latest))}</td>
        <td class="${stale ? "stale" : ""}">${p.when ? esc(fmtWhen(p.when, s.kind)) : "none yet"}</td></tr>`;
    }).join("");
  }

  // ---------- chart ----------
  const chart = echarts.init($("chart"), null, { renderer: "canvas" });
  window.addEventListener("resize", () => chart.resize());

  function nextColour() {
    const used = new Set([...state.series.values()].map((s) => s.colour));
    return COLOURS.find((c) => !used.has(c)) || COLOURS[state.series.size % COLOURS.length];
  }

  async function loadSeries(entry) {
    const days = state.range[entry.kind];
    const q = { $orderby: "phenomenonTime asc", $top: "5000", $select: "result,phenomenonTime" };
    if (days) {
      const end = entry.latest ? entry.latest.getTime() : Date.now();
      q.$filter = `phenomenonTime ge ${new Date(end - days * 864e5).toISOString()}`;
    }
    const url = `${STA}/Datastreams(${entry.ds})/Observations?` + new URLSearchParams(q);
    entry.loading = true;
    renderChart();
    try {
      const obs = await getAll(url, MAX_POINTS);
      entry.data = obs
        .map((o) => [timeOf(o.phenomenonTime).getTime(), typeof o.result === "number" ? o.result : parseFloat(o.result)])
        .filter(([t, v]) => !isNaN(t) && !isNaN(v));
      entry.error = null;
    } catch (e) {
      entry.error = e.message;
      entry.data = [];
    }
    entry.loading = false;
  }

  async function toggleSeries(ds) {
    ds = String(ds);
    if (state.series.has(ds)) {
      state.series.delete(ds);
    } else {
      const s = state.sites.get(state.site);
      const p = s && s.params.find((x) => String(x.ds) === String(ds));
      if (!p) return;
      const entry = { ds: p.ds, site: s.name, siteId: s.id, param: p.name, unit: p.unit, kind: s.kind, latest: p.when, colour: nextColour(), data: [] };
      state.series.set(ds, entry);
      renderParams();
      await loadSeries(entry);
    }
    renderParams();
    renderChart();
    writeHash();
  }

  function renderRanges() {
    const kinds = new Set([...state.series.values()].map((s) => s.kind));
    const kind = kinds.size === 1 ? [...kinds][0] : state.kind;
    $("ranges").innerHTML = RANGES[kind].map(([label, days]) =>
      `<button data-days="${days}" data-kind="${kind}" class="${state.range[kind] === days ? "active" : ""}">${label}</button>`).join("");
  }

  function renderChart() {
    const series = [...state.series.values()];
    $("chips").innerHTML = series.map((s) =>
      `<span class="chip"><i style="background:${s.colour}"></i>${esc(s.param)} · ${esc(s.site)}${s.loading ? " (loading…)" : s.error ? " (failed)" : !s.data.length ? " (no readings)" : ""}
       <button data-ds="${esc(s.ds)}" aria-label="Remove ${esc(s.param)} at ${esc(s.site)}">×</button></span>`).join("");
    $("download").disabled = $("clear").disabled = series.length === 0;
    $("chart-empty").hidden = series.length > 0;
    $("chart").style.display = series.length ? "block" : "none";
    renderRanges();
    if (!series.length) { chart.clear(); return; }

    // One panel per unit, stacked, sharing the time axis.
    const units = [...new Set(series.map((s) => s.unit || s.param))];
    const panelH = units.length === 1 ? 300 : 190;
    const top = 30, gap = 46, bottom = 70;
    const height = top + units.length * panelH + (units.length - 1) * gap + bottom;
    $("chart").style.height = height + "px";
    chart.resize();
    const grids = units.map((u, i) => ({ left: 70, right: 30, top: top + i * (panelH + gap), height: panelH }));
    chart.setOption({
      animation: false,
      color: series.map((s) => s.colour),
      grid: grids,
      tooltip: {
        trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
        valueFormatter: (v) => fmtNum(v)
      },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      xAxis: units.map((u, i) => ({
        type: "time", gridIndex: i,
        axisLabel: {
          show: i === units.length - 1, hideOverlap: true,
          formatter: { year: "{yyyy}", month: "{MMM} {yyyy}", day: "{ee} {d} {MMM}", hour: "{HH}:{mm}", minute: "{HH}:{mm}" }
        },
        axisLine: { lineStyle: { color: "#9aa4ad" } }
      })),
      yAxis: units.map((u, i) => {
        const same = series.filter((s) => (s.unit || s.param) === u);
        const params = [...new Set(same.map((s) => s.param))];
        const positive = same.every((s) => s.data.every(([, v]) => v > 0));
        return {
          type: $("log").checked && positive ? "log" : "value", gridIndex: i, scale: true, name: params.join(", ") + (same[0].unit ? ` (${same[0].unit})` : ""),
          nameTextStyle: { align: "left", color: "#5d6973" }, splitLine: { lineStyle: { color: "#eef2f5" } },
          axisLabel: { formatter: (v) => fmtNum(v) }
        };
      }),
      dataZoom: [
        { type: "inside", xAxisIndex: units.map((_, i) => i) },
        { type: "slider", xAxisIndex: units.map((_, i) => i), bottom: 16, height: 26 }
      ],
      series: series.map((s) => {
        const i = units.indexOf(s.unit || s.param);
        const sparse = s.data.length < 60;
        return {
          name: `${s.param} · ${s.site}`, type: "line", xAxisIndex: i, yAxisIndex: i, data: s.data,
          showSymbol: sparse, symbolSize: 6, sampling: "lttb", lineStyle: { width: 1.8 }, emphasis: { focus: "series" }
        };
      })
    }, true);
  }

  function downloadCsv() {
    const rows = [["time", "site", "site_id", "parameter", "unit", "value"]];
    for (const s of state.series.values())
      for (const [t, v] of s.data) rows.push([new Date(t).toISOString(), s.site, s.siteId, s.param, s.unit, v]);
    const csv = rows.map((r) => r.map((c) => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "almond-sensor-data.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- tabs, hash, events ----------
  function setKind(kind, render = true) {
    state.kind = kind;
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.kind === kind);
      b.setAttribute("aria-selected", String(b.dataset.kind === kind));
    });
    if (render) renderList();
    renderRanges();
  }

  function writeHash() {
    const h = new URLSearchParams();
    if (state.site) h.set("site", state.site);
    if (state.series.size) h.set("ds", [...state.series.keys()].join(","));
    history.replaceState(null, "", "#" + h.toString());
  }

  function bind() {
    document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.kind)));
    $("search").addEventListener("input", renderList);
    $("outside").addEventListener("change", renderList);
    $("site-list").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      if (li) selectSite(li.dataset.id);
    });
    $("site-list").addEventListener("keydown", (e) => {
      const li = e.target.closest("li[data-id]");
      if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectSite(li.dataset.id); }
    });
    $("param-rows").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-ds]");
      if (!tr) return;
      if (e.target.tagName !== "INPUT") e.preventDefault();
      toggleSeries(tr.dataset.ds);
    });
    $("chips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-ds]");
      if (b) toggleSeries(b.dataset.ds);
    });
    $("ranges").addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-days]");
      if (!b) return;
      state.range[b.dataset.kind] = Number(b.dataset.days);
      await Promise.all([...state.series.values()].filter((s) => s.kind === b.dataset.kind).map(loadSeries));
      renderChart();
    });
    $("download").addEventListener("click", downloadCsv);
    $("log").addEventListener("change", renderChart);
    $("clear").addEventListener("click", () => { state.series.clear(); renderParams(); renderChart(); writeHash(); });
  }

  // ---------- start ----------
  function authBar() {
    const el = $("auth");
    if (!el || !hosted()) return;
    el.hidden = false;
    el.innerHTML = AUTH.signedIn()
      ? `Signed in${AUTH.user() ? " as " + esc(AUTH.user()) : ""} · <button type="button" class="linkish" id="signout">Sign out</button>`
      : `<button type="button" class="btn" id="signin">Sign in with SIEC</button>`;
    const i = $("signin"), o = $("signout");
    if (i) i.onclick = () => AUTH.signIn();
    if (o) o.onclick = () => AUTH.signOut();
  }

  async function start() {
    if (AUTH) {
      await AUTH.ready;
      if (hosted() && !params.get("sta")) STA = AUTH.staUrl();
      authBar();
      AUTH.onChange(authBar);
    }
    bind();
    initMap();
    setKind("live", false);
    try {
      const b = await getJson("../data/almond/catchment.geojson");
      for (const f of b.features || []) {
        const g = f.geometry;
        if (g.type === "Polygon") state.boundary.push(g.coordinates);
        if (g.type === "MultiPolygon") state.boundary.push(...g.coordinates);
      }
      if (state.boundary.length)
        map.fitBounds(L.geoJSON({ type: "MultiPolygon", coordinates: state.boundary }).getBounds(), { padding: [8, 8] });
    } catch (e) { /* no boundary: show all sites */ }
    try {
      await loadSites();
    } catch (e) {
      if (e && e.signInNeeded) {
        status("Sign in to see the sensors");
        $("site-list").innerHTML = `<li class="muted" style="cursor:default">SIEC sensor data is only shown to signed-in users. Use <b>Sign in with SIEC</b> at the top of the page with your SIEC account.</li>`;
        return;
      }
      if (hosted()) {
        status("Can't reach SIEC");
        $("site-list").innerHTML = `<li class="muted" style="cursor:default">The sensor data could not be loaded (${esc(e.message)}).</li>`;
        return;
      }
      status("Can't reach the SenseH2O helper");
      $("site-list").innerHTML = `<li class="muted" style="cursor:default">The sensor data could not be loaded (${esc(e.message)}). The SenseH2O helper runs with start.command and needs your SIEC sign-in saved in the Keychain (see README.txt).</li>`;
      return;
    }
    const n = (k) => [...state.sites.values()].filter((s) => s.kind === k && s.inside).length;
    status(`${n("live")} live sites and ${n("mot")} sampling sites in the catchment`);
    const h = new URLSearchParams(location.hash.slice(1));
    // #ds=<ids> alone opens the site that holds the first of those datastreams.
    const firstDs = (h.get("ds") || "").split(",").filter(Boolean)[0];
    const want = h.get("site") ||
      (firstDs ? ([...state.sites.values()].find((s) => s.params.some((p) => String(p.ds) === firstDs)) || {}).id : null);
    renderList();
    renderChart();
    if (want && state.sites.has(want)) {
      selectSite(want);
      const site = state.sites.get(want);
      const ds = (h.get("ds") || "").split(",").filter(Boolean);
      const param = h.get("param");
      const pick = ds.length ? ds : param ? site.params.filter((p) => p.name === param).map((p) => String(p.ds)) : [];
      for (const d of pick) if (site.params.some((p) => String(p.ds) === d)) await toggleSeries(d);
      map.setView([site.pt[1], site.pt[0]], 12);
    }
  }
  start();
})();

/* Conjunction Watch front-end */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? "—" : Number(v).toFixed(d));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const RE = 6378.137;

const state = {
  run: null, events: [], view: [], shown: 100, sort: { key: "miss_km", dir: 1 }, cat: "all", q: "",
  selected: null, catalog: null, satrecs: [], sim: Date.now(), speed: 60, live: true,
};

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 3500);
}
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

/* ---------------- globe ---------------- */
const G = {};
function eciToVec(p) { return new THREE.Vector3(p.x / RE, p.z / RE, -p.y / RE); }

function earthTexture() {
  const W = 2048, H = 1024, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = css("--ocean"); ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = css("--line"); ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) { const x = (lon + 180) / 360 * W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let lat = -60; lat <= 60; lat += 30) { const y = (90 - lat) / 180 * H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  if (G.land) {
    ctx.fillStyle = css("--land");
    const polys = G.land.features.flatMap((f) => (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates));
    for (const poly of polys) {
      for (const shift of [-360, 0, 360]) {
        ctx.beginPath();
        for (const ring of poly) {
          let prev = null, off = 0;
          ring.forEach(([lon, lat], i) => {
            if (prev !== null && Math.abs(lon - prev) > 180) off += lon < prev ? 360 : -360;
            prev = lon;
            const x = (lon + off + shift + 180) / 360 * W, y = (90 - lat) / 180 * H;
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          });
          ctx.closePath();
        }
        ctx.fill("evenodd");
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

async function initGlobe() {
  const el = $("#globe");
  G.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  G.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  el.appendChild(G.renderer.domElement);
  G.scene = new THREE.Scene();
  G.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  G.camera.position.set(2.2, 1.6, 3.2);
  G.controls = new THREE.OrbitControls(G.camera, G.renderer.domElement);
  G.controls.enableDamping = true; G.controls.minDistance = 1.15; G.controls.maxDistance = 12;
  G.controls.enablePan = false;
  try {
    const topo = await (await fetch("vendor/land-110m.json")).json();
    G.land = topojson.feature(topo, topo.objects.land);
  } catch { G.land = null; }
  G.earthMat = new THREE.MeshBasicMaterial({ map: earthTexture() });
  G.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), G.earthMat);
  G.scene.add(G.earth);
  G.selGroup = new THREE.Group(); G.scene.add(G.selGroup);
  const resize = () => {
    const w = el.clientWidth, h = el.clientHeight;
    G.renderer.setSize(w, h); G.camera.aspect = w / h; G.camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(el); resize();
  G.last = performance.now();
  requestAnimationFrame(frame);
}

function kindKey(o) { return o[3] === "STARLINK" ? "starlink" : o[2] === "debris" ? "debris" : o[2] === "rocket body" ? "rocket" : "payload"; }
const KIND_VAR = { payload: "--point", starlink: "--c1", debris: "--c2", rocket: "--c4" };

function buildPoints() {
  if (G.points) G.scene.remove(G.points);
  const n = state.catalog.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const c = new THREE.Color();
  state.catalog.forEach((o, i) => {
    c.set(css(KIND_VAR[kindKey(o)]));
    col.set([c.r, c.g, c.b], i * 3);
    pos.set([0, 0, 0], i * 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  G.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true }));
  G.scene.add(G.points);
  G.cursor = 0;
  updatePositions(n);  // first pass: everything
  const counts = {};
  state.catalog.forEach((o) => { const k = kindKey(o); counts[k] = (counts[k] || 0) + 1; });
  const label = { payload: "Payload", starlink: "Starlink", debris: "Debris", rocket: "Rocket body" };
  $("#legend").innerHTML = Object.keys(label).filter((k) => counts[k]).map((k) =>
    `<span><i style="background:${css(KIND_VAR[k])}"></i>${label[k]} ${counts[k].toLocaleString()}</span>`).join("");
}

function updatePositions(count) {
  if (!G.points) return;
  const arr = G.points.geometry.attributes.position.array, n = state.satrecs.length, d = new Date(state.sim);
  for (let k = 0; k < Math.min(count, n); k++) {
    const i = (G.cursor + k) % n, s = state.satrecs[i];
    let p = null;
    if (s) { try { p = satellite.propagate(s, d).position; } catch { p = null; } }
    if (p && isFinite(p.x)) { arr[i * 3] = p.x / RE; arr[i * 3 + 1] = p.z / RE; arr[i * 3 + 2] = -p.y / RE; }
    else { arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0; }
  }
  G.cursor = (G.cursor + count) % Math.max(n, 1);
  G.points.geometry.attributes.position.needsUpdate = true;
}

function frame(now) {
  const dt = (now - G.last) / 1000; G.last = now;
  if (state.live) state.sim = Date.now(); else state.sim += dt * 1000 * state.speed;
  const d = new Date(state.sim);
  G.earth.rotation.y = satellite.gstime(d);
  // Fast-forward needs more updates per frame to keep points moving smoothly
  updatePositions(state.speed >= 600 ? 4000 : 1500);
  updateSelection(d);
  $("#simClock").textContent = d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
  G.controls.update();
  G.renderer.render(G.scene, G.camera);
  requestAnimationFrame(frame);
}

/* ---------------- selection on globe ---------------- */
function satrecFor(id) {
  const i = state.catalogIndex?.get(id);
  return i === undefined ? null : state.satrecs[i];
}
function orbitLine(s, center, color) {
  const pts = [], T = (2 * Math.PI / s.no) * 60 * 1000; // ms
  for (let k = 0; k <= 180; k++) {
    const p = satellite.propagate(s, new Date(center - T / 2 + T * k / 180)).position;
    if (p) pts.push(eciToVec(p));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: .85 }));
}
function marker(color) {
  return new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color }));
}

function showOnGlobe(ev) {
  G.selGroup.clear();
  const sa = satrecFor(ev.a), sb = satrecFor(ev.b);
  if (!sa || !sb) { toast("Elements for this pair are not in the current catalogue"); return; }
  const tca = Date.parse(ev.tca), ca = css("--accent"), cb = css("--c1");
  G.sel = { sa, sb, ma: marker(ca), mb: marker(cb), link: null };
  G.selGroup.add(orbitLine(sa, tca, ca), orbitLine(sb, tca, cb), G.sel.ma, G.sel.mb);
  const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  G.sel.link = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: css("--fail") }));
  G.selGroup.add(G.sel.link);
  state.live = false; state.speed = 1; state.sim = tca - 90 * 1000;
  setSpeedTab("1");
  const p = satellite.propagate(sa, new Date(tca)).position;
  if (p) {
    const v = eciToVec(p).normalize().multiplyScalar(2.6);
    G.camera.position.copy(v);
  }
}
function updateSelection(d) {
  if (!G.sel) return;
  const pa = satellite.propagate(G.sel.sa, d).position, pb = satellite.propagate(G.sel.sb, d).position;
  if (!pa || !pb) return;
  const va = eciToVec(pa), vb = eciToVec(pb);
  G.sel.ma.position.copy(va); G.sel.mb.position.copy(vb);
  G.sel.link.geometry.setFromPoints([va, vb]);
  const km = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
  $("#simNote").textContent = `separation ${km < 100 ? km.toFixed(2) : km.toFixed(0)} km`;
}

function setSpeedTab(s) {
  document.querySelectorAll("#speedTabs .tab").forEach((t) => t.classList.toggle("on", t.dataset.s === s));
}
$("#speedTabs").onclick = (e) => {
  const s = e.target.dataset.s; if (!s) return;
  setSpeedTab(s);
  if (s === "now") { state.live = true; state.speed = 1; G.selGroup.clear(); G.sel = null; $("#simNote").textContent = ""; }
  else { state.live = false; state.speed = +s; }
};

/* ---------------- data loading ---------------- */
async function loadCatalog() {
  const cat = await api("/api/catalog");
  state.catalog = cat.objects;
  state.catalogIndex = new Map(cat.objects.map((o, i) => [o[0], i]));
  state.satrecs = cat.objects.map((o) => { try { return satellite.twoline2satrec(o[4], o[5]); } catch { return null; } });
  $("#elemPill").textContent = `Elements: ${cat.elements_time.slice(0, 16).replace("T", " ")} UTC · ${cat.objects.length.toLocaleString()} objects`;
  buildPoints();
  if (state.pendingSelect) { select(state.pendingSelect); state.pendingSelect = null; }
}

async function loadRuns(selectFile) {
  const runs = await api("/api/runs");
  $("#runSelect").innerHTML = runs.length ? runs.map((r) =>
    `<option value="${esc(r.file)}">${esc(r.start.slice(0, 16).replace("T", " "))} · ${r.hours} h · ${r.total.toLocaleString()}</option>`).join("")
    : `<option value="">No runs yet</option>`;
  const f = selectFile || runs[0]?.file;
  if (f) { $("#runSelect").value = f; await openRun(f); }
}
$("#runSelect").onchange = (e) => e.target.value && openRun(e.target.value);

async function openRun(file) {
  const r = await api(`/api/runs/${encodeURIComponent(file)}`);
  state.run = r; state.events = r.events; state.shown = 100; state.selected = null;
  const s = r.summary, start = new Date(r.start);
  $("#runInfo").textContent = `Last run: ${r.objects.toLocaleString()} objects, ${r.hours} h from ${start.toISOString().slice(0, 16).replace("T", " ")} UTC, `
    + `${r.pair_checks.toLocaleString()} pair checks in ${r.runtime_s} s.`;
  const top = r.events[0];
  $("#metrics").innerHTML = [
    metric("Objects screened", r.objects.toLocaleString(), Object.entries(r.kinds).map(([k, v]) => `${v.toLocaleString()} ${k}`).join(" · ")),
    metric(`Conjunctions < ${r.threshold_km} km`, s.total.toLocaleString(), `next ${r.hours} h`),
    metric("Under 1 km", s.under_1km.toLocaleString(), `${s.under_200m.toLocaleString()} under 200 m`),
    metric("Involving debris", s.by_category.debris.toLocaleString(), "debris or rocket body"),
    metric("Starlink–Starlink", s.by_category.starlink.toLocaleString(), "operator manoeuvres autonomously"),
    metric("Closest approach", top ? `${fmt(top.miss_km * 1000, 0)} m` : "—", top ? `${esc(name(top.a))} / ${esc(name(top.b))}` : ""),
  ].join("");
  renderHists(); applyFilter();
  if (state.view.length) {
    if (state.catalog) select(state.view[0]); else state.pendingSelect = state.view[0];
  }
}
const metric = (k, v, e) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div><div class="e">${e}</div></div>`;
const obj = (id) => state.run.objects_involved[id] || { name: `#${id}`, kind: "payload", family: "" };
const name = (id) => obj(id).name;

/* ---------------- table ---------------- */
function applyFilter() {
  const q = state.q.toLowerCase();
  state.view = state.events.filter((e) => {
    if (state.cat === "nostarlink" && e.category === "starlink") return false;
    if (state.cat === "debris" && e.category !== "debris") return false;
    if (state.cat === "starlink" && e.category !== "starlink") return false;
    if (q && !(`${name(e.a)} ${name(e.b)} ${e.a} ${e.b}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const { key, dir } = state.sort;
  state.view.sort((x, y) => (x[key] < y[key] ? -dir : x[key] > y[key] ? dir : 0));
  renderTable();
}
function kindTag(o) {
  const k = o.family === "STARLINK" ? "starlink" : o.kind === "debris" ? "debris" : o.kind === "rocket body" ? "rocket" : "payload";
  return `<span class="tag k-${k}">${k === "rocket" ? "R/B" : k}</span>`;
}
function rel(t) {
  const h = (Date.parse(t) - Date.now()) / 3600000;
  return h < 0 ? `${fmt(-h, 1)} h ago` : `in ${fmt(h, 1)} h`;
}
function pcClass(pc) { return pc >= 1e-4 ? "pc-hi" : pc >= 1e-5 ? "pc-mid" : ""; }
function renderTable() {
  const cols = [["tca", "TCA (UTC)"], ["a", "Object A"], ["b", "Object B"], ["miss_km", "Miss", 1], ["rel_speed_kms", "Rel. speed", 1],
                ["alt_km", "Altitude", 1], ["pc", "Pc (est.)", 1]];
  const arrow = (k) => (state.sort.key === k ? (state.sort.dir > 0 ? " ↑" : " ↓") : "");
  const rows = state.view.slice(0, state.shown).map((e, i) => `
    <tr data-i="${i}" class="${state.selected === e ? "sel" : ""}">
      <td class="mono">${e.tca.slice(5, 19).replace("T", " ")} <span class="muted">${rel(e.tca)}</span></td>
      <td>${esc(name(e.a))} ${kindTag(obj(e.a))}</td>
      <td>${esc(name(e.b))} ${kindTag(obj(e.b))}</td>
      <td class="num">${e.miss_km < 1 ? fmt(e.miss_km * 1000, 0) + " m" : fmt(e.miss_km, 2) + " km"}</td>
      <td class="num">${fmt(e.rel_speed_kms, 2)} km/s</td>
      <td class="num">${fmt(e.alt_km, 0)} km</td>
      <td class="num ${pcClass(e.pc)}">${e.pc > 0 ? e.pc.toExponential(1) : "&lt;1e-12"}</td>
    </tr>`).join("");
  $("#table").innerHTML = `<thead><tr>${cols.map(([k, l, n]) => `<th class="sort ${n ? "num" : ""}" data-k="${k}">${l}${arrow(k)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody>`;
  $("#tableCount").textContent = `${Math.min(state.shown, state.view.length).toLocaleString()} of ${state.view.length.toLocaleString()} shown`
    + (state.run.summary.total > state.events.length ? ` (closest ${state.events.length.toLocaleString()} of ${state.run.summary.total.toLocaleString()} kept)` : "");
  $("#moreBtn").classList.toggle("hidden", state.shown >= state.view.length);
}
$("#table").onclick = (e) => {
  const th = e.target.closest("th");
  if (th) { const k = th.dataset.k; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; applyFilter(); return; }
  const tr = e.target.closest("tr[data-i]");
  if (tr) select(state.view[+tr.dataset.i]);
};
$("#moreBtn").onclick = () => { state.shown += 200; renderTable(); };
$("#catTabs").onclick = (e) => {
  const c = e.target.dataset.c; if (!c) return;
  state.cat = c; document.querySelectorAll("#catTabs .tab").forEach((t) => t.classList.toggle("on", t.dataset.c === c));
  state.shown = 100; applyFilter();
};
$("#search").oninput = (e) => { state.q = e.target.value; state.shown = 100; applyFilter(); };

/* ---------------- detail ---------------- */
function select(ev) {
  state.selected = ev; renderTable();
  const A = obj(ev.a), B = obj(ev.b);
  const objCard = (o, id, color) => `<div class="obj" style="--oc:${color}"><div class="n">${esc(o.name)} ${kindTag(o)}</div>
    <div class="s">NORAD ${id} · ${esc(o.id || "")} · i ${fmt(o.inclination, 1)}° · P ${fmt(o.period_min, 1)} min · elements ${fmt(o.age_days, 1)} d old</div></div>`;
  $("#detail").innerHTML = `
    <h2>Selected conjunction</h2>
    <div class="pair">${objCard(A, ev.a, css("--accent"))}${objCard(B, ev.b, css("--c1"))}</div>
    <div class="big-miss">${ev.miss_km < 1 ? fmt(ev.miss_km * 1000, 0) + " m" : fmt(ev.miss_km, 3) + " km"} <small>at ${ev.tca.slice(0, 19).replace("T", " ")} UTC</small></div>
    <table class="kv" style="margin-top:8px">
      <tr><td>Relative speed</td><td>${fmt(ev.rel_speed_kms, 2)} km/s</td></tr>
      <tr><td>Radial / in-track / cross-track</td><td>${fmt(ev.radial_km, 3)} / ${fmt(ev.intrack_km, 3)} / ${fmt(ev.crosstrack_km, 3)} km</td></tr>
      <tr><td>Altitude, location</td><td>${fmt(ev.alt_km, 0)} km · ${fmt(ev.lat, 1)}°, ${fmt(ev.lon, 1)}°</td></tr>
      <tr><td>Assumed position σ</td><td>${fmt(ev.sigma_km, 2)} km</td></tr>
      <tr><td>Collision probability (est.)</td><td class="${pcClass(ev.pc)}">${ev.pc > 0 ? ev.pc.toExponential(2) : "&lt;1e-12"}</td></tr>
    </table>
    <div id="distPlot"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn small" target="_blank" rel="noopener" href="https://celestrak.org/satcat/table-satcat.php?CATNR=${ev.a}">${esc(A.name)} SATCAT ↗</a>
      <a class="btn small" target="_blank" rel="noopener" href="https://celestrak.org/satcat/table-satcat.php?CATNR=${ev.b}">${esc(B.name)} SATCAT ↗</a>
    </div>`;
  showOnGlobe(ev);
  distancePlot(ev);
}

function distancePlot(ev) {
  const sa = satrecFor(ev.a), sb = satrecFor(ev.b); if (!sa || !sb) return;
  const tca = Date.parse(ev.tca), xs = [], ys = [];
  for (let s = -600; s <= 600; s += 2) {
    const d = new Date(tca + s * 1000), pa = satellite.propagate(sa, d).position, pb = satellite.propagate(sb, d).position;
    if (!pa || !pb) continue;
    xs.push(s); ys.push(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z));
  }
  Plotly.react("distPlot", [{ x: xs, y: ys, mode: "lines", line: { color: css("--text"), width: 1.4 }, hovertemplate: "%{x} s<br>%{y:.2f} km<extra></extra>" }],
    plotLayout({ margin: { l: 46, r: 8, t: 8, b: 32 }, xaxis: { title: "Seconds from TCA" }, yaxis: { title: "km", type: "log" } }), plotCfg);
}

/* ---------------- charts ---------------- */
const plotCfg = { displaylogo: false, responsive: true, displayModeBar: false };
function plotLayout(extra = {}) {
  return {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", showlegend: false,
    font: { color: css("--muted"), family: "IBM Plex Mono", size: 11 }, margin: { l: 50, r: 10, t: 8, b: 38 },
    ...extra,
    xaxis: { gridcolor: css("--grid"), zerolinecolor: css("--zero"), linecolor: css("--line-2"), ...(extra.xaxis || {}) },
    yaxis: { gridcolor: css("--grid"), zerolinecolor: css("--zero"), linecolor: css("--line-2"), ...(extra.yaxis || {}) },
  };
}
function renderHists() {
  const s = state.run.summary;
  const centers = (e) => e.slice(0, -1).map((v, i) => (v + e[i + 1]) / 2);
  Plotly.react("missHist", [{ type: "bar", x: centers(s.miss_hist.edges), y: s.miss_hist.counts, marker: { color: css("--c1") },
    hovertemplate: "%{x:.2f} km: %{y}<extra></extra>" }], plotLayout({ bargap: 0.08, xaxis: { title: "Miss distance (km)" }, yaxis: { title: "Conjunctions" } }), plotCfg);
  Plotly.react("altHist", [{ type: "bar", x: centers(s.alt_hist.edges), y: s.alt_hist.counts, marker: { color: css("--accent") },
    hovertemplate: "%{x:.0f} km: %{y}<extra></extra>" }], plotLayout({ bargap: 0.08, xaxis: { title: "Altitude (km)" }, yaxis: { title: "Conjunctions", type: "log" } }), plotCfg);
}

/* ---------------- jobs ---------------- */
async function watchJob(id) {
  $("#jobBox").classList.remove("hidden"); $("#runBtn").disabled = true;
  const j = await api(`/api/jobs/${id}`);
  $("#jobBar").style.width = j.pct + "%";
  const log = $("#jobLog"); log.textContent = j.log.slice(-60).join("\n"); log.scrollTop = log.scrollHeight;
  if (j.status === "done") { $("#runBtn").disabled = false; toast("Screening finished"); await loadRuns(j.file); return; }
  if (j.status === "error") { $("#runBtn").disabled = false; toast(j.error); return; }
  setTimeout(() => watchJob(id), 1500);
}
$("#runBtn").onclick = async () => {
  const j = await api("/api/screen", { method: "POST", body: JSON.stringify({ hours: +$("#optHours").value, threshold_km: +$("#optThr").value }) });
  watchJob(j.id);
};

/* ---------------- theme ---------------- */
function initTheme() {
  try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
  $("#themeBtn").onclick = () => {
    const dark = css("--bg") === "#111214";
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", document.documentElement.dataset.theme); } catch {}
    G.earthMat.map = earthTexture(); G.earthMat.needsUpdate = true;
    if (state.catalog) buildPoints();
    if (state.run) { renderHists(); if (state.selected) select(state.selected); }
  };
}

(async function main() {
  initTheme();
  await initGlobe();
  loadCatalog().catch((e) => toast("Catalogue: " + e.message));
  const jobs = await api("/api/jobs").catch(() => []);
  const active = jobs.find((j) => ["queued", "running"].includes(j.status));
  await loadRuns().catch(() => {});
  if (active) watchJob(active.id);
  else if (!state.run) toast("No screening runs yet; press Run");
})();

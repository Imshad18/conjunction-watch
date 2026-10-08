/* Conjunction Watch front-end */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? "—" : Number(v).toFixed(d));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const RE = 6378.137, MU = 398600.4418;
const TRACK_COLORS = ["--accent", "--c3", "--c5", "--c6", "--c4"];
// Common names people type, mapped to catalogue names
const ALIASES = { iss: "ISS (ZARYA)", "space station": "ISS (ZARYA)", "international space station": "ISS (ZARYA)",
  tiangong: "CSS (TIANHE)", css: "CSS (TIANHE)", "chinese space station": "CSS (TIANHE)", hubble: "HST", hst: "HST",
  "hubble space telescope": "HST" };

const state = {
  run: null, events: [], view: [], shown: 100, sort: { key: "miss_km", dir: 1 }, cat: "all", q: "",
  selected: null, catalog: null, satrecs: [], sim: Date.now(), speed: 60, playing: true,
  tracked: [], focus: null, follow: false,
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
  G.trackGroup = new THREE.Group(); G.scene.add(G.trackGroup);
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
  state.catalog.forEach((o, i) => { c.set(css(KIND_VAR[kindKey(o)])); col.set([c.r, c.g, c.b], i * 3); });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  G.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true }));
  G.scene.add(G.points);
  G.cursor = 0;
  updatePositions(n);
  const counts = {};
  state.catalog.forEach((o) => { const k = kindKey(o); counts[k] = (counts[k] || 0) + 1; });
  const label = { payload: "Payload", starlink: "Starlink", debris: "Debris", rocket: "Rocket body" };
  $("#legend").innerHTML = Object.keys(label).filter((k) => counts[k]).map((k) =>
    `<span><i style="background:${css(KIND_VAR[k])}"></i>${label[k]} ${counts[k].toLocaleString()}</span>`).join("");
}

function propagate(s, d) {
  try { const r = satellite.propagate(s, d); return r.position && isFinite(r.position.x) ? r : null; } catch { return null; }
}

function updatePositions(count) {
  if (!G.points) return;
  const arr = G.points.geometry.attributes.position.array, n = state.satrecs.length, d = new Date(state.sim);
  for (let k = 0; k < Math.min(count, n); k++) {
    const i = (G.cursor + k) % n, s = state.satrecs[i];
    const r = s ? propagate(s, d) : null;
    if (r) { const p = r.position; arr[i * 3] = p.x / RE; arr[i * 3 + 1] = p.z / RE; arr[i * 3 + 2] = -p.y / RE; }
    else { arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0; }
  }
  G.cursor = (G.cursor + count) % Math.max(n, 1);
  G.points.geometry.attributes.position.needsUpdate = true;
}

function frame(now) {
  const dt = Math.min((now - G.last) / 1000, 0.1); G.last = now;
  if (state.playing) state.sim += dt * 1000 * state.speed;
  const d = new Date(state.sim);
  G.earth.rotation.y = satellite.gstime(d);
  // the whole cloud is refreshed in a few frames; faster warp needs more per frame
  updatePositions(Math.abs(state.speed) >= 600 ? 5000 : Math.abs(state.speed) >= 60 ? 2500 : 1200);
  updateSelection(d);
  updateTracked(d);
  updateClock(d);
  G.controls.update();
  G.renderer.render(G.scene, G.camera);
  updateLabels();
  requestAnimationFrame(frame);
}

/* ---------------- time controls ---------------- */
function runWindow() {
  if (!state.run) return [Date.now() - 3600e3, Date.now() + 24 * 3600e3];
  const s = Date.parse(state.run.start);
  return [s, s + state.run.hours * 3600e3];
}
function updateClock(d) {
  $("#simClock").textContent = d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
  const [a, b] = runWindow();
  if (!G.dragging) $("#tbRange").value = Math.round(1000 * Math.min(1, Math.max(0, (state.sim - a) / (b - a))));
  const m = (state.sim - Date.now()) / 60000;
  $("#tbRel").textContent = Math.abs(m) < 1 ? "now" : Math.abs(m) < 120 ? `${m > 0 ? "+" : "−"}${fmt(Math.abs(m), 0)} min` : `${m > 0 ? "+" : "−"}${fmt(Math.abs(m) / 60, 1)} h`;
}
function setPlaying(p) { state.playing = p; $("#tbPlay").classList.toggle("paused", !p); }
function setSpeed(s) { state.speed = s; $("#tbSpeed").value = String(s); }
$("#tbPlay").onclick = () => setPlaying(!state.playing);
$("#tbBack").onclick = () => { state.sim -= 600e3; };
$("#tbFwd").onclick = () => { state.sim += 600e3; };
$("#tbSpeed").onchange = (e) => { state.speed = +e.target.value; setPlaying(true); };
$("#tbNow").onclick = () => { state.sim = Date.now(); setSpeed(1); setPlaying(true); clearSelection(); };
$("#tbRange").addEventListener("input", (e) => {
  G.dragging = true;
  const [a, b] = runWindow();
  state.sim = a + (b - a) * (+e.target.value / 1000);
});
$("#tbRange").addEventListener("change", () => { G.dragging = false; });

/* ---------------- labels ---------------- */
function updateLabels() {
  const box = $("#labels"), w = box.clientWidth, h = box.clientHeight, cam = G.camera.position;
  const items = [];
  for (const t of state.tracked) if (t.vec) items.push({ v: t.vec, text: t.name, color: t.color });
  if (G.sel?.va) { items.push({ v: G.sel.va, text: G.sel.na, color: css("--accent") }, { v: G.sel.vb, text: G.sel.nb, color: css("--c1") }); }
  const html = [];
  for (const it of items) {
    if (occluded(cam, it.v)) continue;
    const p = it.v.clone().project(G.camera);
    if (p.z > 1) continue;
    const x = (p.x + 1) / 2 * w, y = (1 - p.y) / 2 * h;
    html.push(`<div class="sat-label" style="left:${x}px;top:${y}px;--lc:${it.color}">${esc(it.text)}</div>`);
  }
  box.innerHTML = html.join("");
}
function occluded(cam, p) {
  // does the line from the camera to p pass through the Earth?
  const d = p.clone().sub(cam), a = d.dot(d), b = 2 * cam.dot(d), c = cam.dot(cam) - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 && t < 0.999;
}

/* ---------------- conjunction selection ---------------- */
function satrecFor(id) {
  const i = state.catalogIndex?.get(id);
  return i === undefined ? null : state.satrecs[i];
}
function orbitPoints(s, center) {
  const pts = [], T = (2 * Math.PI / s.no) * 60 * 1000;
  for (let k = 0; k <= 180; k++) {
    const r = propagate(s, new Date(center - T / 2 + T * k / 180));
    if (r) pts.push(eciToVec(r.position));
  }
  return pts;
}
function orbitLine(s, center, color) {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(orbitPoints(s, center)),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: .85 }));
}
function marker(color, r = 0.012) {
  return new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color }));
}
function lookAt(vec, dist = 2.6) {
  G.camera.position.copy(vec.clone().normalize().multiplyScalar(Math.max(dist, G.controls.minDistance + 0.2)));
}

function clearSelection() {
  G.selGroup.clear(); G.sel = null; $("#simNote").textContent = "";
}
function showOnGlobe(ev) {
  G.selGroup.clear();
  const sa = satrecFor(ev.a), sb = satrecFor(ev.b);
  if (!sa || !sb) { toast("Elements for this pair are not in the current catalogue"); return; }
  const tca = Date.parse(ev.tca), ca = css("--accent"), cb = css("--c1");
  G.sel = { sa, sb, ma: marker(ca), mb: marker(cb), na: name(ev.a), nb: name(ev.b) };
  G.selGroup.add(orbitLine(sa, tca, ca), orbitLine(sb, tca, cb), G.sel.ma, G.sel.mb);
  G.sel.link = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: css("--fail") }));
  G.selGroup.add(G.sel.link);
  // replay the approach: start 3 minutes before closest approach at 10x
  state.sim = tca - 180e3; setSpeed(10); setPlaying(true); state.follow = false;
  const r = propagate(sa, new Date(tca));
  if (r) lookAt(eciToVec(r.position), 2.4);
}
function updateSelection(d) {
  if (!G.sel) return;
  const ra = propagate(G.sel.sa, d), rb = propagate(G.sel.sb, d);
  if (!ra || !rb) return;
  G.sel.va = eciToVec(ra.position); G.sel.vb = eciToVec(rb.position);
  G.sel.ma.position.copy(G.sel.va); G.sel.mb.position.copy(G.sel.vb);
  G.sel.link.geometry.setFromPoints([G.sel.va, G.sel.vb]);
  const pa = ra.position, pb = rb.position, km = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
  $("#simNote").textContent = `separation ${km < 1 ? fmt(km * 1000, 0) + " m" : km < 100 ? fmt(km, 2) + " km" : fmt(km, 0) + " km"}`;
}

/* ---------------- search & track ---------------- */
function findMatches(q) {
  q = q.trim().toLowerCase();
  if (!q || !state.catalog) return [];
  const alias = ALIASES[q];
  const out = [];
  if (/^\d+$/.test(q)) {
    const i = state.catalogIndex.get(+q);
    if (i !== undefined) out.push(i);
  }
  state.catalog.forEach((o, i) => {
    const n = o[1].toLowerCase();
    if ((alias && o[1] === alias) || n === q) out.unshift(i);
    else if (n.startsWith(q) || n.includes(q)) out.push(i);
  });
  // stations and named objects first, Starlink last, then by name length
  const rank = (i) => (state.catalog[i][1] === alias ? -1 : state.catalog[i][3] === "STARLINK" ? 2 : state.catalog[i][2] === "debris" ? 1 : 0);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b) || state.catalog[a][1].length - state.catalog[b][1].length).slice(0, 12);
}
let findSel = 0;
function renderFind() {
  const q = $("#findInput").value, list = $("#findList");
  const m = findMatches(q);
  G.findResults = m;
  if (!q.trim()) { list.classList.add("hidden"); return; }
  list.innerHTML = m.length ? m.map((i, k) => {
    const o = state.catalog[i];
    return `<div class="find-item ${k === findSel ? "on" : ""}" data-i="${i}">${esc(o[1])}<span>${o[0]} · ${kindKey(o)}</span></div>`;
  }).join("") : `<div class="find-item">No match<span></span></div>`;
  list.classList.remove("hidden");
}
$("#findInput").addEventListener("input", () => { findSel = 0; renderFind(); });
$("#findInput").addEventListener("keydown", (e) => {
  const m = G.findResults || [];
  if (e.key === "ArrowDown") { findSel = Math.min(findSel + 1, m.length - 1); renderFind(); e.preventDefault(); }
  if (e.key === "ArrowUp") { findSel = Math.max(findSel - 1, 0); renderFind(); e.preventDefault(); }
  if (e.key === "Enter" && m.length) { track(m[findSel]); }
  if (e.key === "Escape") $("#findList").classList.add("hidden");
});
$("#findList").onclick = (e) => { const it = e.target.closest("[data-i]"); if (it) track(+it.dataset.i); };
document.addEventListener("click", (e) => { if (!e.target.closest(".finder")) $("#findList").classList.add("hidden"); });

function track(i) {
  $("#findList").classList.add("hidden");
  $("#findInput").value = "";
  const o = state.catalog[i], s = state.satrecs[i];
  if (!s) { toast("No usable elements for this object"); return; }
  let t = state.tracked.find((x) => x.i === i);
  if (!t) {
    const color = css(TRACK_COLORS[state.tracked.length % TRACK_COLORS.length]);
    t = { i, id: o[0], name: o[1], kind: kindKey(o), s, color, mesh: marker(color, 0.016), line: null, lineAt: 0 };
    G.trackGroup.add(t.mesh);
    state.tracked.push(t);
  }
  state.focus = t; state.follow = true;
  if (G.sel) clearSelection();
  if (Math.abs(state.speed) > 60) setSpeed(1);
  setPlaying(true);
  const r = propagate(s, new Date(state.sim));
  if (r) lookAt(eciToVec(r.position), 2.2);
  renderTracked();
}
function untrack(t) {
  G.trackGroup.remove(t.mesh); if (t.line) G.trackGroup.remove(t.line);
  state.tracked = state.tracked.filter((x) => x !== t);
  if (state.focus === t) state.focus = state.tracked[0] || null;
  renderTracked();
}
function updateTracked(d) {
  for (const t of state.tracked) {
    const r = propagate(t.s, d);
    if (!r) { t.vec = null; continue; }
    t.vec = eciToVec(r.position); t.mesh.position.copy(t.vec); t.r = r;
    // redraw the orbit every quarter period of simulated time
    const T = (2 * Math.PI / t.s.no) * 60e3;
    if (!t.line || Math.abs(state.sim - t.lineAt) > T / 4) {
      if (t.line) G.trackGroup.remove(t.line);
      t.line = orbitLine(t.s, state.sim, t.color); t.lineAt = state.sim;
      G.trackGroup.add(t.line);
    }
  }
  if (state.follow && state.focus?.vec) {
    const dist = G.camera.position.length();
    G.camera.position.copy(state.focus.vec.clone().normalize().multiplyScalar(dist));
  }
  if (state.focus && (!G.trackTick || performance.now() - G.trackTick > 250)) { G.trackTick = performance.now(); renderTrackStats(d); }
}

function renderTracked() {
  const box = $("#tracked");
  if (!state.tracked.length) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const t = state.focus;
  const conj = state.run ? state.run.events.filter((e) => e.a === t.id || e.b === t.id).sort((a, b) => a.tca.localeCompare(b.tca)) : [];
  box.innerHTML = `
    <h2>Tracking</h2>
    <div class="track-chips">${state.tracked.map((x, k) => `<span class="chip-t ${x === t ? "on" : ""}" data-k="${k}" style="--tc:${x.color}">${esc(x.name)}</span>`).join("")}</div>
    <div class="track-head"><div><div class="n">${esc(t.name)}</div><div class="muted mono" style="font-size:12px">NORAD ${t.id} · ${t.kind} · i ${fmt(t.s.inclo * 180 / Math.PI, 1)}° · P ${fmt(2 * Math.PI / t.s.no, 1)} min</div></div>
      <div style="display:flex;gap:6px"><button class="btn small" id="followBtn">${state.follow ? "Unfollow" : "Follow"}</button><button class="btn small" id="untrackBtn">Remove</button></div></div>
    <table class="kv" id="trackStats"></table>
    <div class="conj-mini">${conj.length ? `<div style="cursor:default;color:var(--muted)"><span>Close approaches in this run</span><span>${conj.length}</span></div>`
      + conj.slice(0, 8).map((e) => `<div data-tca="${esc(e.tca)}" data-a="${e.a}" data-b="${e.b}"><span>${esc(name(e.a === t.id ? e.b : e.a))}</span><span class="mono">${e.miss_km < 1 ? fmt(e.miss_km * 1000, 0) + " m" : fmt(e.miss_km, 2) + " km"} · ${e.tca.slice(5, 16).replace("T", " ")}</span></div>`).join("")
      : `<div style="cursor:default;color:var(--muted)"><span>No close approaches under ${state.run ? state.run.threshold_km : "—"} km in this run</span><span></span></div>`}</div>`;
  box.querySelector(".track-chips").onclick = (e) => { const c = e.target.closest("[data-k]"); if (c) { state.focus = state.tracked[+c.dataset.k]; state.follow = true; renderTracked(); } };
  $("#followBtn").onclick = () => { state.follow = !state.follow; renderTracked(); };
  $("#untrackBtn").onclick = () => untrack(t);
  box.querySelector(".conj-mini").onclick = (e) => {
    const r = e.target.closest("[data-tca]"); if (!r) return;
    const ev = state.events.find((x) => x.tca === r.dataset.tca && x.a === +r.dataset.a && x.b === +r.dataset.b);
    if (ev) select(ev);
  };
  renderTrackStats(new Date(state.sim));
}
function renderTrackStats(d) {
  const t = state.focus, el = $("#trackStats");
  if (!t || !el || !t.r) return;
  const p = t.r.position, v = t.r.velocity;
  const gd = satellite.eciToGeodetic(p, satellite.gstime(d));
  const lat = satellite.degreesLat(gd.latitude), lon = satellite.degreesLong(gd.longitude);
  el.innerHTML = `
    <tr><td>Altitude</td><td>${fmt(gd.height, 1)} km</td></tr>
    <tr><td>Speed</td><td>${fmt(Math.hypot(v.x, v.y, v.z), 3)} km/s</td></tr>
    <tr><td>Position</td><td>${fmt(Math.abs(lat), 2)}° ${lat >= 0 ? "N" : "S"}, ${fmt(Math.abs(lon), 2)}° ${lon >= 0 ? "E" : "W"}</td></tr>
    <tr><td>Time</td><td>${d.toISOString().slice(0, 19).replace("T", " ")} UTC</td></tr>`;
}

/* ---------------- data loading ---------------- */
async function loadCatalog() {
  const cat = await api("/api/catalog");
  state.catalog = cat.objects;
  state.catalogIndex = new Map(cat.objects.map((o, i) => [o[0], i]));
  state.satrecs = cat.objects.map((o) => { try { return satellite.twoline2satrec(o[4], o[5]); } catch { return null; } });
  $("#elemPill").textContent = `Elements: ${cat.elements_time.slice(0, 16).replace("T", " ")} UTC · ${cat.objects.length.toLocaleString()} objects`;
  buildPoints();
  const m = location.hash.match(/track=([^&]+)/);
  if (m) {
    for (const q of decodeURIComponent(m[1]).split(",")) { const r = findMatches(q); if (r.length) track(r[0]); }
    state.pendingSelect = null;
  }
  if (state.pendingSelect) { select(state.pendingSelect); state.pendingSelect = null; }
}

async function loadRuns(selectFile, autoSelect = true) {
  const runs = await api("/api/runs");
  $("#runSelect").innerHTML = runs.length ? runs.map((r) =>
    `<option value="${esc(r.file)}">${esc(r.start.slice(0, 16).replace("T", " "))} · ${r.hours} h · ${r.total.toLocaleString()}</option>`).join("")
    : `<option value="">No runs yet</option>`;
  const f = selectFile || runs[0]?.file;
  if (f) { $("#runSelect").value = f; await openRun(f, autoSelect); }
}
$("#runSelect").onchange = (e) => e.target.value && openRun(e.target.value, false);

async function openRun(file, autoSelect) {
  const r = await api(`/api/runs/${encodeURIComponent(file)}`);
  state.run = r; state.events = r.events; state.shown = 100; state.selected = null;
  const s = r.summary, start = new Date(r.start);
  $("#runInfo").textContent = `Showing run from ${start.toISOString().slice(0, 16).replace("T", " ")} UTC: ${r.objects.toLocaleString()} objects over ${r.hours} h, `
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
  if (state.tracked.length) renderTracked();
  if (autoSelect && state.view.length && !location.hash.includes("track=")) {
    if (state.catalog) select(state.view[0]); else state.pendingSelect = state.view[0];
  }
}
const metric = (k, v, e) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div><div class="e">${e}</div></div>`;
const obj = (id) => state.run?.objects_involved[id] || { name: `#${id}`, kind: "payload", family: "" };
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
  if (tr) { select(state.view[+tr.dataset.i]); window.scrollTo({ top: 0, behavior: "smooth" }); }
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
      <button class="btn small" id="replayBtn">Replay approach</button>
      <a class="btn small" target="_blank" rel="noopener" href="https://celestrak.org/satcat/table-satcat.php?CATNR=${ev.a}">${esc(A.name)} ↗</a>
      <a class="btn small" target="_blank" rel="noopener" href="https://celestrak.org/satcat/table-satcat.php?CATNR=${ev.b}">${esc(B.name)} ↗</a>
    </div>`;
  $("#replayBtn").onclick = () => showOnGlobe(ev);
  showOnGlobe(ev);
  distancePlot(ev);
}

function distancePlot(ev) {
  const sa = satrecFor(ev.a), sb = satrecFor(ev.b); if (!sa || !sb) return;
  const tca = Date.parse(ev.tca), xs = [], ys = [];
  for (let s = -600; s <= 600; s += 2) {
    const d = new Date(tca + s * 1000), ra = propagate(sa, d), rb = propagate(sb, d);
    if (!ra || !rb) continue;
    const pa = ra.position, pb = rb.position;
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

/* ---------------- screening jobs ---------------- */
async function watchJob(id) {
  const btn = $("#runBtn");
  $("#jobBox").classList.remove("hidden"); btn.disabled = true;
  const j = await api(`/api/jobs/${id}`);
  const secs = Math.round(Date.now() / 1000 - j.created);
  btn.textContent = j.status === "queued" ? "Queued…" : `Running… ${Math.round(j.pct)}%`;
  $("#jobBar").style.width = j.pct + "%";
  const log = $("#jobLog");
  log.textContent = `Screening ${j.hours} h, miss distance < ${j.threshold_km} km · ${secs} s elapsed\n` + j.log.slice(-40).join("\n");
  log.scrollTop = log.scrollHeight;
  if (j.status === "done") {
    btn.disabled = false; btn.textContent = "Run";
    toast("Screening finished; showing the new results");
    await loadRuns(j.file, false);
    setTimeout(() => $("#jobBox").classList.add("hidden"), 4000);
    return;
  }
  if (j.status === "error") { btn.disabled = false; btn.textContent = "Run"; toast(j.error); return; }
  setTimeout(() => watchJob(id), 1000);
}
$("#runBtn").onclick = async () => {
  const j = await api("/api/screen", { method: "POST", body: JSON.stringify({ hours: +$("#optHours").value, threshold_km: +$("#optThr").value }) });
  toast("Screening started; this takes about a minute for 24 h");
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
  setPlaying(true); setSpeed(60);
  await initGlobe();
  loadCatalog().catch((e) => toast("Catalogue: " + e.message));
  const jobs = await api("/api/jobs").catch(() => []);
  const active = jobs.find((j) => ["queued", "running"].includes(j.status));
  await loadRuns(null, true).catch(() => {});
  if (active) watchJob(active.id);
  else if (!state.run) toast("No screening runs yet; press Run");
})();

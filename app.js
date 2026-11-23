"use strict";
/* Placement Area Tracker. Signs in to ArcGIS Online, reads placement areas from a
   hosted feature layer, and saves each entry to the layer and to a log table. */
const CFG = window.TRACKER_CONFIG;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = n => Math.round(n).toLocaleString("en-US");
const pctf = n => (n == null ? "not set" : n.toFixed(1) + "%");
const today = () => new Date().toISOString().slice(0, 10);
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, "");
const SKEY = "pat-session", VKEY = "pat-pkce";

let session = null;      // { token, username, expires }
let areas = [];          // rows from the layer
let log = [];            // rows from the log table
let oidField = "OBJECTID", logOid = "OBJECTID", hasLast = false;
const LAST = "LastEntry"; // date of the last material entry. Date_ holds the survey date.
let sel = null, type = "place", view = "table", busy = false, lastError = "";

/* ---------- the whole calculation ---------- */
function calc(total, used, active) {
  const avail = total - used;
  const pct = total > 0 ? (avail / total) * 100 : null;
  let sym = "";
  if (active === "Offline") sym = "O";
  else if (active === "Inactive") sym = "I";
  else if (pct != null) sym = pct >= CFG.greenAtOrAbove ? "G" : pct < CFG.redBelow ? "R" : "Y";
  return { total, used, avail, pct, sym };
}
function applyEntry(total, used, e) {
  if (e.type === "place") used += e.vol;
  else if (e.type === "remove") used -= e.vol;
  else if (e.type === "setused") used = e.vol;
  else if (e.type === "settotal") total = e.vol;
  return { total, used };
}
/* ------------------------------------------- */

const SYM = { G: "Plenty of room", Y: "Filling", R: "Nearly full", O: "Offline", I: "Inactive", "": "Capacity not set" };
const TYPES = { place: "Material placed", remove: "Material removed", setused: "Set used total", settotal: "Set total capacity" };

/* ---------- sign-in (OAuth 2.0 with PKCE, no secret) ---------- */
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function signIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem(VKEY, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({ client_id: CFG.clientId, response_type: "code", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state, expiration: "480" });
  location.assign(CFG.portal + "/sharing/rest/oauth2/authorize?" + q);
}
async function finishSignIn(code, state) {
  const saved = JSON.parse(sessionStorage.getItem(VKEY) || "null");
  sessionStorage.removeItem(VKEY);
  history.replaceState(null, "", REDIRECT);
  if (!saved || saved.state !== state) throw new Error("Sign-in could not be verified. Please try again.");
  const body = new URLSearchParams({ client_id: CFG.clientId, grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: saved.verifier, f: "json" });
  const r = await fetch(CFG.portal + "/sharing/rest/oauth2/token", { method: "POST", body });
  const j = await r.json();
  if (j.error) throw new Error("Sign-in failed: " + (j.error.message || j.error_description || JSON.stringify(j.error)));
  session = { token: j.access_token, username: j.username, expires: Date.now() + (j.expires_in || 1800) * 1000 };
  sessionStorage.setItem(SKEY, JSON.stringify(session));
}
function signOut() { sessionStorage.removeItem(SKEY); session = null; areas = []; log = []; render(); }

/* ---------- ArcGIS REST ---------- */
async function rest(url, params, post) {
  if (session && Date.now() > session.expires - 30000) { signOut(); throw new Error("Your sign-in expired. Please sign in again."); }
  const p = new URLSearchParams(Object.assign({ f: "json", token: session.token }, params));
  const r = post ? await fetch(url, { method: "POST", body: p }) : await fetch(url + "?" + p);
  const j = await r.json();
  if (j.error) {
    if (j.error.code === 498 || j.error.code === 499) signOut();
    throw new Error((j.error.message || "Request failed") + (j.error.details && j.error.details.length ? " (" + j.error.details.join("; ") + ")" : "") + " [" + url.split("/rest/services/").pop() + "]");
  }
  return j;
}
const BASE_FIELDS = ["NAME", "TotalCapac", "UsedCapac", "AvailCapac", "PercCapac", "Date_", "Active", "Status", "SymbolStat", "Acres"];
const areaFields = () => [oidField].concat(BASE_FIELDS, hasLast ? [LAST] : []).join(",");
const day = ms => (ms && ms > 631152000000 ? new Date(ms).toISOString().slice(0, 10) : "");
function toArea(f) {
  const a = f.attributes;
  return { oid: a[oidField], name: String(a.NAME), total: +a.TotalCapac || 0, used: +a.UsedCapac || 0, survey: day(a.Date_), last: day(a[LAST]), active: a.Active || "", status: a.Status || "", acres: +a.Acres || 0, rings: f.geometry ? f.geometry.rings : null };
}
const nameKey = n => { const m = /^(\d+)(.*)$/.exec(n) || [0, 1e9, n]; return [+m[1], m[2]]; };
async function loadAll() {
  const meta = await rest(CFG.areasUrl, {});
  oidField = meta.objectIdField || "OBJECTID";
  hasLast = (meta.fields || []).some(f => f.name === LAST);
  const q = await rest(CFG.areasUrl + "/query", { where: "1=1", outFields: areaFields(), returnGeometry: "true", outSR: "4326", geometryPrecision: "5" });
  areas = q.features.map(toArea).sort((x, y) => { const a = nameKey(x.name), b = nameKey(y.name); return a[0] - b[0] || String(a[1]).localeCompare(String(b[1])); });
  if (!sel || !areas.some(a => a.name === sel)) sel = areas.length ? areas[0].name : null;
  buildMap();
  await loadLog();
}
async function loadLog() {
  const meta = await rest(CFG.logUrl, {});
  logOid = meta.objectIdField || "OBJECTID";
  const q = await rest(CFG.logUrl + "/query", { where: "1=1", outFields: "*", orderByFields: logOid + " DESC", resultRecordCount: "500" });
  log = q.features.map(f => f.attributes);
}
async function saveEntry(e) {
  // Read the area again first, so two people saving at once cannot overwrite each other's totals.
  const cur = areas.find(a => a.name === e.area);
  const fresh = await rest(CFG.areasUrl + "/query", { where: oidField + "=" + cur.oid, outFields: areaFields(), returnGeometry: "false" });
  if (!fresh.features.length) throw new Error("PA " + e.area + " was not found in the layer.");
  const now = toArea(fresh.features[0]);
  if (now.active !== "Active" && e.type !== "settotal") throw new Error("PA " + e.area + " is marked " + (now.active || "not active") + ". Set it to Active on the map layer before recording material. Nothing was saved.");
  const next = applyEntry(now.total, now.used, e);
  const c = calc(next.total, next.used, now.active);
  const when = Date.parse(e.date + "T12:00:00Z");
  const over = c.total > 0 && c.used > c.total ? " OVER CAPACITY by " + fmt(c.used - c.total) + " " + CFG.units + "." : "";
  const row = { AreaName: e.area, EntryType: TYPES[e.type], CubicYards: e.vol, EntryDate: when, Job: e.job, EnteredBy: e.by, Note: (e.note ? e.note + " " : "") + (over ? over.trim() + " " : "") + "(used " + fmt(now.used) + " to " + fmt(c.used) + ", capacity " + fmt(now.total) + " to " + fmt(c.total) + ")" };
  const add = await rest(CFG.logUrl + "/applyEdits", { adds: JSON.stringify([{ attributes: row }]) }, true);
  const ar = add.addResults && add.addResults[0];
  if (!ar || !ar.success) throw new Error("The log row was not saved: " + JSON.stringify(ar && ar.error || add));
  const attrs = { TotalCapac: c.total, UsedCapac: c.used, AvailCapac: c.avail, PercCapac: c.pct == null ? 0 : +c.pct.toFixed(4), SymbolStat: c.sym };
  // A new total capacity comes from a new survey, so it moves the survey date. Every other entry moves the last entry date.
  if (e.type === "settotal") attrs.Date_ = when; else if (hasLast) attrs[LAST] = when;
  attrs[oidField] = cur.oid;
  let ok = false, why = "";
  try {
    const up = await rest(CFG.areasUrl + "/applyEdits", { updates: JSON.stringify([{ attributes: attrs }]) }, true);
    const ur = up.updateResults && up.updateResults[0];
    ok = !!(ur && ur.success); if (!ok) why = JSON.stringify(ur && ur.error || up);
  } catch (err) { why = err.message; }
  if (!ok) {
    // Take the log row back out so the log never claims something the layer did not get.
    try { await rest(CFG.logUrl + "/applyEdits", { deletes: String(ar.objectId) }, true); } catch (err) { why += " Also could not remove the log row " + ar.objectId + "."; }
    throw new Error("The placement area was not updated, so nothing was saved. " + why);
  }
  Object.assign(cur, { total: c.total, used: c.used }, e.type === "settotal" ? { survey: e.date } : { last: e.date });
  await loadLog();
}

/* ---------- map ---------- */
let MAP = { w: 1000, h: 600, paths: {} };
function buildMap() {
  const pts = []; areas.forEach(a => (a.rings || []).forEach(r => r.forEach(p => pts.push(p))));
  if (!pts.length) return;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const k = Math.cos(((miny + maxy) / 2) * Math.PI / 180), sc = 1000 / Math.max((maxx - minx) * k, 1e-9);
  MAP = { w: 1000, h: Math.max(200, Math.round((maxy - miny) * sc)), paths: {} };
  for (const a of areas) {
    if (!a.rings) continue;
    let d = "", sx = 0, sy = 0, n = 0;
    for (const r of a.rings) { d += "M" + r.map(p => { const x = (p[0] - minx) * k * sc, y = (maxy - p[1]) * sc; sx += x; sy += y; n++; return x.toFixed(1) + "," + y.toFixed(1); }).join(" ") + "Z"; }
    MAP.paths[a.name] = { d, lx: sx / n, ly: sy / n };
  }
}

/* ---------- screen ---------- */
function parseVol(t) { const v = parseFloat(String(t).replace(/[, ]/g, "")); return isFinite(v) ? v : NaN; }
const val = id => { const e = document.getElementById(id); return e ? e.value : ""; };
let form = { vol: "", date: today(), job: "", by: "", note: "" };
function draft() { const vol = parseVol(form.vol); if (isNaN(vol) || !sel) return null; return { area: sel, type, vol, date: form.date || today(), job: form.job.trim(), by: form.by.trim() || (session && session.username) || "", note: form.note.trim() }; }
function checks(e, a, before, after) {
  const out = []; if (!e) return out;
  if (e.vol < 0) out.push(["bad", 'Enter a positive number. Use "Material removed" to take volume out.']);
  if (e.vol === 0 && (type === "place" || type === "remove")) out.push(["bad", "Enter a volume greater than zero."]);
  if (after.total <= 0 && type !== "settotal") out.push(["warn", "PA " + sel + ' has no total capacity on record, so percent available cannot be worked out. Use "Set total capacity" first if you know it.']);
  if (after.total > 0 && after.used > after.total) out.push(["warn", "This puts PA " + sel + " over its recorded capacity by " + fmt(after.used - after.total) + " " + CFG.units + ". You can still save; the overage will be written into the log."]);
  if (after.used < 0) out.push(["bad", "Used volume would go below zero."]);
  if (a.active !== "Active" && type !== "settotal") out.push(["bad", "PA " + sel + " is marked " + (a.active || "not active") + ". Set it to Active on the map layer before recording material."]);
  if (before.sym !== after.sym && "GYR".includes(after.sym || "x") && "GYR".includes(before.sym || "x")) out.push(["ok", 'Status changes from "' + SYM[before.sym] + '" to "' + SYM[after.sym] + '".']);
  if (e.date > today()) out.push(["warn", "That date is in the future."]);
  return out;
}
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600); }
const banner = () => (CFG.testMode ? '<div class="banner">TEST MODE. This page reads and writes the test copy, not the live placement area layer.</div>' : "");

function renderSignedOut(msg) {
  $("#app").innerHTML = banner() + `<div class="center"><section class="pnl"><div class="in"><h1 style="font-size:20px;margin-bottom:10px">${esc(CFG.title)}</h1><p>Record material placed in each placement area. Used, available and percent available update on the map layer as soon as you save.</p><p class="muted small">Sign in with your ArcGIS Online account for this organization.</p>${msg ? `<div class="msg bad" style="margin-bottom:12px">${esc(msg)}</div>` : ""}<button class="btn pri" id="btnSignIn" style="padding:8px 18px">Sign in</button></div></section></div>`;
  $("#btnSignIn").onclick = signIn;
}
function render() {
  if (!session) return renderSignedOut(lastError);
  const rows = areas.map(a => Object.assign({ a }, calc(a.total, a.used, a.active)));
  const curA = areas.find(a => a.name === sel);
  if (!curA) { $("#app").innerHTML = banner() + `<div class="top"><h1>${esc(CFG.title)}</h1><span class="sp"></span><button class="btn" id="btnOut">Sign out</button></div>${lastError ? `<div class="err">${esc(lastError)}</div>` : '<p class="center muted">Loading placement areas…</p>'}`; $("#btnOut").onclick = signOut; return; }
  const cur = calc(curA.total, curA.used, curA.active);
  const d = draft();
  const nx = d ? applyEntry(curA.total, curA.used, d) : curA;
  const after = calc(nx.total, nx.used, curA.active);
  const act = rows.filter(r => r.total > 0), T = act.reduce((s, r) => s + r.total, 0), U = act.reduce((s, r) => s + r.used, 0);
  const cs = checks(d, curA, cur, after);
  const line = (k, b, a, p) => `<span class="k">${k}</span><span class="v">${p ? pctf(b) : fmt(b)}</span><span class="arrow">→</span><span class="v ${d && a !== b ? "new" : ""}">${p ? pctf(a) : fmt(a)}</span>`;
  const keep = document.activeElement && document.activeElement.id, ss = keep && document.activeElement.selectionStart;
  $("#app").innerHTML = banner() + `
<div class="top ${busy ? "busy" : ""}"><div><h1>${esc(CFG.title)}</h1><div class="sub">Material placed, capacity used and capacity remaining, by placement area. Volumes in ${esc(CFG.units)}.</div></div><span class="sp"></span><span class="sub">Signed in as ${esc(session.username)}</span><button class="btn" id="btnRefresh">Refresh</button><button class="btn" id="btnLogCsv">Export log (CSV)</button><button class="btn" id="btnOut">Sign out</button></div>
${lastError ? `<div class="err">${esc(lastError)}</div>` : ""}
<div class="tiles"><div class="tile"><span>Total capacity on record</span><b>${fmt(T)}</b></div><div class="tile"><span>Used</span><b>${fmt(U)}</b></div><div class="tile"><span>Available</span><b>${fmt(T - U)}</b> <small>${T ? ((T - U) / T * 100).toFixed(1) : "0"}%</small></div><div class="tile"><span>Areas nearly full</span><b>${rows.filter(r => r.sym === "R").length}</b> <small>of ${act.length} with capacity set</small></div><div class="tile"><span>Entries logged</span><b>${log.length}</b></div></div>
<div class="wrap ${busy ? "busy" : ""}">
 <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
  <section class="pnl"><header><h2>Placement areas</h2><span class="sp"></span><div class="tabs"><button id="tabTable" class="${view === "table" ? "on" : ""}">Table</button><button id="tabMap" class="${view === "map" ? "on" : ""}">Map</button></div></header>
  ${view === "table" ? `<div class="tw"><table><thead><tr><th>Area</th><th>Status</th><th class="num">Total</th><th class="num">Used</th><th class="num">Available</th><th class="num">% available</th><th></th><th>Survey date</th><th>Last entry</th><th class="num">Acres</th></tr></thead><tbody>${rows.map(r => `<tr class="row ${r.a.name === sel ? "sel" : ""}" data-a="${esc(r.a.name)}"><td><b>PA ${esc(r.a.name)}</b></td><td><span class="dot ${r.sym}"></span>${esc(r.sym === "O" || r.sym === "I" ? SYM[r.sym] : r.a.active)}${"GYR".includes(r.sym || "x") ? ' <span class="muted">· ' + SYM[r.sym] + "</span>" : ""}</td><td class="num">${r.total ? fmt(r.total) : '<span class="muted">not set</span>'}</td><td class="num">${fmt(r.used)}</td><td class="num">${r.total ? fmt(r.avail) : ""}</td><td class="num">${r.pct == null ? "" : r.pct.toFixed(1) + "%"}</td><td>${r.pct == null ? "" : `<span class="bar"><i class="${r.sym}" style="width:${Math.max(0, Math.min(100, 100 - r.pct))}%"></i></span>`}</td><td>${esc(r.a.survey)}</td><td>${esc(r.a.last)}</td><td class="num">${fmt(r.a.acres)}</td></tr>`).join("")}</tbody></table></div>`
   : `<div class="in" style="padding-bottom:8px"><div class="legend">${["G", "Y", "R", "O", "I", ""].map(k => `<span><span class="dot ${k}"></span>${SYM[k]}${k === "G" ? " (" + CFG.greenAtOrAbove + "% or more available)" : k === "R" ? " (under " + CFG.redBelow + "%)" : ""}</span>`).join("")}</div></div><svg class="map" viewBox="-20 -20 ${MAP.w + 40} ${MAP.h + 40}" preserveAspectRatio="xMidYMid meet">${rows.map(r => { const m = MAP.paths[r.a.name]; return m ? `<path d="${m.d}" data-a="${esc(r.a.name)}" class="${r.a.name === sel ? "sel" : ""}" fill="var(--${r.sym ? r.sym.toLowerCase() : "none"})"><title>PA ${esc(r.a.name)}</title></path>` : ""; }).join("")}${rows.map(r => { const m = MAP.paths[r.a.name]; return m ? `<text x="${m.lx.toFixed(1)}" y="${(m.ly + 7).toFixed(1)}">${esc(r.a.name)}</text>` : ""; }).join("")}</svg>`}
  </section>
  <section class="pnl"><header><h2>Entry log</h2><span class="sp"></span><span class="small muted">${log.length ? log.length + " entries, newest first" : ""}</span></header><div class="tw" style="max-height:320px">${log.length ? `<table><thead><tr><th>Date</th><th>Area</th><th>Entry</th><th class="num">Volume</th><th>Job</th><th>By</th><th>Note</th></tr></thead><tbody>${log.map(e => `<tr><td>${e.EntryDate ? new Date(e.EntryDate).toISOString().slice(0, 10) : ""}</td><td>PA ${esc(e.AreaName)}</td><td>${esc(e.EntryType)}</td><td class="num">${fmt(e.CubicYards || 0)}</td><td>${esc(e.Job)}</td><td>${esc(e.EnteredBy)}</td><td style="white-space:normal">${esc(e.Note)}</td></tr>`).join("")}</tbody></table>` : '<p class="in muted" style="margin:0">No entries yet.</p>'}</div></section>
 </div>
 <section class="pnl" style="position:sticky;top:14px"><header><h2>Record an entry for PA ${esc(sel)}</h2></header><div class="in">
  <div class="fg">
   <label class="f">Placement area<select id="fArea">${areas.map(a => `<option value="${esc(a.name)}" ${a.name === sel ? "selected" : ""}>PA ${esc(a.name)}${a.active && a.active !== "Active" ? " (" + esc(a.active) + ")" : ""}</option>`).join("")}</select></label>
   <label class="f">Date<input type="date" id="f-date" value="${esc(form.date)}"></label>
   <div class="full"><div class="seg">${Object.keys(TYPES).map(k => `<button data-t="${k}" class="${type === k ? "on" : ""}">${TYPES[k]}</button>`).join("")}</div></div>
   <label class="f full">${{ place: "Volume placed", remove: "Volume removed", setused: "Used volume is now", settotal: "Total capacity is now" }[type]} (${esc(CFG.units)})<input class="big" type="text" inputmode="decimal" id="f-vol" placeholder="0" autocomplete="off" value="${esc(form.vol)}"></label>
   <label class="f">Job, contract or dredge cycle<input type="text" id="f-job" autocomplete="off" value="${esc(form.job)}"></label>
   <label class="f">Entered by<input type="text" id="f-by" autocomplete="off" placeholder="${esc(session.username)}" value="${esc(form.by)}"></label>
   <label class="f full">Note<input type="text" id="f-note" autocomplete="off" value="${esc(form.note)}"></label>
  </div>
  <div class="ba"><span class="h">PA ${esc(sel)}: now → after this entry</span>${line("Total capacity", cur.total, after.total)}${line("Used", cur.used, after.used)}${line("Available", cur.avail, after.avail)}${line("% available", cur.pct, after.pct, true)}<span class="k">Status</span><span class="v"><span class="dot ${cur.sym}"></span>${SYM[cur.sym]}</span><span class="arrow">→</span><span class="v ${cur.sym !== after.sym ? "new" : ""}"><span class="dot ${after.sym}"></span>${SYM[after.sym]}</span></div>
  ${cs.map(([t, m]) => `<div class="msg ${t}">${esc(m)}</div>`).join("")}
  <div style="display:flex;gap:8px;margin-top:12px"><button class="btn pri" id="btnSave" style="flex:1" ${!d || busy || cs.some(c => c[0] === "bad") ? "disabled" : ""}>${busy ? "Saving…" : "Save entry"}</button><button class="btn" id="btnClear">Clear</button></div>
  <p class="small muted" style="margin:12px 0 0">Figures recalculate as you type. Saving updates the map layer and adds a row to the log. To correct a mistake, save a new entry that reverses it.</p>
 </div></section>
</div>`;
  if (keep) { const el = document.getElementById(keep); if (el) { el.focus(); try { el.setSelectionRange(ss, ss); } catch (e) { } } }
}

document.addEventListener("input", e => { const id = e.target.id || ""; if (id.startsWith("f-")) { form[id.slice(2)] = e.target.value; render(); } });
document.addEventListener("change", e => { if (e.target.id === "fArea") { sel = e.target.value; render(); } });
document.addEventListener("keydown", e => { if (e.target.id === "f-vol" && e.key === "Enter") { const b = $("#btnSave"); if (b && !b.disabled) b.click(); } });
document.addEventListener("click", async e => {
  const t = e.target;
  const row = t.closest("[data-a]"); if (row) { sel = row.dataset.a; render(); return; }
  const seg = t.closest("[data-t]"); if (seg) { type = seg.dataset.t; render(); const v = $("#f-vol"); if (v) v.focus(); return; }
  if (t.id === "tabTable") { view = "table"; render(); }
  else if (t.id === "tabMap") { view = "map"; render(); }
  else if (t.id === "btnOut") signOut();
  else if (t.id === "btnClear") { form.vol = ""; form.note = ""; form.job = ""; render(); }
  else if (t.id === "btnRefresh") await run(loadAll, "Refreshed");
  else if (t.id === "btnLogCsv") {
    const q = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const text = [["Date", "Area", "Entry", "Volume", "Job", "EnteredBy", "Note"]].concat(log.map(x => [x.EntryDate ? new Date(x.EntryDate).toISOString().slice(0, 10) : "", x.AreaName, x.EntryType, x.CubicYards, x.Job, x.EnteredBy, x.Note])).map(r => r.map(q).join(",")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = "placement_log.csv"; document.body.appendChild(a); a.click(); a.remove();
  }
  else if (t.id === "btnSave") { const d = draft(); if (!d) return; await run(async () => { await saveEntry(d); form.vol = ""; form.note = ""; }, "Saved. PA " + d.area + " updated."); }
});
async function run(fn, okMsg) {
  busy = true; lastError = ""; render();
  try { await fn(); if (okMsg) toast(okMsg); } catch (err) { lastError = err.message; }
  busy = false; render();
}

(async function start() {
  try { session = JSON.parse(sessionStorage.getItem(SKEY) || "null"); if (session && Date.now() > session.expires) session = null; } catch (e) { session = null; }
  const q = new URLSearchParams(location.search);
  if (q.get("error")) { lastError = "Sign-in was cancelled or refused: " + (q.get("error_description") || q.get("error")); history.replaceState(null, "", REDIRECT); }
  if (q.get("code")) { try { await finishSignIn(q.get("code"), q.get("state")); } catch (err) { lastError = err.message; } }
  render();
  if (session) await run(loadAll);
})();

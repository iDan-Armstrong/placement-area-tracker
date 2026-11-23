"use strict";
/* SNND Manager. Signs in to ArcGIS Online, reads placement areas from a hosted feature layer,
   saves each entry and status change to the layer and to a log table, and shows the district
   web maps with the files attached to placement areas and real estate tracts. */
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
let sel = null, type = "place", view = "areas", busy = false, lastError = "";
let statusPick = null, statusFor = null;

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

/* The layer keeps status in two fields. Active drives the capacity symbol, Status drives the map colors. */
const STATUS = [
  { k: "A", label: "Active", active: "Active", code: "A" },
  { k: "IU", label: "In use", active: "Active", code: "IU" },
  { k: "IA", label: "Inactive", active: "Inactive", code: "IA" },
  { k: "UC", label: "Under construction", active: "Offline", code: "UC" },
  { k: "OFF", label: "Offline", active: "Offline", code: null }
];
const statusKey = a => (a.active === "Active" ? (a.status === "IU" ? "IU" : "A") : a.status === "UC" ? "UC" : a.active === "Offline" ? "OFF" : a.active === "Inactive" || a.status === "IA" ? "IA" : "");
const statusLabel = a => { const s = STATUS.find(x => x.k === statusKey(a)); return s ? s.label : "Not set"; };
const BLOCKED = "Change its status to Active or In use before recording material.";

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
const EXPIRED = "Your sign-in has expired. Please sign in to ArcGIS Online again.";
function signOut(msg) {
  sessionStorage.removeItem(SKEY); session = null; areas = []; log = []; lastError = msg || "";
  // Once the map library is loaded, a fresh page is the clean way back to the sign-in screen.
  if (window.require && window.require.on) { if (msg) sessionStorage.setItem("pat-msg", msg); location.reload(); return; }
  render();
}

/* ---------- ArcGIS REST ---------- */
async function rest(url, params, post) {
  if (session && Date.now() > session.expires - 30000) { signOut(EXPIRED); throw new Error(EXPIRED); }
  const p = new URLSearchParams(Object.assign({ f: "json", token: session.token }, params));
  const r = post ? await fetch(url, { method: "POST", body: p }) : await fetch(url + "?" + p);
  const j = await r.json();
  if (j.error) {
    if (j.error.code === 498 || j.error.code === 499) { signOut(EXPIRED); throw new Error(EXPIRED); }
    throw new Error((j.error.message || "Request failed") + (j.error.details && j.error.details.length ? " (" + j.error.details.join("; ") + ")" : "") + " [" + url.split("/rest/services/").pop() + "]");
  }
  return j;
}
const BASE_FIELDS = ["NAME", "TotalCapac", "UsedCapac", "AvailCapac", "PercCapac", "Date_", "Active", "Status", "SymbolStat", "Acres"];
const areaFields = () => [oidField].concat(BASE_FIELDS, hasLast ? [LAST] : []).join(",");
const day = ms => (ms && ms > 631152000000 ? new Date(ms).toISOString().slice(0, 10) : "");
function toArea(f) {
  const a = f.attributes;
  return { oid: a[oidField], name: String(a.NAME), total: +a.TotalCapac || 0, used: +a.UsedCapac || 0, survey: day(a.Date_), last: day(a[LAST]), active: a.Active || "", status: a.Status || "", acres: +a.Acres || 0 };
}
const nameKey = n => { const m = /^(\d+)(.*)$/.exec(n) || [0, 1e9, n]; return [+m[1], m[2]]; };
async function loadAll() {
  const meta = await rest(CFG.areasUrl, {});
  oidField = meta.objectIdField || "OBJECTID";
  hasLast = (meta.fields || []).some(f => f.name === LAST);
  const q = await rest(CFG.areasUrl + "/query", { where: "1=1", outFields: areaFields(), returnGeometry: "false" });
  areas = q.features.map(toArea).sort((x, y) => { const a = nameKey(x.name), b = nameKey(y.name); return a[0] - b[0] || String(a[1]).localeCompare(String(b[1])); });
  if (!sel || !areas.some(a => a.name === sel)) sel = areas.length ? areas[0].name : null;
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
  if (now.active !== "Active" && e.type !== "settotal") throw new Error("PA " + e.area + " is marked " + statusLabel(now) + ". " + BLOCKED + " Nothing was saved.");
  const next = applyEntry(now.total, now.used, e);
  const c = calc(next.total, next.used, now.active);
  const when = Date.parse(e.date + "T12:00:00Z");
  const over = c.total > 0 && c.used > c.total ? " OVER CAPACITY by " + fmt(c.used - c.total) + " " + CFG.units + "." : "";
  const row = { AreaName: e.area, EntryType: TYPES[e.type], CubicYards: e.vol, EntryDate: when, Job: e.job, EnteredBy: e.by, Note: (e.note ? e.note + " " : "") + (over ? over.trim() + " " : "") + "(used " + fmt(now.used) + " to " + fmt(c.used) + ", capacity " + fmt(now.total) + " to " + fmt(c.total) + ")" };
  const attrs = { TotalCapac: c.total, UsedCapac: c.used, AvailCapac: c.avail, PercCapac: c.pct == null ? 0 : +c.pct.toFixed(4), SymbolStat: c.sym };
  // A new total capacity comes from a new survey, so it moves the survey date. Every other entry moves the last entry date.
  if (e.type === "settotal") attrs.Date_ = when; else if (hasLast) attrs[LAST] = when;
  await writeBoth(row, attrs, cur.oid);
  Object.assign(cur, { total: c.total, used: c.used }, e.type === "settotal" ? { survey: e.date } : { last: e.date });
  await loadLog();
  if (M) M.pa.refresh();
}
/* Adds the log row, then updates the area. If the area update fails the log row is taken back out,
   so the log never claims something the layer did not get. */
async function writeBoth(row, attrs, oid) {
  const add = await rest(CFG.logUrl + "/applyEdits", { adds: JSON.stringify([{ attributes: row }]) }, true);
  const ar = add.addResults && add.addResults[0];
  if (!ar || !ar.success) throw new Error("The log row was not saved: " + JSON.stringify(ar && ar.error || add));
  attrs[oidField] = oid;
  let ok = false, why = "";
  try {
    const up = await rest(CFG.areasUrl + "/applyEdits", { updates: JSON.stringify([{ attributes: attrs }]) }, true);
    const ur = up.updateResults && up.updateResults[0];
    ok = !!(ur && ur.success); if (!ok) why = JSON.stringify(ur && ur.error || up);
  } catch (err) { why = err.message; }
  if (!ok) {
    try { await rest(CFG.logUrl + "/applyEdits", { deletes: String(ar.objectId) }, true); } catch (err) { why += " Also could not remove the log row " + ar.objectId + "."; }
    throw new Error("The placement area was not updated, so nothing was saved. " + why);
  }
}
async function saveStatus(name, key) {
  const st = STATUS.find(x => x.k === key), cur = areas.find(a => a.name === name);
  const fresh = await rest(CFG.areasUrl + "/query", { where: oidField + "=" + cur.oid, outFields: areaFields(), returnGeometry: "false" });
  if (!fresh.features.length) throw new Error("PA " + name + " was not found in the layer.");
  const now = toArea(fresh.features[0]), c = calc(now.total, now.used, st.active);
  const row = { AreaName: name, EntryType: "Status changed", CubicYards: 0, EntryDate: Date.now(), Job: "", EnteredBy: session.username, Note: statusLabel(now) + " to " + st.label };
  await writeBoth(row, { Active: st.active, Status: st.code, SymbolStat: c.sym }, cur.oid);
  Object.assign(cur, { active: st.active, status: st.code || "" });
  await loadLog();
  if (M) M.pa.refresh();
}

/* ---------- map (ArcGIS Maps SDK for JavaScript, loaded the first time the Map page opens) ---------- */
let M = null, mapMode = "pa", mapSel = null, files = null, fileBusy = "", fileErr = "", delArm = null, mapState = "";
const GOLD = { type: "simple", symbol: { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: [224, 168, 0, 1], width: 2.5, style: "dash" } } };
const lkey = l => (l && l.url ? l.url.replace(/\/+$/, "") + "/" + l.layerId : "").toLowerCase();
function loadSdk() {
  return new Promise((res, rej) => {
    if (window.require && window.require.on) return res();
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    if (dark) $("#mapPage").classList.add("calcite-mode-dark");
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://js.arcgis.com/" + CFG.sdk + "/esri/themes/" + (dark ? "dark" : "light") + "/main.css"; document.head.appendChild(css);
    const s = document.createElement("script"); s.src = "https://js.arcgis.com/" + CFG.sdk + "/"; s.onload = () => res();
    s.onerror = () => rej(new Error("The map library could not be loaded. Check the internet connection and refresh the page.")); document.head.appendChild(s);
  });
}
const mods = names => new Promise((res, rej) => window.require(names, (...m) => res(m), rej));
async function initMap() {
  if (M || mapState === "loading") return;
  mapState = "loading"; renderSide();
  try {
    await loadSdk();
    const [esriConfig, esriId, WebMap, MapView, FeatureLayer, LayerList, Legend, Expand, AttachmentsContent, reactiveUtils] = await mods(["esri/config", "esri/identity/IdentityManager", "esri/WebMap", "esri/views/MapView", "esri/layers/FeatureLayer", "esri/widgets/LayerList", "esri/widgets/Legend", "esri/widgets/Expand", "esri/popup/content/AttachmentsContent", "esri/core/reactiveUtils"]);
    esriConfig.portalUrl = CFG.portal;
    // Never show the map library's own sign-in box (it names internal item IDs). If it asks for one,
    // either the sign-in has expired, which sends the person back to this page's sign-in screen,
    // or the account cannot see one of the layers.
    esriId.on("dialog-create", async () => {
      try { await rest(CFG.portal + "/sharing/rest/portals/self", {}); } catch (e) { return; }
      if (!M) { mapState = "error:Your account does not have access to the district maps. Ask the GIS administrator to share them with you."; renderSide(); }
    });
    await rest(CFG.portal + "/sharing/rest/portals/self", {});
    const cred = { token: session.token, userId: session.username, expires: session.expires, ssl: true };
    esriId.registerToken(Object.assign({ server: CFG.portal + "/sharing/rest" }, cred));
    esriId.registerToken(Object.assign({ server: CFG.areasUrl.split("/rest/services")[0] + "/rest/services" }, cred));
    // One map: the Operations web map, plus any layer the Real Estate web map has that Operations does not.
    const ops = new WebMap({ portalItem: { id: CFG.opsMapId } }), re = new WebMap({ portalItem: { id: CFG.reMapId } });
    await Promise.all([ops.load(), re.load()]);
    const have = new Set(ops.allLayers.toArray().map(lkey).filter(Boolean)), extra = [];
    re.layers.toArray().forEach(l => (l.type === "group" ? l.layers.toArray() : [l]).forEach(x => { if (x.type === "feature" && !have.has(lkey(x))) { have.add(lkey(x)); extra.push(x); } }));
    extra.forEach(l => ops.add(l, Math.min(1, ops.layers.length)));
    const find = u => ops.allLayers.find(l => l.type === "feature" && lkey(l) === u.toLowerCase());
    let pa = find(CFG.mapAreasUrl); const tracts = find(CFG.tractsUrl);
    if (!pa || !tracts) throw new Error("The web maps do not contain the placement area or real estate tract layer this page expects.");
    await Promise.all([pa.load(), tracts.load()]);
    if (CFG.areasUrl.toLowerCase() !== CFG.mapAreasUrl.toLowerCase()) {
      // Test mode: show the test copy in place of the live placement area layer, drawn the same way.
      const t = new FeatureLayer({ url: CFG.areasUrl, title: pa.title + " (test copy)", renderer: pa.renderer, popupTemplate: pa.popupTemplate, labelingInfo: pa.labelingInfo, labelsVisible: pa.labelsVisible });
      ops.remove(pa); ops.add(t); await t.load(); pa = t;
    }
    // Label every placement area with its number, in both modes.
    pa.labelingInfo = [{ labelExpressionInfo: { expression: '"PA " + $feature.NAME' }, labelPlacement: "always-horizontal", deconflictionStrategy: "none",
      symbol: { type: "text", color: [3, 42, 84, 1], haloColor: [255, 255, 255, 1], haloSize: 2, font: { family: "Arial", size: 11, weight: "bold" } } }];
    pa.labelsVisible = true;
    for (const l of [pa, tracts]) {
      l.outFields = ["*"];
      const pt = l.popupTemplate || l.createPopupTemplate();
      if (Array.isArray(pt.content) && !pt.content.some(c => c.type === "attachments")) pt.content = pt.content.concat([new AttachmentsContent({ displayType: "list" })]);
      l.popupTemplate = pt;
    }
    for (let p = tracts.parent; p && p.type === "group"; p = p.parent) p.visible = true;
    const view = new MapView({ container: "mapView", map: ops });
    view.ui.add(new Expand({ view, content: new LayerList({ view }), expanded: innerWidth > 1400, expandTooltip: "Layers" }), "top-right");
    view.ui.add(new Expand({ view, content: new Legend({ view }), expandTooltip: "Legend" }), "bottom-left");
    M = { view, pa, tracts, paRenderer: pa.renderer };
    reactiveUtils.watch(() => view.popup && view.popup.selectedFeature, g => onPick(g));
    mapState = ""; setMode(mapMode);
  } catch (err) { mapState = "error:" + (err && err.message || err); renderSide(); }
}
function setMode(m) {
  mapMode = m;
  document.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  if (M) {
    const re = m === "re";
    M.pa.renderer = re ? GOLD : M.paRenderer; M.pa.popupEnabled = !re;
    M.tracts.visible = true; M.tracts.popupEnabled = re; M.tracts.opacity = re ? 1 : 0.3;
    M.view.map.reorder(M.pa, M.view.map.layers.length - 1);
    try { M.view.closePopup(); } catch (e) { }
  }
  mapSel = null; files = null; fileErr = ""; renderSide();
}
function onPick(g) {
  if (!g || !M) return;
  const kind = g.layer === M.pa ? "pa" : g.layer === M.tracts ? "tract" : null;
  if (!kind || (kind === "pa") !== (mapMode === "pa")) return;
  mapSel = { kind, oid: g.attributes[g.layer.objectIdField], a: g.attributes, url: kind === "pa" ? CFG.areasUrl : CFG.tractsUrl };
  if (kind === "pa" && g.attributes.NAME != null && areas.some(a => a.name === String(g.attributes.NAME))) sel = String(g.attributes.NAME);
  files = null; fileErr = ""; delArm = null; renderSide(); loadFiles();
}

/* ---------- files attached to a placement area (surveys) or a tract (title documents) ---------- */
const canEdit = kind => !!(CFG.files && CFG.files[kind === "pa" ? "areas" : "tracts"]);
const kb = n => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
async function loadFiles() {
  const s = mapSel; if (!s) return;
  try { const j = await rest(s.url + "/" + s.oid + "/attachments", {}); if (s !== mapSel) return; files = j.attachmentInfos || []; }
  catch (e) { if (s !== mapSel) return; files = []; fileErr = e.message; }
  renderSide();
}
async function logFile(s, what, name) {
  if (s.kind !== "pa") return;
  try { await rest(CFG.logUrl + "/applyEdits", { adds: JSON.stringify([{ attributes: { AreaName: String(s.a.NAME), EntryType: what, CubicYards: 0, EntryDate: Date.now(), Job: "", EnteredBy: session.username, Note: name } }]) }, true); await loadLog(); } catch (e) { }
}
async function addFiles(list) {
  const s = mapSel; if (!s || !canEdit(s.kind)) return;
  fileErr = "";
  for (const f of list) {
    if (f.size > 10 * 1048576) { fileErr = f.name + " is larger than 10 MB, which is the limit for one upload. It was not added."; continue; }
    fileBusy = "Uploading " + f.name + "…"; renderSide();
    try {
      const fd = new FormData(); fd.append("f", "json"); fd.append("token", session.token); fd.append("attachment", f, f.name);
      const j = await (await fetch(s.url + "/" + s.oid + "/addAttachment", { method: "POST", body: fd })).json();
      const r = j.addAttachmentResult;
      if (j.error || !r || !r.success) throw new Error((j.error && j.error.message) || JSON.stringify(r && r.error || j));
      await logFile(s, "Survey file added", f.name);
    } catch (e) { fileErr = f.name + " was not added. " + e.message; }
  }
  fileBusy = ""; if (s === mapSel) await loadFiles();
}
async function removeFile(id) {
  const s = mapSel, f = (files || []).find(x => String(x.id) === String(id)); if (!s || !f || !canEdit(s.kind)) return;
  fileBusy = "Removing " + f.name + "…"; fileErr = ""; delArm = null; renderSide();
  try {
    const j = await rest(s.url + "/" + s.oid + "/deleteAttachments", { attachmentIds: String(id) }, true);
    const r = j.deleteAttachmentResults && j.deleteAttachmentResults[0];
    if (!r || !r.success) throw new Error(JSON.stringify(r && r.error || j));
    await logFile(s, "Survey file removed", f.name);
  } catch (e) { fileErr = f.name + " was not removed. " + e.message; }
  fileBusy = ""; if (s === mapSel) await loadFiles();
}
async function openFile(id) {
  const s = mapSel, f = (files || []).find(x => String(x.id) === String(id)); if (!s || !f) return;
  const w = window.open("", "_blank");
  try {
    const r = await fetch(s.url + "/" + s.oid + "/attachments/" + id + "?token=" + encodeURIComponent(session.token));
    if (!r.ok) throw new Error("The server answered " + r.status + ".");
    const u = URL.createObjectURL(new Blob([await r.blob()], { type: f.contentType || "application/octet-stream" }));
    if (w) w.location = u; else { const a = document.createElement("a"); a.href = u; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); }
  } catch (e) { if (w) w.close(); fileErr = f.name + " could not be opened. " + e.message; renderSide(); }
}
function renderSide() {
  const el = $("#mapSide"); if (!el) return;
  if (mapState === "loading") { el.innerHTML = '<p class="muted">Loading the map…</p>'; return; }
  if (mapState.startsWith("error:")) { el.innerHTML = `<div class="msg bad" style="margin:0">${esc(mapState.slice(6))}</div>`; return; }
  const pa = mapMode === "pa", what = pa ? "Survey files" : "Title documents";
  if (!mapSel) {
    el.innerHTML = `<h2>${pa ? "Placement areas" : "Real estate"}</h2><p class="muted">${pa ? "Select a placement area on the map to see its capacity and survey files. Real estate tracts are shown faded and cannot be selected in this mode." : "Select a tract on the map to see its details and title documents. Placement areas are shown as a dashed gold outline and cannot be selected in this mode."}</p><p class="muted small">Use the layer list on the map to turn other layers on and off.</p>`;
    return;
  }
  const a = mapSel.a; let head;
  if (pa) {
    const ar = areas.find(x => x.name === String(a.NAME)), c = ar && calc(ar.total, ar.used, ar.active);
    head = `<h2>PA ${esc(a.NAME)}</h2>` + (ar ? `<p><span class="dot ${c.sym}"></span>${esc(statusLabel(ar))}${"GYR".includes(c.sym || "x") ? ' <span class="muted">· ' + SYM[c.sym] + "</span>" : ""}</p><dl class="kv"><dt>Total capacity</dt><dd>${ar.total ? fmt(ar.total) : "not set"}</dd><dt>Used</dt><dd>${fmt(ar.used)}</dd><dt>Available</dt><dd>${ar.total ? fmt(c.avail) + " (" + pctf(c.pct) + ")" : ""}</dd><dt>Survey date</dt><dd>${esc(ar.survey)}</dd><dt>Last entry</dt><dd>${esc(ar.last)}</dd></dl><button class="btn" id="btnToEntry">Record material or change status</button>` : "");
  } else {
    const d = a.EXP_DT ? day(a.EXP_DT) : "";
    head = `<h2>${esc(a.Type || "Tract")}</h2><dl class="kv">${[["Book and page", a.BKPG], ["Grantor", a.Grantor], ["Interest", a.INT], ["Acres", a.Calc_AC != null ? (+a.Calc_AC).toFixed(2) : ""], ["Expires", d], ["Condition", a.CONDC || a.COND]].filter(r => r[1] != null && r[1] !== "").map(r => `<dt>${r[0]}</dt><dd>${esc(r[1])}</dd>`).join("")}</dl>`;
  }
  const ed = canEdit(mapSel.kind);
  el.innerHTML = head + `<h3>${what}</h3>` +
    (files == null ? '<p class="muted">Loading…</p>' : files.length ? `<ul class="files">${files.map(f => `<li><button class="link" data-open="${f.id}" title="Open ${esc(f.name)}">${esc(f.name)}</button><span class="muted small">${kb(f.size)}</span>${ed ? (String(delArm) === String(f.id) ? `<button class="btn sm danger" data-del="${f.id}">Remove for good</button><button class="btn sm" data-keep="1">Keep</button>` : `<button class="btn sm" data-arm="${f.id}">Remove</button>`) : ""}</li>`).join("")}</ul>` : `<p class="muted">No ${what.toLowerCase()} attached yet.</p>`) +
    (fileBusy ? `<p class="muted">${esc(fileBusy)}</p>` : "") + (fileErr ? `<div class="msg bad">${esc(fileErr)}</div>` : "") +
    (ed ? `<label class="btn pri up ${fileBusy ? "busy" : ""}">Add ${pa ? "survey file" : "title document"}<input type="file" id="attFile" multiple hidden></label><p class="muted small">Up to 10 MB per file. Removing a file cannot be undone.</p>` : `<p class="muted small">Adding and removing ${what.toLowerCase()} is turned off in this version.</p>`);
}

/* ---------- screen ---------- */
function parseVol(t) { const v = parseFloat(String(t).replace(/[, ]/g, "")); return isFinite(v) ? v : NaN; }
let form = { vol: "", date: today(), job: "", by: "", note: "" };
function draft() { const vol = parseVol(form.vol); if (isNaN(vol) || !sel) return null; return { area: sel, type, vol, date: form.date || today(), job: form.job.trim(), by: form.by.trim() || (session && session.username) || "", note: form.note.trim() }; }
function checks(e, a, before, after) {
  const out = []; if (!e) return out;
  if (e.vol < 0) out.push(["bad", 'Enter a positive number. Use "Material removed" to take volume out.']);
  if (e.vol === 0 && (type === "place" || type === "remove")) out.push(["bad", "Enter a volume greater than zero."]);
  if (after.total <= 0 && type !== "settotal") out.push(["warn", "PA " + sel + ' has no total capacity on record, so percent available cannot be worked out. Use "Set total capacity" first if you know it.']);
  if (after.total > 0 && after.used > after.total) out.push(["warn", "This puts PA " + sel + " over its recorded capacity by " + fmt(after.used - after.total) + " " + CFG.units + ". You can still save; the overage will be written into the log."]);
  if (after.used < 0) out.push(["bad", "Used volume would go below zero."]);
  if (a.active !== "Active" && type !== "settotal") out.push(["bad", "PA " + sel + " is marked " + statusLabel(a) + ". " + BLOCKED]);
  if (before.sym !== after.sym && "GYR".includes(after.sym || "x") && "GYR".includes(before.sym || "x")) out.push(["ok", 'Capacity status changes from "' + SYM[before.sym] + '" to "' + SYM[after.sym] + '".']);
  if (e.date > today()) out.push(["warn", "That date is in the future."]);
  return out;
}
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600); }
const banner = () => (CFG.testMode ? '<div class="banner">TEST MODE. Placement area entries, status changes and survey files go to the test copy, not the live layer.</div>' : "");
const logo = (src, cls) => (src ? `<img class="${cls}" src="${esc(src)}" alt="" onerror="this.remove()">` : "");
const brand = () => `${logo(CFG.logos && CFG.logos.org, "logo")}<div class="brand"><div class="org">${esc(CFG.org)}</div><h1>${esc(CFG.title)}</h1></div>`;
function renderFoot() {
  const d = CFG.developer || {};
  $("#foot").innerHTML = `<span>Developed by</span>${logo(CFG.logos && CFG.logos.dev, "devlogo")}<span><b>${esc(d.company || "")}</b>${d.author ? ", " + esc(d.author) : ""}</span>`;
}
function showMap(on) { $("#mapPage").hidden = !on; if (on) { if (!M) initMap(); else renderSide(); } }

function renderSignedOut(msg) {
  showMap(false);
  $("#app").innerHTML = banner() + `<header class="top">${brand()}</header><div class="center"><section class="pnl"><div class="in"><p>Placement area capacity, material entries, the district map and its real estate records in one place.</p><p class="muted small">Sign in with your ArcGIS Online account for this organization.</p>${msg ? `<div class="msg bad" style="margin-bottom:12px">${esc(msg)}</div>` : ""}<button class="btn pri" id="btnSignIn" style="padding:8px 18px">Sign in</button></div></section></div>`;
  $("#btnSignIn").onclick = signIn;
}
function render() {
  if (!session) return renderSignedOut(lastError);
  const top = `<header class="top ${busy ? "busy" : ""}">${brand()}<nav class="nav"><button id="navAreas" class="${view === "areas" ? "on" : ""}">Placement areas</button><button id="navMap" class="${view === "map" ? "on" : ""}">Map</button></nav><span class="sp"></span><span class="sub">Signed in as ${esc(session.username)}</span><button class="btn" id="btnRefresh">Refresh</button><button class="btn" id="btnOut">Sign out</button></header>${lastError ? `<div class="err">${esc(lastError)}</div>` : ""}`;
  const curA = areas.find(a => a.name === sel);
  if (!curA) { showMap(false); $("#app").innerHTML = banner() + top + (lastError ? "" : '<p class="center muted">Loading placement areas…</p>'); return; }
  showMap(view === "map");
  if (view === "map") { $("#app").innerHTML = banner() + top; return; }
  if (statusFor !== sel) { statusFor = sel; statusPick = null; }
  const rows = areas.map(a => Object.assign({ a }, calc(a.total, a.used, a.active)));
  const cur = calc(curA.total, curA.used, curA.active);
  const d = draft();
  const nx = d ? applyEntry(curA.total, curA.used, d) : curA;
  const after = calc(nx.total, nx.used, curA.active);
  const act = rows.filter(r => r.total > 0), T = act.reduce((s, r) => s + r.total, 0), U = act.reduce((s, r) => s + r.used, 0);
  const cs = checks(d, curA, cur, after);
  const sk = statusKey(curA), pick = statusPick || sk;
  const line = (k, b, a, p) => `<span class="k">${k}</span><span class="v">${p ? pctf(b) : fmt(b)}</span><span class="arrow">→</span><span class="v ${d && a !== b ? "new" : ""}">${p ? pctf(a) : fmt(a)}</span>`;
  const keep = document.activeElement && document.activeElement.id, ss = keep && document.activeElement.selectionStart;
  $("#app").innerHTML = banner() + top + `
<div class="tiles"><div class="tile"><span>Total capacity on record</span><b>${fmt(T)}</b></div><div class="tile"><span>Used</span><b>${fmt(U)}</b></div><div class="tile"><span>Available</span><b>${fmt(T - U)}</b> <small>${T ? ((T - U) / T * 100).toFixed(1) : "0"}%</small></div><div class="tile"><span>Areas nearly full</span><b>${rows.filter(r => r.sym === "R").length}</b> <small>of ${act.length} with capacity set</small></div><div class="tile"><span>Entries logged</span><b>${log.length}</b></div></div>
<div class="wrap ${busy ? "busy" : ""}">
 <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
  <section class="pnl"><header><h2>Placement areas</h2><span class="sp"></span><span class="small muted">Volumes in ${esc(CFG.units)}</span></header>
  <div class="tw"><table><thead><tr><th>Area</th><th>Status</th><th class="num">Total</th><th class="num">Used</th><th class="num">Available</th><th class="num">% available</th><th></th><th>Survey date</th><th>Last entry</th><th class="num">Acres</th></tr></thead><tbody>${rows.map(r => `<tr class="row ${r.a.name === sel ? "sel" : ""}" data-a="${esc(r.a.name)}"><td><b>PA ${esc(r.a.name)}</b></td><td><span class="dot ${r.sym}"></span>${esc(statusLabel(r.a))}${"GYR".includes(r.sym || "x") ? ' <span class="muted">· ' + SYM[r.sym] + "</span>" : ""}</td><td class="num">${r.total ? fmt(r.total) : '<span class="muted">not set</span>'}</td><td class="num">${fmt(r.used)}</td><td class="num">${r.total ? fmt(r.avail) : ""}</td><td class="num">${r.pct == null ? "" : r.pct.toFixed(1) + "%"}</td><td>${r.pct == null ? "" : `<span class="bar"><i class="${r.sym}" style="width:${Math.max(0, Math.min(100, 100 - r.pct))}%"></i></span>`}</td><td>${esc(r.a.survey)}</td><td>${esc(r.a.last)}</td><td class="num">${fmt(r.a.acres)}</td></tr>`).join("")}</tbody></table></div>
  </section>
  <section class="pnl"><header><h2>Entry log</h2><span class="sp"></span><span class="small muted">${log.length ? log.length + " entries, newest first" : ""}</span><button class="btn sm" id="btnLogCsv">Export (CSV)</button></header><div class="tw" style="max-height:320px">${log.length ? `<table><thead><tr><th>Date</th><th>Area</th><th>Entry</th><th class="num">Volume</th><th>Job</th><th>By</th><th>Note</th></tr></thead><tbody>${log.map(e => `<tr><td>${e.EntryDate ? new Date(e.EntryDate).toISOString().slice(0, 10) : ""}</td><td>PA ${esc(e.AreaName)}</td><td>${esc(e.EntryType)}</td><td class="num">${e.CubicYards ? fmt(e.CubicYards) : ""}</td><td>${esc(e.Job)}</td><td>${esc(e.EnteredBy)}</td><td style="white-space:normal">${esc(e.Note)}</td></tr>`).join("")}</tbody></table>` : '<p class="in muted" style="margin:0">No entries yet.</p>'}</div></section>
 </div>
 <section class="pnl" style="position:sticky;top:14px"><header><h2>PA ${esc(sel)}</h2></header><div class="in">
  <div class="fg">
   <label class="f full">Placement area<select id="fArea">${areas.map(a => `<option value="${esc(a.name)}" ${a.name === sel ? "selected" : ""}>PA ${esc(a.name)}${a.active !== "Active" ? " (" + esc(statusLabel(a)) + ")" : ""}</option>`).join("")}</select></label>
   <label class="f">Status<select id="fStatus">${sk ? "" : '<option value="">Not set</option>'}${STATUS.map(x => `<option value="${x.k}" ${x.k === pick ? "selected" : ""}>${x.label}</option>`).join("")}</select></label>
   <div style="display:flex;align-items:flex-end"><button class="btn" id="btnStatus" style="width:100%" ${busy || !pick || pick === sk ? "disabled" : ""}>Save status</button></div>
  </div>
  <p class="small muted" style="margin:6px 0 14px">Material can be recorded while an area is Active or In use. Each status change is written to the log.</p>
  <h3 class="sec">Record an entry</h3>
  <div class="fg">
   <div class="full"><div class="seg">${Object.keys(TYPES).map(k => `<button data-t="${k}" class="${type === k ? "on" : ""}">${TYPES[k]}</button>`).join("")}</div></div>
   <label class="f">${{ place: "Volume placed", remove: "Volume removed", setused: "Used volume is now", settotal: "Total capacity is now" }[type]} (${esc(CFG.units)})<input class="big" type="text" inputmode="decimal" id="f-vol" placeholder="0" autocomplete="off" value="${esc(form.vol)}"></label>
   <label class="f">${type === "settotal" ? "Survey date" : "Date"}<input type="date" id="f-date" value="${esc(form.date)}"></label>
   <label class="f">Job, contract or dredge cycle<input type="text" id="f-job" autocomplete="off" value="${esc(form.job)}"></label>
   <label class="f">Entered by<input type="text" id="f-by" autocomplete="off" placeholder="${esc(session.username)}" value="${esc(form.by)}"></label>
   <label class="f full">Note<input type="text" id="f-note" autocomplete="off" value="${esc(form.note)}"></label>
  </div>
  <div class="ba"><span class="h">PA ${esc(sel)}: now → after this entry</span>${line("Total capacity", cur.total, after.total)}${line("Used", cur.used, after.used)}${line("Available", cur.avail, after.avail)}${line("% available", cur.pct, after.pct, true)}<span class="k">Capacity</span><span class="v"><span class="dot ${cur.sym}"></span>${SYM[cur.sym]}</span><span class="arrow">→</span><span class="v ${cur.sym !== after.sym ? "new" : ""}"><span class="dot ${after.sym}"></span>${SYM[after.sym]}</span></div>
  ${cs.map(([t, m]) => `<div class="msg ${t}">${esc(m)}</div>`).join("")}
  <div style="display:flex;gap:8px;margin-top:12px"><button class="btn pri" id="btnSave" style="flex:1" ${!d || busy || cs.some(c => c[0] === "bad") ? "disabled" : ""}>${busy ? "Saving…" : "Save entry"}</button><button class="btn" id="btnClear">Clear</button></div>
  <p class="small muted" style="margin:12px 0 0">Figures recalculate as you type. Saving updates the map layer and adds a row to the log. To correct a mistake, save a new entry that reverses it.</p>
 </div></section>
</div>`;
  if (keep) { const el = document.getElementById(keep); if (el) { el.focus(); try { el.setSelectionRange(ss, ss); } catch (e) { } } }
}

document.addEventListener("input", e => { const id = e.target.id || ""; if (id.startsWith("f-")) { form[id.slice(2)] = e.target.value; render(); } });
document.addEventListener("change", e => {
  if (e.target.id === "fArea") { sel = e.target.value; render(); }
  else if (e.target.id === "fStatus") { statusPick = e.target.value; render(); }
  else if (e.target.id === "attFile") { const list = [...e.target.files]; e.target.value = ""; if (list.length) addFiles(list); }
});
document.addEventListener("keydown", e => { if (e.target.id === "f-vol" && e.key === "Enter") { const b = $("#btnSave"); if (b && !b.disabled) b.click(); } });
document.addEventListener("click", async e => {
  const t = e.target, ds = k => { const el = t.closest("[data-" + k + "]"); return el ? el.dataset[k] : null; };
  let v;
  if ((v = ds("a")) != null) { sel = v; render(); return; }
  if ((v = ds("t")) != null) { type = v; render(); const el = $("#f-vol"); if (el) el.focus(); return; }
  if ((v = ds("mode")) != null) { setMode(v); return; }
  if ((v = ds("open")) != null) { openFile(v); return; }
  if ((v = ds("arm")) != null) { delArm = v; renderSide(); return; }
  if (ds("keep") != null) { delArm = null; renderSide(); return; }
  if ((v = ds("del")) != null) { removeFile(v); return; }
  if (t.id === "navAreas" || t.id === "btnToEntry") { view = "areas"; render(); }
  else if (t.id === "navMap") { view = "map"; render(); }
  else if (t.id === "btnOut") signOut("");
  else if (t.id === "btnClear") { form.vol = ""; form.note = ""; form.job = ""; render(); }
  else if (t.id === "btnRefresh") { await run(loadAll, "Refreshed"); if (M) { M.pa.refresh(); M.tracts.refresh(); } }
  else if (t.id === "btnLogCsv") {
    const q = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const text = [["Date", "Area", "Entry", "Volume", "Job", "EnteredBy", "Note"]].concat(log.map(x => [x.EntryDate ? new Date(x.EntryDate).toISOString().slice(0, 10) : "", x.AreaName, x.EntryType, x.CubicYards, x.Job, x.EnteredBy, x.Note])).map(r => r.map(q).join(",")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = "placement_log.csv"; document.body.appendChild(a); a.click(); a.remove();
  }
  else if (t.id === "btnSave") { const d = draft(); if (!d) return; await run(async () => { await saveEntry(d); form.vol = ""; form.note = ""; }, "Saved. PA " + d.area + " updated."); }
  else if (t.id === "btnStatus") { const name = sel, key = statusPick; if (!key) return; await run(async () => { await saveStatus(name, key); statusPick = null; }, "PA " + name + " is now " + STATUS.find(x => x.k === key).label + "."); }
});
async function run(fn, okMsg) {
  busy = true; lastError = ""; render();
  try { await fn(); if (okMsg) toast(okMsg); } catch (err) { lastError = err.message; }
  busy = false; render();
}

(async function start() {
  renderFoot();
  try { session = JSON.parse(sessionStorage.getItem(SKEY) || "null"); if (session && Date.now() > session.expires) session = null; } catch (e) { session = null; }
  const q = new URLSearchParams(location.search);
  const kept = sessionStorage.getItem("pat-msg"); if (kept) { sessionStorage.removeItem("pat-msg"); if (!session) lastError = kept; }
  if (q.get("error")) { lastError = "Sign-in was cancelled or refused: " + (q.get("error_description") || q.get("error")); history.replaceState(null, "", REDIRECT); }
  if (q.get("code")) { try { await finishSignIn(q.get("code"), q.get("state")); } catch (err) { lastError = err.message; } }
  render();
  if (session) await run(loadAll);
})();

"use strict";

const $ = (sel) => document.querySelector(sel);
const POLL_MS = 5000;
// Namen und Beschreibungen kommen aus i18n.js (theme.<id>, layout.<id>)
const THEMES = [
  { id: "system", color: null },
  { id: "omarchy", color: "#161716" },
  { id: "aurora", color: "#0c0d18" },
  { id: "klar", color: "#eceff3" },
  { id: "papier", color: "#f3efe6" },
  { id: "nacht", color: "#000000" },
  { id: "bento", color: "#141414" },
];
const LAYOUTS = [{ id: "standard" }, { id: "uebersicht" }, { id: "raeume" }, { id: "grundriss" }];
const LANG_CHOICES = ["auto", "de", "en"];
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");

let state = null;      // letzte Antwort von /api/state
let lastOk = 0;
let pending = 0;       // laufende Aktionen: kein Neuzeichnen
let dragging = false;  // Regler wird gezogen: kein Neuzeichnen
let pointerDownAt = 0;  // Zeitpunkt des Drueckens, 0 = losgelassen
let renderLater = false;
let pollTimer = null;
let omarchyName = null; // vom Plugin gemeldetes Omarchy-Theme
const prefs = loadPrefs();

// ------------------------------------------------------------ Hilfen

function loadPrefs() {
  try {
    return Object.assign({ cats: [], zone: "", open: [], theme: "system", layout: "standard", lang: "auto", turn: { wide: 1, narrow: 0 }, zoneAll: [], zoneSplit: [] }, JSON.parse(localStorage.getItem("homey-dash") || "{}"));
  } catch {
    return { cats: [], zone: "", open: [], theme: "system", layout: "standard" };
  }
}

function savePrefs() {
  try { localStorage.setItem("homey-dash", JSON.stringify(prefs)); } catch { /* privat/blockiert */ }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

const num = (v, digits = 1) => v.toLocaleString(t("locale"), { maximumFractionDigits: digits });
const byName = (a, b) => a.name.localeCompare(b.name, LANG);
const zoneLabel = (name) => name.replace(/^\d+\s*\|\s*/, "");

function toast(msg) {
  const box = $("#toast");
  box.textContent = msg;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 3500);
}

async function api(path, body) {
  const opts = body === undefined
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Homey-Dash": "1" },
        body: JSON.stringify(body) };
  const resp = await fetch(path, opts);
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 401 && path !== "/api/login") showLogin();
  if (!resp.ok) throw Object.assign(new Error(data.code ? t(`err.${data.code}`) : data.error || resp.statusText), { status: resp.status });
  return data;
}

// ------------------------------------------------------------ Zonen

// Reihenfolge aus data/order.json (Zonennamen), nicht genannte dahinter in Homey-Reihenfolge
function zoneRank(z) {
  const i = z ? (state.zoneOrder || []).indexOf(zoneLabel(z.name)) : -1;
  return i < 0 ? Infinity : i;
}

function zoneTree() {
  const byId = Object.fromEntries(state.zones.map((z) => [z.id, z]));
  const kids = {};
  for (const z of state.zones) (kids[z.parent || ""] ||= []).push(z);
  for (const list of Object.values(kids)) list.sort((a, b) => zoneRank(a) - zoneRank(b) || (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  // Tiefensuche, die Wurzel ("Home") selbst bleibt als erster Eintrag
  const order = [];
  const walk = (parent, depth) => {
    for (const z of kids[parent] || []) {
      order.push({ zone: z, depth });
      walk(z.id, depth + 1);
    }
  };
  walk("", 0);
  return { byId, order, kids };
}

function descendants(zoneId, kids) {
  const ids = new Set([zoneId]);
  const stack = [zoneId];
  while (stack.length) for (const c of kids[stack.pop()] || []) { ids.add(c.id); stack.push(c.id); }
  return ids;
}

// ------------------------------------------------------------ Filter

function visible(dev, zonesById, ignoreCats = false) {
  if (!ignoreCats && prefs.cats.length && !dev.cats.some((c) => prefs.cats.includes(c))) return false;
  const q = $("#search").value.trim().toLowerCase();
  if (!q) return true;
  const zone = zonesById[dev.zone];
  return dev.name.toLowerCase().includes(q) || (zone && zone.name.toLowerCase().includes(q));
}

// ------------------------------------------------------------ Lampengruppen

// Gruppe (z. B. Deckenspots) als eine Kachel: an, sobald ein Mitglied an ist; Helligkeit = hellstes Mitglied
function groupDevice(g) {
  const devs = g.members.map((id) => state.devices.find((d) => d.id === id)).filter(Boolean);
  const up = devs.filter((d) => d.available);
  const on = up.filter((d) => d.caps.onoff && d.caps.onoff.value);
  const dims = (on.length ? on : up).map((d) => d.caps.dim && d.caps.dim.value).filter((v) => typeof v === "number");
  const caps = { onoff: { value: on.length > 0, setable: true } };
  if (devs.every((d) => d.caps.dim)) caps.dim = { value: dims.length ? Math.max(...dims) : 0, setable: true };
  return { id: `g:${g.id}`, name: g.name, zone: g.zone, class: "light", cats: ["light"], available: up.length > 0,
           control: true, caps, group: { id: g.id, devs, on: on.length } };
}

// Kacheln einer Zone: je Zone umschaltbar zwischen Filter/alle und Gruppen/einzeln (pro Geraet gemerkt)
// Ohne Filter und Suche zeigt eine Zone nur Bedienbares (Lichter, Thermostate); "Alle" zeigt jedes Geraet
const operable = (d) => d.control || d.heat;

function zoneItems(zoneIds, byId, key) {
  const all = prefs.zoneAll.includes(key);
  const narrow = !all && !prefs.cats.length && !$("#search").value.trim();
  const devs = state.devices.filter((d) => zoneIds.has(d.zone) && visible(d, byId, all) && (!narrow || operable(d)));
  if (prefs.zoneSplit.includes(key)) return devs;
  const grouped = new Set();
  const items = [];
  for (const g of state.groups || []) {
    if (!zoneIds.has(g.zone) || !devs.some((d) => g.members.includes(d.id))) continue;
    g.members.forEach((id) => grouped.add(id));
    items.push(groupDevice(g));
  }
  return [...items, ...devs.filter((d) => !grouped.has(d.id))];
}

const zoneHasGroup = (zoneIds) => (state.groups || []).some((g) => zoneIds.has(g.zone));

function toggleZonePref(name, key) {
  prefs[name] = prefs[name].includes(key) ? prefs[name].filter((k) => k !== key) : [...prefs[name], key];
  // Handy: Zone aufklappen, sonst passiert die Aenderung unsichtbar in der zugeklappten Zone
  if (!prefs.open.includes(key)) prefs.open.push(key);
  savePrefs();
  render();
}

// Zwei kleine Umschalter im Zonenkopf; preventDefault, damit der Klick die Zone nicht auf-/zuklappt
function zoneToggles(zoneIds, key) {
  const btn = (name, label, title) => el("button", {
    class: "zone-toggle", type: "button", "aria-pressed": String(prefs[name].includes(key)), title,
    onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); toggleZonePref(name, key); },
  }, label);
  return el("span", { class: "zone-toggles", onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); } },
    btn("zoneAll", t("zone.all"), t("zone.all.title")),
    zoneHasGroup(zoneIds) ? btn("zoneSplit", t("zone.split"), t("zone.split.title")) : null);
}

// Kurzinfo eines Raums: Ist (-> Ziel), Lichter, heizt, Bewegung. Fuer Zonenkopf und Grundriss.
function roomInfo(devs) {
  const lights = devs.filter((d) => d.control && d.caps.onoff && d.available);
  const on = lights.filter((d) => d.caps.onoff.value).length;
  const roomTemp = (cls) => devs.find((d) => d.class === cls && !/humid/i.test(d.name) && typeof temp(d) === "number");
  const tdev = roomTemp("thermostat") || roomTemp("sensor");
  const thermo = devs.find((d) => d.heat && d.available && (!d.caps.onoff || d.caps.onoff.value));
  const goal = thermo && thermo.caps.target_temperature.value;
  const tempText = tdev ? `${num(temp(tdev))}°${typeof goal === "number" ? ` → ${num(goal)}°` : ""}` : typeof goal === "number" ? `→ ${num(goal)}°` : null;
  return {
    lights, on, tempText,
    heating: devs.some((d) => (d.class === "heater" && d.caps.onoff && d.caps.onoff.value) || (d.heat && isHeating(d))),
    motion: devs.some((d) => d.caps.alarm_motion && d.caps.alarm_motion.value),
  };
}

// ------------------------------------------------------------ Kacheln

function describe(dev) {
  const c = dev.caps;
  const val = (id) => c[id] && c[id].value;
  let value = "";
  const meta = [];
  if (dev.group) meta.push(t("dev.groupOn", { on: dev.group.on, n: dev.group.devs.length }));
  if (c.onoff && dev.control) {
    value = val("onoff") ? t("dev.on") : t("dev.off");
    if (val("onoff") && c.dim && typeof val("dim") === "number") value += ` · ${Math.round(val("dim") * 100)} %`;
  } else if (c.onoff) {
    meta.push(val("onoff") ? t("dev.onLower") : t("dev.offLower"));
  }
  if (typeof val("measure_temperature") === "number") {
    const tt = `${num(val("measure_temperature"))} °C`;
    if (value) meta.push(tt); else value = tt;
  }
  if (typeof val("target_temperature") === "number") meta.push(t("dev.target", { v: num(val("target_temperature")) }));
  if (typeof val("measure_humidity") === "number") meta.push(t("dev.humidity", { v: num(val("measure_humidity"), 0) }));
  if (typeof val("measure_power") === "number") {
    const p = `${num(val("measure_power"), 0)} W`;
    if (value) meta.push(p); else value = p;
  }
  if (typeof val("meter_power") === "number") {
    const kwh = `${num(val("meter_power"))} kWh`;
    if (value) meta.push(kwh); else value = kwh;
  }
  if (c.alarm_motion) meta.push(val("alarm_motion") ? t("dev.motion") : t("dev.still"));
  if (c.alarm_contact) meta.push(val("alarm_contact") ? t("dev.open") : t("dev.closed"));
  if (typeof val("measure_luminance") === "number") meta.push(`${num(val("measure_luminance"), 0)} lx`);
  if (typeof val("measure_battery") === "number" && val("measure_battery") <= 20) meta.push(t("dev.battery", { v: val("measure_battery") }));
  if (!dev.available) value = t("dev.unavailable");
  return { value: value || "–", meta: meta.join(" · ") };
}

// Thermostat: Ist gross, Soll mit -/+ in 0,5er-Schritten, Regelung an/aus. Grenzen wie im Gateway.
const TARGET_MIN = 15;
const TARGET_MAX = 25;
const targetTimers = {};  // je Thermostat: gesammelte Klicks, gesendet nach kurzer Pause

// Heizt gerade: Ausgang des Thermostats (vt_onoff) oder eine eingeschaltete Heizung im selben Raum.
// Orange heisst nur das; "Regelung an" allein ist neutral.
function isHeating(dev) {
  if (dev.caps.onoff && dev.caps.onoff.value === false) return false;
  if (dev.caps.vt_onoff && dev.caps.vt_onoff.value === true) return true;
  return state.devices.some((d) => d.zone === dev.zone && d.class === "heater" && d.caps.onoff && d.caps.onoff.value === true);
}

function thermoTile(dev, zonesById, showZone) {
  const c = dev.caps;
  const active = c.onoff ? c.onoff.value === true : true;
  const heating = isHeating(dev);
  const target = c.target_temperature.value;
  const ist = temp(dev);
  const label = el("span", { class: "target" }, typeof target === "number" ? `${num(target)}°` : "–");
  const step = (delta) => {
    const base = typeof dev.caps.target_temperature.value === "number" ? dev.caps.target_temperature.value : 20;
    const next = Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.round((base + delta) * 2) / 2));
    if (!targetTimers[dev.id]) { pending++; targetTimers[dev.id] = { prev: dev.caps.target_temperature.value }; }
    dev.caps.target_temperature.value = next;
    label.textContent = `${num(next)}°`;
    clearTimeout(targetTimers[dev.id].timer);
    targetTimers[dev.id].timer = setTimeout(() => sendTarget(dev), 800);
  };
  const can = dev.available;
  const name = showZone && zonesById[dev.zone] ? zoneLabel(zonesById[dev.zone].name) : dev.name;
  const status = !dev.available ? t("dev.unavailable") : !active ? t("thermo.off") : heating ? t("thermo.heating") : null;
  return el("article", { class: `tile thermo${active ? "" : " off"}${heating ? " heating" : ""}${dev.available ? "" : " na"}`, "data-id": dev.id },
    el("div", { class: "tile-main" },
      el("span", { class: "name" }, name),
      el("div", { class: "thermo-row" },
        el("span", { class: "value" }, typeof ist === "number" ? `${num(ist)}°` : "–"),
        c.onoff ? el("button", {
          class: `room-switch mini${active ? " on" : ""}`, type: "button", disabled: !can, "aria-pressed": String(active),
          "aria-label": `${name}: ${active ? t("thermo.ctrlOff") : t("thermo.ctrlOn")}`, title: active ? t("thermo.ctrlOff") : t("thermo.ctrlOn"),
          onclick: () => setCap(dev, "onoff", !active),
        }, el("span", { class: "knob" })) : null),
      status ? el("span", { class: `badge${heating ? " hot" : ""}` }, status) : null),
    el("div", { class: "stepper" },
      el("button", { type: "button", disabled: !can, "aria-label": t("thermo.colder", { name }), onclick: () => step(-0.5) }, "−"),
      label,
      el("button", { type: "button", disabled: !can, "aria-label": t("thermo.warmer", { name }), onclick: () => step(0.5) }, "+")));
}

async function sendTarget(dev) {
  const { prev } = targetTimers[dev.id];
  delete targetTimers[dev.id];
  const value = dev.caps.target_temperature.value;
  try {
    await api(`/api/device/${encodeURIComponent(dev.id)}/target_temperature`, { value });
  } catch (err) {
    dev.caps.target_temperature.value = prev;
    toast(`${dev.name}: ${err.message}`);
  } finally {
    pending--;
    render();
    setTimeout(refresh, 600);
  }
}

function tile(dev, zonesById, showZone) {
  if (dev.heat) return thermoTile(dev, zonesById, showZone);
  const c = dev.caps;
  const { value, meta } = describe(dev);
  const on = dev.control && c.onoff && c.onoff.value === true;
  const canToggle = dev.available && dev.control && c.onoff && c.onoff.setable;
  const inner = [
    el("span", { class: "name" }, dev.name),
    showZone && zonesById[dev.zone] ? el("span", { class: "where" }, zoneLabel(zonesById[dev.zone].name)) : null,
    el("span", { class: "value" }, value),
    meta ? el("span", { class: "meta" }, meta) : null,
  ];
  const main = canToggle
    ? el("button", { class: "tile-main", type: "button", "aria-pressed": String(on),
                     onclick: () => setCap(dev, "onoff", !on) }, ...inner)
    : el("div", { class: "tile-main" }, ...inner);
  const node = el("article", { class: `tile${on ? " on" : ""}${dev.group ? " group" : ""}${dev.available ? "" : " na"}`, "data-id": dev.id }, main);
  if (dev.available && dev.control && c.dim && c.dim.setable) {
    const slider = el("input", {
      type: "range", min: "0", max: "100", step: "1", value: String(Math.round((c.dim.value || 0) * 100)),
      "aria-label": t("dev.dim", { name: dev.name }),
    });
    slider.addEventListener("pointerdown", () => { dragging = true; });
    slider.addEventListener("change", () => { dragging = false; setCap(dev, "dim", Number(slider.value) / 100); });
    node.append(slider);
  }
  return node;
}

// ------------------------------------------------------------ Zeichnen

function render() {
  if (!state || pending || dragging) return;
  // Finger/Maus gedrueckt: nicht den Knopf unter dem Finger ersetzen, nach dem Loslassen nachholen
  if (Date.now() - pointerDownAt < 2000) { renderLater = true; return; }
  const { byId, order, kids } = zoneTree();
  const wide = matchMedia("(min-width: 600px)").matches;

  // Raumliste (ab Tablet sichtbar)
  // Gezaehlt werden Kacheln, also wie im Abschnitt: Gruppen als eine, Zonen-Umschalter beachtet
  const counts = {};
  for (const id of Object.keys(byId)) counts[id] = zoneItems(new Set([id]), byId, id).length;
  const total = (id) => [...descendants(id, kids)].reduce((n, z) => n + (counts[z] || 0), 0);
  const zoneButtons = [el("button", { class: "zone-btn", type: "button", "aria-current": String(!prefs.zone),
    onclick: () => { prefs.zone = ""; savePrefs(); render(); } }, t("zones.all"), el("span", { class: "count" }, String(Object.values(counts).reduce((a, b) => a + b, 0))))];
  for (const { zone, depth } of order) {
    if (!zone.parent) continue;  // Wurzel "Home" ist "Alle Räume"
    const n = total(zone.id);
    if (!n) continue;
    zoneButtons.push(el("button", {
      class: `zone-btn${depth > 1 ? " sub" : ""}`, type: "button", "aria-current": String(prefs.zone === zone.id),
      onclick: () => { prefs.zone = zone.id; savePrefs(); render(); },
    }, zoneLabel(zone.name), el("span", { class: "count" }, String(n))));
  }
  $("#zones").replaceChildren(...zoneButtons);

  // Heizung: Thermostate, nach Raum benannt; ohne die abgeschalteten ohne Ist-Wert (Kueche: kein Sensor, heizt nie)
  const idle = (d) => d.caps.onoff && !d.caps.onoff.value && typeof temp(d) !== "number";
  const heat = state.devices.filter((d) => d.heat && !idle(d) && visible(d, byId))
    .sort((a, b) => zoneRank(byId[a.zone]) - zoneRank(byId[b.zone]) || byName(a, b));
  $("#heat-tiles").replaceChildren(...heat.map((d) => tile(d, byId, true)));
  $("#heat").hidden = !heat.length;

  // Favoriten, ohne Thermostate (die stehen unter Heizung)
  const favs = state.favoriteDevices.map((id) => state.devices.find((d) => d.id === id))
    .filter((d) => d && !d.heat && visible(d, byId));
  $("#fav-tiles").replaceChildren(...favs.map((d) => tile(d, byId, true)));
  // Nur Messwerte (z. B. die Phasen) stehen schon unter Verbrauch: dann ausblenden
  $("#favs").hidden = !favs.some(operable);
  $('.bottom a[href="#favs"]').hidden = $("#favs").hidden;

  // Räume
  const scope = wide && prefs.zone && byId[prefs.zone] ? descendants(prefs.zone, kids) : null;
  const groups = [];
  for (const { zone } of order) {
    if (scope && !scope.has(zone.id)) continue;
    if (!zone.parent) continue;  // Wurzel "Home": nur das Wetter, steht im Widget "Draussen"
    const own = state.devices.filter((d) => d.zone === zone.id);
    const devs = zoneItems(new Set([zone.id]), byId, zone.id).sort((a, b) => Number(!!b.group) - Number(!!a.group) || byName(a, b));
    // Zone bleibt sichtbar, solange sie ueberhaupt Geraete hat: sonst waere "Alle" nicht erreichbar
    if (!devs.length && (prefs.cats.length || $("#search").value.trim() || !own.length)) continue;
    const parent = zone.parent && byId[zone.parent] && byId[zone.parent].parent ? `${zoneLabel(byId[zone.parent].name)} › ` : "";
    const open = wide || prefs.open.includes(zone.id) || $("#search").value.trim() !== "";
    const info = roomInfo(own);
    const sub = [info.tempText, info.lights.length ? t("dev.groupOn", { on: info.on, n: info.lights.length }) : null, info.heating ? t("thermo.heating") : null].filter(Boolean).join(" · ");
    const details = el("details", { class: `room${info.on ? " lit" : ""}${info.heating ? " heating" : ""}`, open },
      el("summary", {},
        el("span", { class: "room-title" }, el("span", {}, `${parent}${zoneLabel(zone.name)}`, info.motion ? el("span", { class: "dot", title: t("sum.motion") }) : null),
          sub ? el("span", { class: "room-sub" }, sub) : null),
        zoneToggles(new Set([zone.id]), zone.id), el("span", { class: "count" }, String(devs.length))),
      el("div", { class: "tiles" }, ...(devs.length ? devs.map((d) => tile(d, byId, false))
        : [el("p", { class: "empty" }, t("room.empty"))])));
    details.addEventListener("toggle", () => {
      if (wide) return;
      prefs.open = prefs.open.filter((id) => id !== zone.id);
      if (details.open) prefs.open.push(zone.id);
      savePrefs();
    });
    groups.push(details);
  }
  $("#room-list").replaceChildren(...(groups.length ? groups : [el("p", { class: "empty" }, t("room.noMatch"))]));

  // Flows
  $("#flow-list").replaceChildren(...state.flows.map((f) =>
    el("button", { class: "flow-btn", type: "button", disabled: !f.enabled, onclick: (ev) => runFlow(f, ev.currentTarget) }, f.name)));
  $("#flows").hidden = !state.flows.length;

  // Verbrauch: groesste Verbraucher, ohne Summe (Phasen und Steckdosen wuerden doppelt zaehlen)
  const power = state.devices
    .filter((d) => d.available && d.caps.measure_power && d.caps.measure_power.value > 0)
    .sort((a, b) => b.caps.measure_power.value - a.caps.measure_power.value).slice(0, 10);
  $("#power-list").replaceChildren(...(power.length
    ? power.map((d) => el("li", {}, el("span", {}, d.name), el("span", { class: "w" }, `${num(d.caps.measure_power.value, 0)} W`)))
    : [el("li", { class: "empty" }, t("power.none"))]));

  for (const chip of document.querySelectorAll(".chip")) chip.setAttribute("aria-pressed", String(prefs.cats.includes(chip.dataset.cat)));
  const layout = document.documentElement.dataset.layout;
  if (layout === "uebersicht" || (layout === "standard" && !wide)) updateSummary(byId);
  if (layout === "raeume") renderRoomCards(byId, order, kids);
  if (layout === "grundriss") renderPlan(byId, kids);
  if ($("#room-sheet").open) renderSheet(byId, kids);
  updateStatus();
}

// ------------------------------------------------------------ Uebersicht

const powerHistory = [];  // Hausleistung der letzten Abrufe fuer die Kurve
let lastSample = 0;
const shownNumbers = {};  // zuletzt angezeigte Zahl je Feld, Ausgangspunkt der Animation

function tween(key, target, digits, unit) {
  const node = document.querySelector(`[data-sum="${key}"]`);
  if (target === null || target === undefined || Number.isNaN(target)) { node.textContent = "–"; delete shownNumbers[key]; return; }
  const from = shownNumbers[key] ?? target;
  shownNumbers[key] = target;
  const fmt = (v) => `${num(v, digits)}${unit}`;
  if (REDUCED.matches || from === target) { node.textContent = fmt(target); return; }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 700);
    const eased = 1 - (1 - k) ** 3;
    node.textContent = fmt(from + (target - from) * eased);
    if (k < 1 && shownNumbers[key] === target) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const temp = (d) => d.caps.measure_temperature && d.caps.measure_temperature.value;

function updateSummary(byId) {
  const set = (key, text) => { document.querySelector(`[data-sum="${key}"]`).textContent = text; };
  const devs = state.devices.filter((d) => d.available);

  // Lichter: an / schaltbar, Ring zeigt den Anteil
  const lights = devs.filter((d) => d.control && d.caps.onoff);
  const on = lights.filter((d) => d.caps.onoff.value);
  tween("lights", on.length, 0, "");
  const rooms = [...new Set(on.map((d) => byId[d.zone] && zoneLabel(byId[d.zone].name)).filter(Boolean))];
  set("lights-rooms", on.length ? rooms.join(", ") : t("sum.allOff", { n: lights.length }));
  $(".ring-fg").style.strokeDashoffset = String(100 - (lights.length ? (on.length / lights.length) * 100 : 0));

  // Drinnen: Thermostate (der "Humidity"-Thermostat misst Feuchte, nicht Temperatur)
  const inside = devs.filter((d) => d.class === "thermostat" && !/humid/i.test(d.name) && typeof temp(d) === "number").map(temp);
  tween("inside", inside.length ? inside.reduce((a, b) => a + b, 0) / inside.length : null, 1, " °C");
  set("inside-range", inside.length ? t("sum.range", { lo: num(Math.min(...inside)), hi: num(Math.max(...inside)), n: inside.length }) : "");

  // Draussen: Geraet aus config.json (outdoor_device), sonst das erste mit Wetter/Aussen im Namen
  const conf = state.summary || {};
  const out = (conf.outdoor && devs.find((d) => d.id === conf.outdoor && typeof temp(d) === "number"))
    || devs.find((d) => /weather|wetter|au(ß|ss)en|outdoor|outside/i.test(d.name) && typeof temp(d) === "number");
  tween("outside", out ? temp(out) : null, 1, " °C");
  const hum = out && out.caps.measure_humidity && out.caps.measure_humidity.value;
  set("outside-sub", typeof hum === "number" ? t("dev.humidity", { v: num(hum, 0) }) : "");

  // Haus jetzt: Summe der Geraete aus config.json (power_devices), sonst der Leistungsmesser in der Zaehler-Zone (power_zone)
  let zoneRe = /verteiler|meter/i;
  try { if (conf.powerZone) zoneRe = new RegExp(conf.powerZone, "i"); } catch { /* ungueltig: Vorgabe */ }
  const meters = conf.power && conf.power.length
    ? devs.filter((d) => conf.power.includes(d.id) && d.caps.measure_power)
    : devs.filter((d) => byId[d.zone] && zoneRe.test(byId[d.zone].name) && d.caps.measure_power);
  const watts = meters.length ? meters.reduce((a, d) => a + (d.caps.measure_power.value || 0), 0) : null;
  tween("power", watts, 0, " W");
  if (watts !== null && state.ts !== lastSample) {
    lastSample = state.ts;
    powerHistory.push(watts);
    if (powerHistory.length > 60) powerHistory.shift();
  }
  drawSpark();

  // Bewegung und Warnungen
  const motion = devs.filter((d) => d.caps.alarm_motion && d.caps.alarm_motion.value);
  const motionRooms = [...new Set(motion.map((d) => byId[d.zone] && zoneLabel(byId[d.zone].name)).filter(Boolean))];
  document.querySelector('[data-sum="motion"]').replaceChildren(...(motionRooms.length
    ? motionRooms.map((r) => el("span", { class: "pulse" }, r))
    : [el("span", { class: "sum-sub" }, t("sum.quiet"))]));
  const offline = state.devices.filter((d) => !d.available).length;
  const battery = devs.filter((d) => d.caps.measure_battery && d.caps.measure_battery.value <= 20).length;
  set("warnings", [offline && t("sum.offline", { n: offline }), battery && t("sum.lowBattery", { n: battery })].filter(Boolean).join(" · "));
}

function drawSpark() {
  const line = $(".spark-line");
  const area = $(".spark-area");
  if (powerHistory.length < 2) { line.setAttribute("d", "M0 30 L120 30"); area.setAttribute("d", ""); return; }
  const lo = Math.min(...powerHistory);
  const hi = Math.max(...powerHistory);
  const span = hi - lo || 1;
  const pts = powerHistory.map((v, i) => [(i / (powerHistory.length - 1)) * 120, 30 - ((v - lo) / span) * 26]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  line.setAttribute("d", d);
  area.setAttribute("d", `${d} L120 32 L0 32 Z`);
}

// ------------------------------------------------------------ Raumkarten

let sheetZone = null;

function zoneDevices(zoneId, kids) {
  const ids = descendants(zoneId, kids);
  return state.devices.filter((d) => ids.has(d.zone));
}

function renderRoomCards(byId, order, kids) {
  const q = $("#search").value.trim().toLowerCase();
  const cards = [];
  for (const { zone, depth } of order) {
    if (!zone.parent || depth > 1) continue;  // nur Raeume unter "Home", Unterzonen gehoeren zum Raum
    if (q && !zone.name.toLowerCase().includes(q)) continue;
    const devs = zoneDevices(zone.id, kids);
    if (!devs.length) continue;
    const lights = devs.filter((d) => d.control && d.caps.onoff && d.available);
    const on = lights.filter((d) => d.caps.onoff.value);
    // Raumtemperatur nur von Thermostat oder Sensor: Steckdosen melden ihre eigene Innentemperatur
    const roomTemp = (cls) => devs.find((d) => d.class === cls && !/humid/i.test(d.name) && typeof temp(d) === "number");
    const thermo = roomTemp("thermostat") || roomTemp("sensor");
    const motion = devs.some((d) => d.caps.alarm_motion && d.caps.alarm_motion.value);
    const info = [
      thermo ? `${num(temp(thermo))} °C` : null,
      lights.length ? t("room.lightsOn", { on: on.length, n: lights.length }) : t("room.devices", { n: devs.length }),
    ].filter(Boolean).join(" · ");
    const card = el("article", { class: `room-card${on.length ? " on" : ""}` },
      el("button", { class: "room-open", type: "button", onclick: () => openSheet(zone.id) },
        el("span", { class: "room-name" }, zoneLabel(zone.name), motion ? el("span", { class: "dot", title: t("sum.motion") }) : null),
        el("span", { class: "room-info" }, info)),
      lights.length ? el("button", {
        class: `room-switch${on.length ? " on" : ""}`, type: "button", "aria-pressed": String(on.length > 0),
        "aria-label": t("room.switchAll", { room: zoneLabel(zone.name), state: on.length ? t("dev.offLower") : t("dev.onLower") }),
        onclick: () => switchRoom(zone.id, lights, !on.length),
      }, el("span", { class: "knob" })) : null);
    cards.push(card);
  }
  $("#room-cards").replaceChildren(...(cards.length ? cards : [el("p", { class: "empty" }, t("room.none"))]));
}

function openSheet(zoneId) {
  sheetZone = zoneId;
  const { byId, kids } = zoneTree();
  renderSheet(byId, kids);
  $("#room-sheet").showModal();
}

function renderSheet(byId, kids) {
  if (!sheetZone || !byId[sheetZone]) return;
  $("#sheet-title").textContent = zoneLabel(byId[sheetZone].name);
  const ids = descendants(sheetZone, kids);
  $("#sheet-toggles").replaceChildren(zoneToggles(ids, sheetZone));
  const devs = zoneItems(ids, byId, sheetZone)
    .sort((a, b) => Number(b.control || !!b.heat) - Number(a.control || !!a.heat) || byName(a, b));
  $("#sheet-tiles").replaceChildren(...devs.map((d) => tile(d, byId, false)));
  // Raumschalter: alle freigegebenen Lichter des Raums
  const lights = zoneDevices(sheetZone, kids).filter((d) => d.control && d.caps.onoff && d.available);
  const anyOn = lights.some((d) => d.caps.onoff.value);
  const sw = $("#sheet-switch");
  sw.hidden = !lights.length;
  sw.classList.toggle("on", anyOn);
  sw.textContent = anyOn ? t("room.lightOff") : t("room.lightOn");
  sw.title = anyOn ? t("room.allOff") : t("room.allOn");
  const zoneId = sheetZone;
  sw.onclick = () => switchRoom(zoneId, lights, !anyOn);
}

// ------------------------------------------------------------ Grundriss

let floorplan;            // undefined = noch nicht geladen, null = keiner hinterlegt
let planRooms = [];       // [{ zone, g, label, info, dot, sw }]
const SVG_NS = "http://www.w3.org/2000/svg";
const SLAB = 48;          // Plattenhoehe
const GAP = 7;            // halbe Fuge zwischen den Raeumen

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

// Breit: isometrisch. Schmal (Handy): schraege Draufsicht von vorn, halb so breit, Schrift doppelt so gross.
let planOblique = false;
const VIEW = { iso: [1, 1], oblique: [0, 1] };
const iso = ([x, y], z = 0) => (planOblique ? [x, y * 0.62 - z] : [(x - y) * 0.866, (x + y) * 0.5 - z]);
// Drehung in 90-Grad-Schritten nach links, je Geraet und Breite (Vorgabe: breit einmal, Handy gar nicht)
const turnKey = () => (planOblique ? "narrow" : "wide");
function planTurn(p) {
  for (let i = 0; i < ((prefs.turn && prefs.turn[turnKey()]) || 0) % 4; i++) p = [p[1], -p[0]];
  return p;
}
const ptsAttr = (pts) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

function signedArea(poly) {
  let a = 0;
  poly.forEach(([x1, y1], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; });
  return a / 2;
}

// Rechtwinklige Polygone um g nach innen versetzen: jede Ecke wandert um die Summe der Innennormalen
function inset(poly, g) {
  const sign = Math.sign(signedArea(poly));
  const normal = ([x1, y1], [x2, y2]) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    return [sign * -(y2 - y1) / len, sign * (x2 - x1) / len];
  };
  return poly.map((p, i) => {
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const next = poly[(i + 1) % poly.length];
    const [ax, ay] = normal(prev, p);
    const [bx, by] = normal(p, next);
    return [p[0] + g * (ax + bx), p[1] + g * (ay + by)];
  });
}

async function loadPlan() {
  try {
    floorplan = await api("/api/floorplan");
  } catch (err) {
    floorplan = null;
  }
  planRooms = [];
  render();
}

function buildPlan(byId) {
  planOblique = !matchMedia("(min-width: 600px)").matches;
  const view = planOblique ? VIEW.oblique : VIEW.iso;
  const zoneByLabel = Object.fromEntries(Object.values(byId).map((z) => [zoneLabel(z.name), z.id]));
  const centre = (poly) => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
  // Eine Platte kann mehrere Raeume tragen ("parts", z. B. Wohn- und Esszimmer): eine Flaeche, je Teil Beschriftung und Schalter
  const rooms = floorplan.rooms
    .map((r) => ({ ...r, poly: inset(r.poly.map(planTurn), GAP),
                   parts: (r.parts || [{ zone: r.zone, poly: r.poly, at: r.at }]).map((pt) => ({ id: zoneByLabel[pt.zone], label: pt.zone, poly: pt.poly.map(planTurn), at: pt.at && planTurn(pt.at) })) }))
    .map((r) => { const [cx, cy] = centre(r.poly); return { ...r, cx, cy }; })
    .sort((a, b) => (view[0] * a.cx + a.cy) - (view[0] * b.cx + b.cy));  // hinten zuerst zeichnen
  const shapes = svg("g");
  const labels = svg("g");
  const switches = svg("g");
  const defs = svg("defs");
  const all = [];
  planRooms = [];
  rooms.forEach((r, ri) => {
    const h = r.outdoor ? SLAB / 3 : SLAB;
    const sign = Math.sign(signedArea(r.poly));
    const single = r.parts.length === 1;
    const g = svg("g", { class: `room3d${r.outdoor ? " outdoor" : ""}${single ? "" : " shared"}` });
    // Seitenflaechen, die zum Betrachter (+x +y) zeigen
    r.poly.forEach((p, i) => {
      const q = r.poly[(i + 1) % r.poly.length];
      const out = [sign * (q[1] - p[1]), sign * -(q[0] - p[0])];
      if (out[0] * view[0] + out[1] * view[1] <= 0) return;
      const face = [iso(p), iso(q), iso(q, h), iso(p, h)];
      all.push(...face);
      g.append(svg("polygon", { class: out[0] > 0 ? "side-r" : "side-l", points: ptsAttr(face) }));
    });
    const top = r.poly.map((p) => iso(p, h));
    all.push(...top);
    g.append(svg("polygon", { class: "top", points: ptsAttr(top) }));
    if (!single) defs.append(svg("clipPath", { id: `plan-clip-${ri}` }, svg("polygon", { points: ptsAttr(top) })));
    for (const pt of r.parts) {
      // Tippflaeche: bei einem Raum die ganze Platte, bei mehreren je Teil (auf die Platte zugeschnitten, leuchtet einzeln)
      const hit = single ? g : svg("polygon", { class: "part", points: ptsAttr(pt.poly.map((p) => iso(p, h))), "clip-path": `url(#plan-clip-${ri})` });
      if (!single) g.append(hit);
      if (pt.id) {
        hit.setAttribute("tabindex", "0");
        hit.setAttribute("role", "button");
        hit.addEventListener("click", () => openSheet(pt.id));
        hit.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openSheet(pt.id); } });
      }
      const [lx, ly] = iso(pt.at || centre(pt.poly), h);  // "at": fester Beschriftungspunkt, z. B. in L-foermigen Raeumen
      // Beschriftung liegt flach auf der Platte, entlang der laengeren Seite (Handy: Draufsicht, gerade)
      const w = Math.max(...pt.poly.map((q) => q[0])) - Math.min(...pt.poly.map((q) => q[0]));
      const d = Math.max(...pt.poly.map((q) => q[1])) - Math.min(...pt.poly.map((q) => q[1]));
      const flat = planOblique ? "1 0 0 1" : w >= d ? "0.866 0.5 -0.866 0.5" : "0.866 -0.5 0.866 0.5";
      const place = `matrix(${flat} ${lx.toFixed(1)} ${ly.toFixed(1)})`;
      const info = svg("text", { class: "pl-info", x: "0", y: "14" });
      const dot = svg("circle", { class: "plan-dot", cx: "0", cy: "-72", r: "9" });
      const label = svg("g", { class: "plan-label", transform: place },
        svg("text", { class: "pl-name", x: "0", y: "-20" }, document.createTextNode(pt.label)), info, dot);
      labels.append(label);
      // Raumschalter unter der Beschriftung: eigene Ebene, damit der Tipp nicht das Raum-Blatt oeffnet
      let sw = null;
      if (pt.id) {
        sw = svg("g", { class: "plan-switch", role: "switch", tabindex: "0", transform: `${place} translate(-42 36)` },
          svg("rect", { class: "track", width: "84", height: "44", rx: "22" }),
          svg("circle", { class: "knob", cx: "22", cy: "22", r: "17" }));
        const toggle = () => {
          const lights = zoneDevices(pt.id, zoneTree().kids).filter((dv) => dv.control && dv.caps.onoff && dv.available);
          if (lights.length) switchRoom(pt.id, lights, !lights.some((dv) => dv.caps.onoff.value));
        };
        sw.addEventListener("click", toggle);
        sw.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
        switches.append(sw);
      }
      planRooms.push({ zone: pt.id, g, hit, single, label, info, dot, sw });
    }
    shapes.append(g);
  });
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const pad = 40;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad - 60;
  $("#plan-svg").setAttribute("viewBox", `${minX.toFixed(0)} ${minY.toFixed(0)} ${(Math.max(...xs) - minX + pad).toFixed(0)} ${(Math.max(...ys) - minY + pad).toFixed(0)}`);
  $("#plan-svg").replaceChildren(defs, shapes, labels, switches);
}

function renderPlan(byId, kids) {
  if (floorplan === undefined) { floorplan = false; loadPlan(); return; }  // false = Laden laeuft
  $("#plan-empty").hidden = floorplan !== null;
  $("#plan-turn").hidden = !floorplan;
  if (!floorplan) return;
  if (!planRooms.length) buildPlan(byId);
  const slabs = new Map();  // Platte -> leuchtet/heizt irgendein Teil
  for (const room of planRooms) {
    if (!slabs.has(room.g)) slabs.set(room.g, { on: false, heat: false });
    if (!room.zone) continue;
    const { lights, on, tempText, heating, motion } = roomInfo(zoneDevices(room.zone, kids));
    const slab = slabs.get(room.g);
    slab.on ||= on > 0;
    slab.heat ||= heating;
    if (!room.single) room.hit.classList.toggle("on", on > 0);
    room.label.classList.toggle("on", on > 0);
    room.dot.style.display = motion ? "" : "none";
    room.info.textContent = [tempText, lights.length ? t("dev.groupOn", { on, n: lights.length }) : null].filter(Boolean).join("  ");
    const name = byId[room.zone] ? zoneLabel(byId[room.zone].name) : "";
    room.sw.style.display = lights.length ? "" : "none";
    room.sw.classList.toggle("on", on > 0);
    room.sw.setAttribute("aria-checked", String(on > 0));
    room.sw.setAttribute("aria-label", t("room.switchAll", { room: name, state: on ? t("dev.offLower") : t("dev.onLower") }));
    room.hit.setAttribute("aria-label", `${name}${on ? t("room.litCount", { n: on }) : ""}${heating ? `, ${t("thermo.heating")}` : ""}`);
  }
  for (const [g, st] of slabs) {
    g.classList.toggle("on", st.on);
    g.classList.toggle("heat", st.heat);
  }
}

$("#plan-turn").addEventListener("click", () => {
  prefs.turn = { wide: 1, narrow: 0, ...prefs.turn };
  prefs.turn[turnKey()] = (prefs.turn[turnKey()] + 1) % 4;
  savePrefs();
  planRooms = [];
  render();
});

async function switchRoom(zoneId, lights, value) {
  pending++;
  const prev = lights.map((d) => d.caps.onoff.value);
  for (const d of lights) d.caps.onoff.value = value;
  pending--;
  render();
  pending++;
  try {
    const res = await api(`/api/zone/${encodeURIComponent(zoneId)}/lights`, { value });
    if (res.failed) toast(t("toast.lightsFailed", { n: res.failed }));
  } catch (err) {
    lights.forEach((d, i) => { d.caps.onoff.value = prev[i]; });
    toast(err.message);
  } finally {
    pending--;
    render();
    setTimeout(refresh, 800);
  }
}

$("#close-sheet").addEventListener("click", () => $("#room-sheet").close());
$("#room-sheet").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });
$("#room-sheet").addEventListener("close", () => { sheetZone = null; });

function updateStatus() {
  const s = $("#status");
  const age = Date.now() - lastOk;
  const stale = age > 3 * POLL_MS;
  s.classList.toggle("stale", stale);
  s.textContent = stale ? t("status.offline") : prefs.cats.length ? prefs.cats.map((c) => t(`cat.${c}`)).join(", ") : "";
}

// ------------------------------------------------------------ Aktionen

async function setCap(dev, cap, value) {
  pending++;
  // Gruppe: alle erreichbaren Mitglieder vorab umstellen, bei Fehler zurueck
  const targets = dev.group ? dev.group.devs.filter((d) => d.available && d.caps[cap]) : [dev];
  const prev = targets.map((d) => [d.caps[cap].value, d.caps.onoff && d.caps.onoff.value]);
  for (const d of targets) {
    d.caps[cap].value = value;
    if (cap === "dim" && value > 0 && d.caps.onoff) d.caps.onoff.value = true;
  }
  const node = document.querySelector(`.tile[data-id="${CSS.escape(dev.id)}"]`);
  if (node) node.classList.add("busy");
  const url = dev.group ? `/api/group/${encodeURIComponent(dev.group.id)}/${cap}` : `/api/device/${encodeURIComponent(dev.id)}/${cap}`;
  try {
    const res = await api(url, { value });
    if (res && res.failed) toast(`${dev.name}: ${t("toast.groupFailed", { n: res.failed })}`);
  } catch (err) {
    targets.forEach((d, i) => { d.caps[cap].value = prev[i][0]; if (d.caps.onoff) d.caps.onoff.value = prev[i][1]; });
    toast(`${dev.name}: ${err.message}`);
  } finally {
    pending--;
    render();
    setTimeout(refresh, 600);
  }
}

async function runFlow(flow, button) {
  button.disabled = true;
  try {
    await api(`/api/flow/${encodeURIComponent(flow.id)}/trigger`, {});
    button.classList.add("done");
    button.textContent = `${flow.name} ✓`;
    setTimeout(() => { button.classList.remove("done"); button.textContent = flow.name; button.disabled = false; refresh(); }, 2000);
  } catch (err) {
    button.disabled = false;
    toast(`${flow.name}: ${err.message}`);
  }
}

// ------------------------------------------------------------ Einstellungen

function applyTheme(id) {
  const theme = THEMES.find((x) => x.id === id) || THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  const dark = theme.id === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : !["klar", "papier"].includes(theme.id);
  document.querySelector('meta[name="theme-color"]').setAttribute("content", theme.color || (dark ? "#161615" : "#f4f4f1"));
}

// Das Theme gehoert zum Konto (Gateway); localStorage haelt nur eine Kopie fuer theme.js.
const URL_PICK = new URLSearchParams(location.search);  // ?theme=…&layout=…: nur anzeigen, nicht speichern

function useSettings(settings) {
  if (!settings) return;
  omarchyName = settings.omarchy;
  prefs.theme = settings.theme || "system";
  prefs.layout = settings.layout || "standard";
  prefs.lang = settings.lang || "auto";
  savePrefs();
  setLang(prefs.lang);
  if (THEMES.some((x) => x.id === URL_PICK.get("theme"))) prefs.theme = URL_PICK.get("theme");
  if (LAYOUTS.some((l) => l.id === URL_PICK.get("layout"))) prefs.layout = URL_PICK.get("layout");
  applyTheme(prefs.theme);
  applyLayout(prefs.layout);
  renderPicks();
}

function applyLayout(id) {
  document.documentElement.dataset.layout = LAYOUTS.some((l) => l.id === id) ? id : "standard";
  render();
}

function applyLang(id) {
  setLang(id);
  planRooms = [];  // Beschriftung im Grundriss neu
  render();
}

// Theme, Ansicht oder Sprache: sofort anwenden, im Konto speichern, bei Fehler zurueck
async function chooseSetting(key, id) {
  const apply = { theme: applyTheme, layout: applyLayout, lang: applyLang }[key];
  const prev = prefs[key];
  prefs[key] = id;
  savePrefs();
  apply(id);
  renderSettings();
  try {
    await api("/api/settings", { [key]: id });
  } catch (err) {
    prefs[key] = prev;
    savePrefs();
    apply(prev);
    renderSettings();
    toast(t("toast.notSaved", { msg: err.message }));
  }
}

// Schnellwahl im Kopf neben der Suche
function renderPicks() {
  const fill = (sel, list, current, label) => {
    sel.replaceChildren(...list.map((x) => el("option", { value: x.id }, label(x))));
    sel.value = current;
  };
  fill($("#pick-layout"), LAYOUTS, prefs.layout, (l) => t(`layout.${l.id}`));
  fill($("#pick-theme"), THEMES, prefs.theme, (x) => (x.id === "omarchy" && omarchyName ? `Omarchy · ${omarchyName}` : t(`theme.${x.id}`)));
}
$("#pick-layout").addEventListener("change", (ev) => chooseSetting("layout", ev.target.value));
$("#pick-theme").addEventListener("change", (ev) => chooseSetting("theme", ev.target.value));

let accountUser = null;  // aus /api/me, fuer die Zeile "Angemeldet als"

function renderSettings() {
  renderPicks();
  const demo = state && state.demo;
  $("#account-name").textContent = demo ? t("account.demo") : accountUser ? t("account.as", { user: accountUser }) : "";
  $("#logout").hidden = !!demo;
  renderThemes();
  $("#layout-list").replaceChildren(...LAYOUTS.map((l) => el("button", {
    class: "theme-opt", type: "button", role: "radio", "aria-checked": String(prefs.layout === l.id),
    onclick: () => chooseSetting("layout", l.id),
  }, el("span", { class: `swatch lay lay-${l.id}` }, el("i"), el("i"), el("i"), el("i")),
     el("span", { class: "name" }, t(`layout.${l.id}`)), el("span", { class: "desc" }, t(`layout.${l.id}.desc`)))));
  $("#lang-list").replaceChildren(...LANG_CHOICES.map((id) => el("button", {
    class: "chip", type: "button", role: "radio", "aria-checked": String((prefs.lang || "auto") === id),
    "aria-pressed": String((prefs.lang || "auto") === id), onclick: () => chooseSetting("lang", id),
  }, t(`lang.${id}`))));
}

function renderThemes() {
  $("#theme-list").replaceChildren(...THEMES.map((x) => el("button", {
    class: "theme-opt", type: "button", role: "radio", "aria-checked": String(prefs.theme === x.id),
    onclick: () => chooseSetting("theme", x.id),
  }, el("span", { class: `swatch sw-${x.id}` }, el("i"), el("i"), el("i")),
     el("span", { class: "name" }, t(`theme.${x.id}`)),
     el("span", { class: "desc" }, x.id === "omarchy" && omarchyName ? t("theme.omarchy.pc", { name: omarchyName }) : t(`theme.${x.id}.desc`)))));
}

$("#open-settings").addEventListener("click", async () => {
  renderSettings();
  $("#settings").showModal();
  try {
    const me = await api("/api/me");
    accountUser = me.user;
    omarchyName = me.settings && me.settings.omarchy;
    renderSettings();
  } catch { /* 401 zeigt Anmeldung */ }
});
$("#close-settings").addEventListener("click", () => $("#settings").close());
$("#settings").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });

// ------------------------------------------------------------ Ablauf

async function refresh() {
  if (document.hidden) return;
  try {
    state = await api("/api/state");
    lastOk = Date.now();
    render();
  } catch (err) {
    if (err.status !== 401) updateStatus();
  }
}

function showLogin() {
  clearInterval(pollTimer);
  pollTimer = null;
  $("#home").hidden = true;
  $("#login").hidden = false;
}

function showHome() {
  $("#login").hidden = true;
  $("#home").hidden = false;
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, POLL_MS);
}

$("#login").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    await api("/api/login", { user: form.get("user"), password: form.get("password") });
    ev.target.reset();
    $("#login-error").textContent = "";
    useSettings((await api("/api/me")).settings);
    reloadOmarchyCss();
    showHome();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  $("#settings").close();
  await api("/api/logout", {}).catch(() => {});
  state = null;
  floorplan = undefined;  // Grundriss gehoert zum Konto
  planRooms = [];
  showLogin();
});

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    const cat = chip.dataset.cat;
    prefs.cats = prefs.cats.includes(cat) ? prefs.cats.filter((c) => c !== cat) : [...prefs.cats, cat];
    savePrefs();
    render();
  });
}

$("#search").addEventListener("input", () => render());
// Regler losgelassen ohne Aenderung: change kommt dann nicht
document.addEventListener("pointerup", () => setTimeout(() => { dragging = false; }, 0));
document.addEventListener("pointercancel", () => { dragging = false; });
document.addEventListener("pointerdown", () => { pointerDownAt = Date.now(); }, true);
const released = () => {
  pointerDownAt = 0;
  if (renderLater) { renderLater = false; setTimeout(render, 0); }
};
document.addEventListener("pointerup", released, true);
document.addEventListener("pointercancel", released, true);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
matchMedia("(min-width: 600px)").addEventListener("change", () => { planRooms = []; render(); });

// Nach der Anmeldung kennt omarchy.css die Farben des Kontos: neu laden
function reloadOmarchyCss() {
  const link = document.querySelector('link[href^="omarchy.css"]');
  link.href = `omarchy.css?${Date.now()}`;
}

setLang(prefs.lang);
applyTheme(prefs.theme);
document.documentElement.dataset.layout = prefs.layout;
api("/api/me").then((me) => { useSettings(me.settings); showHome(); }).catch(() => showLogin());

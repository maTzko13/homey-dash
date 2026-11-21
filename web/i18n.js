"use strict";
// Texte der Oberflaeche. Sprache: ?lang=, sonst Einstellung des Kontos (Kopie in localStorage), sonst Browser.
// Neue Sprache: Block kopieren, Schluessel uebersetzen, Kennung in LANGS aufnehmen.
const LANGS = ["de", "en"];
const I18N = {
  de: {
    locale: "de-DE",
    title: "Zuhause",
    "login.user": "Benutzer", "login.password": "Passwort", "login.submit": "Anmelden",
    search: "Suchen", "search.label": "Geräte suchen", view: "Ansicht", theme: "Theme", settings: "Einstellungen",
    "filter.label": "Filter", "cat.light": "Licht", "cat.temperature": "Temperatur", "cat.power": "Strom",
    "nav.rooms": "Räume", "sum.label": "Übersicht", "sum.lightsOn": "Lichter an", "sum.inside": "Drinnen",
    "sum.outside": "Draußen", "sum.power": "Haus jetzt", "sum.motion": "Bewegung",
    "plan.label": "Grundriss", "plan.turn": "Grundriss nach links drehen", "plan.turnShort": "Nach links drehen",
    "plan.svg": "Wohnung isometrisch", "plan.empty": "Kein Grundriss hinterlegt.",
    "sec.heat": "Heizung", "sec.favs": "Favoriten", "sec.flows": "Flows", "sec.rooms": "Räume", "sec.power": "Verbrauch jetzt",
    "nav.sections": "Bereiche", close: "Schließen", "settings.layout": "Ansicht", "settings.account": "Konto",
    "settings.lang": "Sprache", logout: "Abmelden", "account.as": "Angemeldet als {user}", "account.demo": "Demo-Modus, ohne Anmeldung",
    "lang.auto": "Automatisch", "lang.de": "Deutsch", "lang.en": "English",
    "theme.system": "Standard", "theme.system.desc": "folgt hell/dunkel",
    "theme.omarchy": "Omarchy", "theme.omarchy.desc": "Kokemusu, Monospace", "theme.omarchy.pc": "{name}, vom PC",
    "theme.aurora": "Aurora", "theme.aurora.desc": "dunkel, Glas",
    "theme.klar": "Klar", "theme.klar.desc": "hell, weich",
    "theme.papier": "Papier", "theme.papier.desc": "hell, ruhig, wie gedruckt",
    "theme.nacht": "Nacht", "theme.nacht.desc": "schwarz, rot gedimmt",
    "theme.bento": "Bento", "theme.bento.desc": "bunt, große Kacheln",
    "layout.standard": "Standard", "layout.standard.desc": "alle Geräte nach Raum",
    "layout.uebersicht": "Übersicht", "layout.uebersicht.desc": "Info-Block oben, animiert",
    "layout.raeume": "Räume", "layout.raeume.desc": "Raumkarten, ein Tipp je Raum",
    "layout.grundriss": "Grundriss", "layout.grundriss.desc": "isometrisch, Räume leuchten",
    "zone.all": "Alle", "zone.all.title": "Alle Geräte der Zone, auch Sensoren und Taster",
    "zone.split": "Einzeln", "zone.split.title": "Lampengruppen als einzelne Lampen",
    "zones.all": "Alle Räume",
    "dev.on": "An", "dev.off": "Aus", "dev.onLower": "an", "dev.offLower": "aus", "dev.groupOn": "{on}/{n} an",
    "dev.target": "Ziel {v} °C", "dev.humidity": "{v} % Feuchte", "dev.motion": "Bewegung", "dev.still": "ruhig",
    "dev.open": "offen", "dev.closed": "zu", "dev.battery": "Batterie {v} %", "dev.unavailable": "nicht erreichbar",
    "dev.dim": "{name} dimmen",
    "thermo.heating": "heizt", "thermo.off": "aus", "thermo.ctrlOff": "Regelung aus", "thermo.ctrlOn": "Regelung an",
    "thermo.colder": "{name}: 0,5 Grad kälter", "thermo.warmer": "{name}: 0,5 Grad wärmer",
    "room.empty": "Nichts zu bedienen. „Alle“ zeigt Sensoren und Taster.", "room.noMatch": "Keine Geräte für diesen Filter.",
    "room.lightsOn": "{on}/{n} Lichter an", "room.devices": "{n} Geräte", "room.none": "Kein Raum passt.",
    "room.switchAll": "{room}: alle Lichter {state}", "room.litCount": ", {n} Lichter an",
    "room.lightOff": "Licht aus", "room.lightOn": "Licht an", "room.allOff": "Alle Lichter im Raum aus", "room.allOn": "Alle Lichter im Raum an",
    "power.none": "Gerade kein Verbrauch gemeldet.",
    "sum.allOff": "alle {n} aus", "sum.range": "{lo}–{hi} °C in {n} Räumen", "sum.quiet": "überall ruhig",
    "sum.offline": "{n} nicht erreichbar", "sum.lowBattery": "{n} Batterie schwach",
    "status.offline": "keine Verbindung",
    "toast.lightsFailed": "{n} Licht(er) haben nicht reagiert", "toast.groupFailed": "{n} Lampe(n) haben nicht reagiert",
    "toast.notSaved": "Nicht gespeichert: {msg}",
    // Fehler des Gateways (code aus der Antwort)
    "err.not_logged_in": "nicht angemeldet", "err.login_failed": "Benutzer oder Passwort falsch",
    "err.locked": "zu viele Fehlversuche, später erneut", "err.foreign_origin": "fremde Herkunft",
    "err.homey_unreachable": "Homey nicht erreichbar", "err.homey_failed": "Homey hat abgelehnt oder ist nicht erreichbar",
    "err.bad_request": "ungültige Anfrage", "err.not_found": "nicht gefunden", "err.no_floorplan": "kein Grundriss hinterlegt",
    "err.cap_denied": "Fähigkeit nicht freigegeben", "err.unknown_device": "Gerät oder Fähigkeit unbekannt",
    "err.not_allowed": "Gerät ist nicht zum Schalten freigegeben", "err.need_bool": "Wert muss true/false sein",
    "err.need_number": "Wert muss eine Zahl sein", "err.unknown_room": "Raum unbekannt", "err.unknown_group": "Gruppe unbekannt",
    "err.group_unreachable": "Kein Mitglied erreichbar", "err.flow_not_favorite": "Flow ist kein Favorit",
    "err.bad_setting": "unbekannter Wert", "err.nothing_to_save": "nichts zu speichern",
  },
  en: {
    locale: "en-GB",
    title: "Home",
    "login.user": "User", "login.password": "Password", "login.submit": "Sign in",
    search: "Search", "search.label": "Search devices", view: "View", theme: "Theme", settings: "Settings",
    "filter.label": "Filter", "cat.light": "Light", "cat.temperature": "Temperature", "cat.power": "Power",
    "nav.rooms": "Rooms", "sum.label": "Overview", "sum.lightsOn": "Lights on", "sum.inside": "Inside",
    "sum.outside": "Outside", "sum.power": "House now", "sum.motion": "Motion",
    "plan.label": "Floor plan", "plan.turn": "Rotate floor plan left", "plan.turnShort": "Rotate left",
    "plan.svg": "Isometric floor plan", "plan.empty": "No floor plan configured.",
    "sec.heat": "Heating", "sec.favs": "Favourites", "sec.flows": "Flows", "sec.rooms": "Rooms", "sec.power": "Power now",
    "nav.sections": "Sections", close: "Close", "settings.layout": "View", "settings.account": "Account",
    "settings.lang": "Language", logout: "Sign out", "account.as": "Signed in as {user}", "account.demo": "Demo mode, no sign-in",
    "lang.auto": "Automatic", "lang.de": "Deutsch", "lang.en": "English",
    "theme.system": "Default", "theme.system.desc": "follows light/dark",
    "theme.omarchy": "Omarchy", "theme.omarchy.desc": "Kokemusu, monospace", "theme.omarchy.pc": "{name}, from your PC",
    "theme.aurora": "Aurora", "theme.aurora.desc": "dark, glass",
    "theme.klar": "Clear", "theme.klar.desc": "light, soft",
    "theme.papier": "Paper", "theme.papier.desc": "light, calm, like print",
    "theme.nacht": "Night", "theme.nacht.desc": "black, dimmed red",
    "theme.bento": "Bento", "theme.bento.desc": "colourful, big tiles",
    "layout.standard": "Standard", "layout.standard.desc": "all devices by room",
    "layout.uebersicht": "Overview", "layout.uebersicht.desc": "info block on top, animated",
    "layout.raeume": "Rooms", "layout.raeume.desc": "room cards, one tap per room",
    "layout.grundriss": "Floor plan", "layout.grundriss.desc": "isometric, rooms light up",
    "zone.all": "All", "zone.all.title": "All devices in this zone, including sensors and buttons",
    "zone.split": "Single", "zone.split.title": "Show lamp groups as single lamps",
    "zones.all": "All rooms",
    "dev.on": "On", "dev.off": "Off", "dev.onLower": "on", "dev.offLower": "off", "dev.groupOn": "{on}/{n} on",
    "dev.target": "Target {v} °C", "dev.humidity": "{v} % humidity", "dev.motion": "motion", "dev.still": "still",
    "dev.open": "open", "dev.closed": "closed", "dev.battery": "Battery {v} %", "dev.unavailable": "unavailable",
    "dev.dim": "Dim {name}",
    "thermo.heating": "heating", "thermo.off": "off", "thermo.ctrlOff": "Control off", "thermo.ctrlOn": "Control on",
    "thermo.colder": "{name}: 0.5 degrees colder", "thermo.warmer": "{name}: 0.5 degrees warmer",
    "room.empty": "Nothing to control. “All” shows sensors and buttons.", "room.noMatch": "No devices match this filter.",
    "room.lightsOn": "{on}/{n} lights on", "room.devices": "{n} devices", "room.none": "No room matches.",
    "room.switchAll": "{room}: all lights {state}", "room.litCount": ", {n} lights on",
    "room.lightOff": "Lights off", "room.lightOn": "Lights on", "room.allOff": "All lights in this room off", "room.allOn": "All lights in this room on",
    "power.none": "No consumption reported right now.",
    "sum.allOff": "all {n} off", "sum.range": "{lo}–{hi} °C in {n} rooms", "sum.quiet": "quiet everywhere",
    "sum.offline": "{n} unavailable", "sum.lowBattery": "{n} low battery",
    "status.offline": "no connection",
    "toast.lightsFailed": "{n} light(s) did not respond", "toast.groupFailed": "{n} lamp(s) did not respond",
    "toast.notSaved": "Not saved: {msg}",
    "err.not_logged_in": "not signed in", "err.login_failed": "Wrong user or password",
    "err.locked": "too many failed attempts, try again later", "err.foreign_origin": "foreign origin",
    "err.homey_unreachable": "Homey unreachable", "err.homey_failed": "Homey refused or is unreachable",
    "err.bad_request": "invalid request", "err.not_found": "not found", "err.no_floorplan": "no floor plan configured",
    "err.cap_denied": "capability not allowed", "err.unknown_device": "unknown device or capability",
    "err.not_allowed": "device is not allowed to be switched", "err.need_bool": "value must be true/false",
    "err.need_number": "value must be a number", "err.unknown_room": "unknown room", "err.unknown_group": "unknown group",
    "err.group_unreachable": "no member reachable", "err.flow_not_favorite": "flow is not a favourite",
    "err.bad_setting": "unknown value", "err.nothing_to_save": "nothing to save",
  },
};

function pickLang(setting) {
  const url = new URLSearchParams(location.search).get("lang");
  if (LANGS.includes(url)) return url;
  if (LANGS.includes(setting)) return setting;
  for (const l of navigator.languages || [navigator.language || "en"]) {
    const short = String(l).slice(0, 2).toLowerCase();
    if (LANGS.includes(short)) return short;
  }
  return "en";
}

let LANG = "en";

function t(key, vars = {}) {
  const text = (I18N[LANG] && I18N[LANG][key]) ?? I18N.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

// Statische Texte: data-i18n="schluessel" (Inhalt), data-i18n-attr="aria-label:schluessel;placeholder:schluessel"
function translatePage() {
  document.documentElement.lang = LANG;
  document.title = t("title");
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of node.dataset.i18nAttr.split(";")) {
      const [attr, key] = pair.split(":");
      node.setAttribute(attr, t(key));
    }
  }
}

function setLang(setting) {
  LANG = pickLang(setting);
  translatePage();
}

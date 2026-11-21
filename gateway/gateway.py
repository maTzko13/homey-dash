#!/usr/bin/env python3
"""homey-dash Gateway: haelt den Homey-Key und reicht nur eine Whitelist weiter.

Nur Python-Standardbibliothek. Daten unter $HOMEY_DASH_DATA (Default /data):
  apikey        Homey-API-Key (scoped), chmod 600
  users.json    Dashboard-Konten (PBKDF2-Hash, Homey-Benutzer fuer Favoriten)
  tokens.json   Plugin-Tokens (nur SHA-256)
  allow.json    Liste von Geraete-IDs, die zusaetzlich zu Lichtern schaltbar sind
  settings.json Einstellungen je Konto (Theme)
  omarchy.json  Omarchy-Farben je Konto, gemeldet vom Plugin
  floorplan.json Raum-Polygone der Wohnung (nur angemeldet, bewusst nicht im Repo)
  groups.json   Lampengruppen [{"id", "name", "members": [Geraete-IDs]}], z. B. Deckenspots
  order.json    Reihenfolge der Raeume im Dashboard, Liste von Zonennamen (ohne fuehrende Nummer)
  sessions.json Sitzungen (nur SHA-256 der Cookie-Werte)
  config.json   Einstellungen der Installation (siehe CONFIG_DEFAULTS); Umgebungsvariablen gehen vor

Aufruf:
  gateway.py serve
  gateway.py demo                                 erfundene Wohnung, ohne Homey und ohne Anmeldung
  gateway.py adduser <name> [--homey-user <id>]   Passwort per Eingabe
  gateway.py token <name> <konto>                 gibt den Token EINMAL aus
  gateway.py revoke <name>
"""

import getpass
import hashlib
import hmac
import http.client
import ipaddress
import json
import mimetypes
import os
import secrets
import socket
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DATA = Path(os.environ.get("HOMEY_DASH_DATA", "/data"))
WEB = Path(os.environ.get("HOMEY_DASH_WEB", Path(__file__).resolve().parent.parent / "web"))
DEMO = os.environ.get("HOMEY_DASH_DEMO") == "1" or sys.argv[1:2] == ["demo"]

# Einstellungen der Installation: data/config.json, jeder Schluessel auch als Umgebungsvariable
# HOMEY_DASH_<SCHLUESSEL> (z. B. HOMEY_DASH_HOMEY_ADDRESS=192.168.1.20).
CONFIG_DEFAULTS = {
    # IP des Homey Pro (2023): HTTPS an diese IP, Zertifikat auf <ip-mit-strichen>.homey.homeylocal.com
    # geprueft. So stoert kein DNS-Rebind-Schutz (Pi-hole, AdGuard), der den homeylocal-Namen sperrt.
    "homey_address": "",
    # Statt homey_address eine volle Basis-URL, z. B. http://192.168.1.20 fuer Homey Pro (2016-2019)
    "homey_url": "",
    # Anmeldung ohne HTTPS erlauben (Cookie ohne Secure). Nur im eigenen Netz ohne Proxy.
    "allow_http": False,
    # Nur Anfragen aus diesen Netzen duerfen X-Forwarded-For setzen (Reverse Proxy)
    "trusted_proxies": ["172.16.0.0/12", "127.0.0.0/8", "::1/128"],
    "listen": "0.0.0.0",
    "port": 8080,
    "session_days": 90,
    # Uebersicht: Geraet fuer "Draussen" (ID), sonst das erste mit Wetter/Aussen im Namen
    "outdoor_device": "",
    # Uebersicht: Geraete, deren Leistung "Haus jetzt" ergibt (IDs, z. B. die Phasen eines Zaehlers),
    # sonst alle Leistungsmesser in einer Zone, deren Name power_zone (regulaerer Ausdruck) trifft
    "power_devices": [],
    "power_zone": "verteiler|zähler|zaehler|meter|fuse|electric",
}


def _config():
    try:
        conf = json.loads((DATA / "config.json").read_text())
    except FileNotFoundError:
        conf = {}
    out = {}
    for key, default in CONFIG_DEFAULTS.items():
        env = os.environ.get(f"HOMEY_DASH_{key.upper()}")
        if env is None:
            out[key] = conf.get(key, default)
        elif isinstance(default, bool):
            out[key] = env.lower() in ("1", "true", "yes", "on")
        elif isinstance(default, int):
            out[key] = int(env)
        elif isinstance(default, list):
            out[key] = [v.strip() for v in env.split(",") if v.strip()]
        else:
            out[key] = env
    # Fruehere Namen der Variablen, damit bestehende Container weiterlaufen
    if not out["homey_address"] and os.environ.get("HOMEY_IP"):
        out["homey_address"] = os.environ["HOMEY_IP"]
    if os.environ.get("PORT"):
        out["port"] = int(os.environ["PORT"])
    if os.environ.get("LISTEN"):
        out["listen"] = os.environ["LISTEN"]
    return out


CONFIG = _config()
if DEMO:
    import demo_data as demo
    CONFIG["allow_http"] = True  # Demo laeuft meist lokal ohne HTTPS
LISTEN = CONFIG["listen"]
PORT = int(CONFIG["port"])
CACHE_SECONDS = 3
SESSION_DAYS = int(CONFIG["session_days"])
COOKIE = "hd_session"
TRUSTED_PROXIES = [ipaddress.ip_network(n) for n in CONFIG["trusted_proxies"]]

# Was ein Geraet nach aussen zeigt. Alles andere (Settings, Notizen, Treiber) bleibt drin.
SHOWN_CAPS = {
    "onoff", "dim", "light_temperature", "target_temperature",
    "measure_temperature", "measure_humidity", "measure_power", "meter_power",
    "measure_battery", "alarm_motion", "alarm_contact", "measure_luminance",
    "windowcoverings_state", "windowcoverings_set",
    "vt_onoff",  # Ausgang des virtuellen Thermostats: heizt gerade (nur lesen)
}
# Was das Gateway schalten darf: Lichter onoff/dim, Thermostate (eigene Freigabe "heat") Ziel und Regelung an/aus
WRITABLE = {"onoff", "dim"}
HEAT_WRITABLE = {"onoff", "target_temperature"}
TARGET_RANGE = (15.0, 25.0)  # enger als Homey (4-35): ein Fehlklick soll nicht 30 Grad einstellen
# Schalten nur fuer Licht. Steckdosen tragen Server, Kuehlschrank, Waschmaschine,
# Bewaesserung und den Dauerstrom der Bad-Spots: die nur per data/allow.json freigeben.
CONTROL_CLASSES = {"light"}
CAP_FIELDS = ("value", "title", "units", "type", "setable", "min", "max", "step", "decimals", "lastUpdated")


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------- Speicher

_lock = threading.Lock()


def load(name, default):
    try:
        return json.loads((DATA / name).read_text())
    except FileNotFoundError:
        if DEMO:
            sample = demo.file(name)
            if sample is not None:
                return sample
        return default


def save(name, obj):
    path = DATA / name
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(obj, fh, indent=1)
    os.replace(tmp, path)


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def hash_password(pw, salt=None, rounds=600_000):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), rounds).hex()
    return f"pbkdf2${rounds}${salt}${digest}"


def check_password(pw, stored):
    _, rounds, salt, _ = stored.split("$")
    return hmac.compare_digest(hash_password(pw, salt, int(rounds)), stored)


# ---------------------------------------------------------------- Homey

class HomeyError(Exception):
    pass


def homey_target():
    """(Beschreibung, Verbindungsfabrik) aus homey_url oder homey_address."""
    url = CONFIG["homey_url"].rstrip("/")
    if url:
        scheme, _, host = url.partition("://")
        if scheme not in ("http", "https") or not host or "/" in host:
            sys.exit("homey_url muss http(s)://host[:port] sein")
        cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        return url, lambda: cls(host, timeout=10)
    addr = CONFIG["homey_address"]
    try:
        ip = ipaddress.IPv4Address(addr)
    except ValueError:
        sys.exit("homey_address (IPv4 des Homey) oder homey_url fehlt, siehe README")
    name = f"{str(ip).replace('.', '-')}.homey.homeylocal.com"

    def connect():
        ctx = ssl.create_default_context()
        conn = http.client.HTTPSConnection(name, 443, timeout=10, context=ctx)
        conn.sock = ctx.wrap_socket(socket.create_connection((str(ip), 443), timeout=10), server_hostname=name)
        return conn
    return f"https://{name} via {ip}", connect


def homey_request(method, path, body=None):
    """Ein Aufruf der lokalen Homey-API mit dem Key aus data/apikey."""
    if DEMO:
        return demo.request(method, path, body)
    key = (DATA / "apikey").read_text().strip()
    conn = homey_target()[1]()
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    if payload:
        headers["Content-Type"] = "application/json"
    try:
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
    finally:
        conn.close()
    if resp.status >= 400:
        raise HomeyError(f"{method} {path} -> {resp.status}")
    return json.loads(raw) if raw else None


_cache = {"ts": 0, "raw": None}


def homey_raw():
    with _lock:
        if _cache["raw"] and time.time() - _cache["ts"] < CACHE_SECONDS:
            return _cache["raw"]
    raw = {
        "zones": homey_request("GET", "/api/manager/zones/zone"),
        "devices": homey_request("GET", "/api/manager/devices/device"),
        "flows": homey_request("GET", "/api/manager/flow/flow"),
        "aflows": homey_request("GET", "/api/manager/flow/advancedflow"),
        "users": homey_request("GET", "/api/manager/users/user"),
    }
    with _lock:
        _cache.update(ts=time.time(), raw=raw)
    return raw


def categories(dev):
    caps = set(dev.get("capabilities", []))
    cats = []
    if dev.get("class") == "light" or dev.get("virtualClass") == "light":
        cats.append("light")
    if caps & {"measure_temperature", "target_temperature"} or dev.get("class") == "thermostat":
        cats.append("temperature")
    if caps & {"measure_power", "meter_power"}:
        cats.append("power")
    return cats


def allowed_ids():
    return set(load("allow.json", []))


def state_for(account):
    raw = homey_raw()
    extra = allowed_ids()
    zones = [
        {k: z.get(k) for k in ("id", "name", "parent", "icon", "active", "sortIndex")}
        for z in raw["zones"].values()
    ]
    devices = []
    for d in raw["devices"].values():
        if d.get("hidden"):
            continue
        caps = {
            cid: {f: c.get(f) for f in CAP_FIELDS if c.get(f) is not None}
            for cid, c in (d.get("capabilitiesObj") or {}).items()
            if cid in SHOWN_CAPS
        }
        devices.append({
            "id": d["id"], "name": d["name"], "zone": d.get("zone"),
            "class": d.get("virtualClass") or d.get("class"),
            "cats": categories(d), "available": d.get("available", True), "caps": caps,
            "control": (d.get("virtualClass") or d.get("class")) in CONTROL_CLASSES or d["id"] in extra,
            # Thermostat mit setzbarer Zieltemperatur (nicht der Feuchte-Thermostat); Heizungs-Steckdosen bleiben gesperrt
            "heat": (d.get("virtualClass") or d.get("class")) == "thermostat" and bool(caps.get("target_temperature", {}).get("setable")),
        })
    # Favoriten des zugeordneten Homey-Kontos; vom Benutzerobjekt geht nichts sonst hinaus (inviteUrl!).
    props = {}
    homey_user = account.get("homey_user")
    for u in raw["users"].values():
        if (homey_user and u["id"] == homey_user) or (not homey_user and u.get("role") == "owner"):
            props = u.get("properties") or {}
    all_flows = {**{k: ("flow", v) for k, v in raw["flows"].items()},
                 **{k: ("advancedflow", v) for k, v in raw["aflows"].items()}}
    flows = [
        {"id": fid, "name": all_flows[fid][1]["name"].strip(), "kind": all_flows[fid][0],
         "enabled": all_flows[fid][1].get("enabled", True)}
        for fid in props.get("favoriteFlows", [])
        if fid in all_flows and all_flows[fid][1].get("triggerable")
    ]
    known = {d["id"] for d in devices}
    # Gruppen nur aus schaltbaren Lichtern; Zone = Zone des ersten Mitglieds
    by_id = {d["id"]: d for d in devices}
    groups = []
    for grp in load("groups.json", []):
        members = [i for i in grp.get("members", []) if i in by_id and by_id[i]["control"]]
        if len(members) > 1:
            groups.append({"id": str(grp["id"]), "name": str(grp["name"]), "zone": by_id[members[0]]["zone"], "members": members})
    return {
        "zones": zones, "devices": devices, "flows": flows, "groups": groups,
        "zoneOrder": [str(n) for n in load("order.json", [])],
        "summary": {"outdoor": CONFIG["outdoor_device"] or None, "power": [i for i in CONFIG["power_devices"] if i in known],
                    "powerZone": CONFIG["power_zone"]},
        "demo": DEMO,
        "favoriteDevices": [i for i in props.get("favoriteDevices", []) if i in known],
        "ts": int(_cache["ts"] * 1000),
    }


class Refused(Exception):
    """Abgelehnt; code ist der Schluessel err.<code> in web/i18n.js, die Meldung nur fuer Log und Altclients."""

    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


# ---------------------------------------------------------------- Einstellungen

THEMES = {"system", "omarchy", "aurora", "klar", "papier", "nacht", "bento"}
LAYOUTS = {"standard", "uebersicht", "raeume", "grundriss"}
LANGS = {"auto", "de", "en"}
OMARCHY_KEYS = {
    "accent", "background", "dark_background", "darker_background", "lighter_background",
    "foreground", "dark_foreground", "light_foreground", "bright_foreground", "muted",
    "red", "green", "yellow", "orange", "blue", "cyan", "magenta",
}


def is_hex(value):
    return isinstance(value, str) and len(value) == 7 and value[0] == "#" and all(c in "0123456789abcdefABCDEF" for c in value[1:])


def settings_for(account):
    entry = load("settings.json", {}).get(account["name"], {})
    theme = load("omarchy.json", {}).get(account["name"])
    return {"theme": entry.get("theme", "system"), "layout": entry.get("layout", "standard"), "lang": entry.get("lang", "auto"),
            "omarchy": theme["name"] if theme else None}


def save_settings(account, data):
    """Nur die mitgeschickten Schluessel aendern; jeder muss aus seiner Liste stammen."""
    changes = {}
    for key, allowed in (("theme", THEMES), ("layout", LAYOUTS), ("lang", LANGS)):
        if key in data:
            if data[key] not in allowed:
                raise Refused("bad_setting", f"unbekannter Wert für {key}")
            changes[key] = data[key]
    if not changes:
        raise Refused("nothing_to_save", "nichts zu speichern")
    with _lock:
        all_settings = load("settings.json", {})
        all_settings.setdefault(account["name"], {}).update(changes)
        save("settings.json", all_settings)


def save_omarchy(account, data):
    """Farben aus colors.toml des Omarchy-Themes; nur bekannte Schluessel mit #rrggbb."""
    colors = data.get("colors")
    name = data.get("name")
    if not isinstance(colors, dict) or not isinstance(name, str) or not (0 < len(name) <= 40) \
            or not all(c.isalnum() or c in " -_." for c in name):
        raise Refused("bad_request", "Theme-Name oder Farben fehlen")
    clean = {k: v.lower() for k, v in colors.items() if k in OMARCHY_KEYS and is_hex(v)}
    if not {"accent", "background", "foreground"} <= clean.keys():
        raise Refused("bad_request", "accent, background und foreground sind Pflicht")
    mode = "light" if data.get("mode") == "light" else "dark"
    with _lock:
        themes = load("omarchy.json", {})
        themes[account["name"]] = {"name": name, "mode": mode, "colors": clean, "updated": time.strftime("%Y-%m-%d %H:%M")}
        save("omarchy.json", themes)
    log(f"{account['name']}: Omarchy-Theme {name} gemeldet")


def omarchy_css(account):
    theme = load("omarchy.json", {}).get(account["name"]) if account else None
    if not theme:
        return "/* kein Omarchy-Theme gemeldet, es gilt Kokemusu aus style.css */\n"
    c = theme["colors"]
    bg, fg = c["background"], c["foreground"]
    card = c.get("lighter_background", bg)
    tokens = {
        "--page": bg, "--bar": bg, "--fg": fg,
        "--muted": c.get("dark_foreground", c.get("muted", fg)),
        "--card": card, "--card-on": card,
        "--line": f"color-mix(in srgb, {fg} 18%, {bg})",
        "--accent": c["accent"], "--accent-fg": c.get("darker_background", bg), "--on": c["accent"],
        "--error": c.get("red", c["accent"]), "--ok": c.get("green", c["accent"]),
        "color-scheme": theme["mode"],
    }
    body = "".join(f"  {k}: {v};\n" for k, v in tokens.items())
    return f"/* Omarchy-Theme {theme['name']}, gemeldet {theme['updated']} */\n:root[data-theme=\"omarchy\"] {{\n{body}}}\n"


def set_capability(account, dev_id, cap, value, state=None):
    """Lichter: WRITABLE; Thermostate: HEAT_WRITABLE. Wert nach Typ geprueft."""
    if cap not in WRITABLE | HEAT_WRITABLE:
        raise Refused("cap_denied", "Fähigkeit nicht freigegeben")
    dev = next((d for d in (state or state_for(account))["devices"] if d["id"] == dev_id), None)
    if not dev or cap not in dev["caps"] or not dev["caps"][cap].get("setable"):
        raise Refused("unknown_device", "Gerät oder Fähigkeit unbekannt")
    if not ((dev["control"] and cap in WRITABLE) or (dev["heat"] and cap in HEAT_WRITABLE)):
        raise Refused("not_allowed", "Gerät ist nicht zum Schalten freigegeben")
    if cap == "onoff":
        if not isinstance(value, bool):
            raise Refused("need_bool", "Wert muss true/false sein")
    elif cap == "target_temperature":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Refused("need_number", "Wert muss eine Zahl sein")
        value = round(min(max(float(value), TARGET_RANGE[0]), TARGET_RANGE[1]) * 2) / 2
    else:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Refused("need_number", "Wert muss eine Zahl sein")
        lo, hi = dev["caps"][cap].get("min", 0), dev["caps"][cap].get("max", 1)
        value = min(max(float(value), lo), hi)
    homey_request("PUT", f"/api/manager/devices/device/{dev_id}/capability/{cap}", {"value": value})
    _cache["ts"] = 0
    log(f"{account['name']}: {dev['name']} {cap}={value}")


def set_zone_lights(account, zone_id, value):
    """Alle schaltbaren Lichter eines Raums samt Unterzonen an oder aus."""
    if not isinstance(value, bool):
        raise Refused("need_bool", "Wert muss true/false sein")
    state = state_for(account)
    if zone_id not in {z["id"] for z in state["zones"]}:
        raise Refused("unknown_room", "Raum unbekannt")
    ids, grown = {zone_id}, True
    while grown:
        more = {z["id"] for z in state["zones"] if z["parent"] in ids} - ids
        ids |= more
        grown = bool(more)
    targets = [d for d in state["devices"] if d["zone"] in ids and d["control"] and d["available"]
               and d["caps"].get("onoff", {}).get("setable") and d["caps"]["onoff"].get("value") != value]
    failed = 0
    for dev in targets:
        try:
            homey_request("PUT", f"/api/manager/devices/device/{dev['id']}/capability/onoff", {"value": value})
        except (HomeyError, OSError):
            failed += 1
    _cache["ts"] = 0
    log(f"{account['name']}: Raum {zone_id} Licht={value}, {len(targets) - failed} geschaltet, {failed} Fehler")
    return {"switched": len(targets) - failed, "failed": failed}


def set_group(account, group_id, cap, value):
    """Eine Faehigkeit fuer alle erreichbaren Mitglieder einer Lampengruppe; Pruefung wie set_capability."""
    state = state_for(account)
    grp = next((g for g in state["groups"] if g["id"] == group_id), None)
    if not grp:
        raise Refused("unknown_group", "Gruppe unbekannt")
    members = [d for d in state["devices"] if d["id"] in grp["members"] and d["available"]
               and d["caps"].get(cap, {}).get("setable")]
    if not members:
        raise Refused("group_unreachable", "Kein Mitglied erreichbar")
    failed = 0
    for dev in members:
        try:
            set_capability(account, dev["id"], cap, value, state)
        except (HomeyError, OSError):
            failed += 1
    return {"switched": len(members) - failed, "failed": failed}


def trigger_flow(account, flow_id):
    """Nur Lieblings-Flows des Kontos, die einen Start-Ausloeser haben."""
    flow = next((f for f in state_for(account)["flows"] if f["id"] == flow_id), None)
    if not flow:
        raise Refused("flow_not_favorite", "Flow ist kein Favorit")
    homey_request("POST", f"/api/manager/flow/{flow['kind']}/{flow_id}/trigger", {})
    _cache["ts"] = 0
    log(f"{account['name']}: Flow {flow['name']} gestartet")


# ---------------------------------------------------------------- HTTP

_fails = {}  # ip -> [anzahl, gesperrt_bis]
MAX_FAILS, LOCK_SECONDS = 5, 900


class Handler(BaseHTTPRequestHandler):
    server_version = "homey-dash"
    sys_version = ""

    def log_message(self, fmt, *args):
        log(f"{self.client_ip()} {fmt % args}")

    def client_ip(self):
        peer = self.client_address[0]
        try:
            trusted = any(ipaddress.ip_address(peer) in n for n in TRUSTED_PROXIES)
        except ValueError:
            trusted = False
        fwd = self.headers.get("X-Forwarded-For")
        return fwd.split(",")[0].strip() if trusted and fwd else peer

    # -- Antworten

    def security_headers(self):
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")

    def send_error_json(self, status, code, msg, cookie=None):
        self.send_json(status, {"error": msg, "code": code}, cookie)

    def send_json(self, status, obj, cookie=None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, rel):
        base = WEB.resolve()
        path = (base / rel).resolve()
        if base not in path.parents or not path.is_file():
            return self.send_error_json(404, "not_found", "not found")
        body = path.read_bytes()
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith("javascript") else ""))
        self.send_header("Content-Length", str(len(body)))
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    # -- Anmeldung

    def account(self):
        """Konto aus Plugin-Token oder Sitzungs-Cookie, sonst None. Im Demo-Modus immer das Konto demo."""
        if DEMO:
            return {"name": "demo", "homey_user": None}
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            entry = load("tokens.json", {}).get(sha(auth[7:].strip()))
            acc = load("users.json", {}).get(entry["user"]) if entry else None
            return dict(acc, name=entry["user"]) if acc else None
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE and value:
                sess = load("sessions.json", {}).get(sha(value))
                if sess and sess["expires"] > time.time():
                    acc = load("users.json", {}).get(sess["user"])
                    return dict(acc, name=sess["user"]) if acc else None
        return None

    def same_origin(self):
        """Schreibende Anfragen nur mit eigenem Header und passender Origin (CSRF)."""
        if self.headers.get("X-Homey-Dash") != "1":
            return False
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        return origin is None or origin == f"https://{host}" or (CONFIG["allow_http"] and origin == f"http://{host}")

    def cookie(self, value, max_age):
        secure = "" if CONFIG["allow_http"] else " Secure;"
        return f"{COOKIE}={value}; Path=/; Max-Age={max_age}; HttpOnly;{secure} SameSite=Strict"

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 10_000:
            raise ValueError("zu gross")
        return json.loads(self.rfile.read(length) or b"{}")

    def login(self):
        ip = self.client_ip()
        count, until = _fails.get(ip, [0, 0])
        if until > time.time():
            return self.send_error_json(429, "locked", "zu viele Fehlversuche, später erneut")
        data = self.read_body()
        user = str(data.get("user", ""))
        acc = load("users.json", {}).get(user)
        if not acc or not check_password(str(data.get("password", "")), acc["password"]):
            count += 1
            _fails[ip] = [0, time.time() + LOCK_SECONDS] if count >= MAX_FAILS else [count, 0]
            log(f"{ip} Anmeldung fehlgeschlagen fuer {user!r} ({count})")
            return self.send_error_json(401, "login_failed", "Benutzer oder Passwort falsch")
        _fails.pop(ip, None)
        token = secrets.token_urlsafe(32)
        with _lock:
            sessions = {k: v for k, v in load("sessions.json", {}).items() if v["expires"] > time.time()}
            sessions[sha(token)] = {"user": user, "expires": time.time() + SESSION_DAYS * 86400}
            save("sessions.json", sessions)
        log(f"{ip} angemeldet: {user}")
        self.send_json(200, {"user": user}, self.cookie(token, SESSION_DAYS * 86400))

    def logout(self):
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE and value:
                with _lock:
                    sessions = load("sessions.json", {})
                    sessions.pop(sha(value), None)
                    save("sessions.json", sessions)
        self.send_json(200, {}, self.cookie("", 0))

    # -- Routen

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/healthz":
            return self.send_json(200, {"ok": True})
        if path == "/omarchy.css":
            # Ohne Anmeldung leer statt 401, damit die Anmeldeseite ohne Fehler laedt
            body = omarchy_css(self.account()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/css; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.security_headers()
            self.end_headers()
            return self.wfile.write(body)
        if path.startswith("/api/"):
            acc = self.account()
            if not acc:
                return self.send_error_json(401, "not_logged_in", "nicht angemeldet")
            if path == "/api/me":
                return self.send_json(200, {"user": acc.get("name"), "settings": settings_for(acc)})
            if path == "/api/floorplan":
                plan = load("floorplan.json", None)
                return self.send_json(200, plan) if plan else self.send_error_json(404, "no_floorplan", "kein Grundriss hinterlegt")
            if path == "/api/state":
                try:
                    return self.send_json(200, state_for(acc))
                except (HomeyError, OSError) as exc:
                    log(f"Homey nicht erreichbar: {exc}")
                    return self.send_error_json(502, "homey_unreachable", "Homey nicht erreichbar")
            return self.send_error_json(404, "not_found", "not found")
        return self.send_static("index.html" if path == "/" else path.lstrip("/"))

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self.same_origin():
            return self.send_error_json(403, "foreign_origin", "fremde Herkunft")
        try:
            if path == "/api/login":
                return self.login()
            if path == "/api/logout":
                return self.logout()
            acc = self.account()
            if not acc:
                return self.send_error_json(401, "not_logged_in", "nicht angemeldet")
            parts = path.strip("/").split("/")
            # /api/device/<id>/<capability>  {"value": ...}
            if len(parts) == 4 and parts[1] == "device":
                set_capability(acc, parts[2], parts[3], self.read_body().get("value"))
                return self.send_json(200, {"ok": True})
            if path == "/api/settings":
                save_settings(acc, self.read_body())
                return self.send_json(200, {"ok": True})
            if path == "/api/omarchy-theme":
                save_omarchy(acc, self.read_body())
                return self.send_json(200, {"ok": True})
            # /api/zone/<id>/lights  {"value": true|false}
            if len(parts) == 4 and parts[1] == "zone" and parts[3] == "lights":
                return self.send_json(200, set_zone_lights(acc, parts[2], self.read_body().get("value")))
            # /api/group/<id>/<capability>  {"value": ...}
            if len(parts) == 4 and parts[1] == "group":
                return self.send_json(200, set_group(acc, parts[2], parts[3], self.read_body().get("value")))
            # /api/flow/<id>/trigger
            if len(parts) == 4 and parts[1] == "flow" and parts[3] == "trigger":
                trigger_flow(acc, parts[2])
                return self.send_json(200, {"ok": True})
        except Refused as exc:
            return self.send_error_json(403, exc.code, str(exc))
        except (HomeyError, OSError) as exc:
            log(f"Homey-Fehler: {exc}")
            return self.send_error_json(502, "homey_failed", "Homey hat abgelehnt oder ist nicht erreichbar")
        except (ValueError, json.JSONDecodeError, AttributeError):
            return self.send_error_json(400, "bad_request", "ungültige Anfrage")
        self.send_error_json(404, "not_found", "not found")

    def do_HEAD(self):
        self.send_response(405)
        self.end_headers()


# ---------------------------------------------------------------- Verwaltung

def cmd_adduser(args):
    name = args[0]
    homey_user = args[args.index("--homey-user") + 1] if "--homey-user" in args else None
    pw = getpass.getpass(f"Passwort für {name}: ")
    if len(pw) < 12 or pw != getpass.getpass("Wiederholen: "):
        sys.exit("Passwort zu kurz (min. 12) oder ungleich")
    users = load("users.json", {})
    users[name] = {"password": hash_password(pw), "homey_user": homey_user}
    save("users.json", users)
    print(f"Konto {name} gespeichert")


def cmd_token(args):
    name, user = args
    if user not in load("users.json", {}):
        sys.exit(f"Konto {user} gibt es nicht")
    token = secrets.token_urlsafe(32)
    tokens = {k: v for k, v in load("tokens.json", {}).items() if v["name"] != name}
    tokens[sha(token)] = {"name": name, "user": user, "created": time.strftime("%Y-%m-%d")}
    save("tokens.json", tokens)
    print(token)


def cmd_revoke(args):
    tokens = load("tokens.json", {})
    left = {k: v for k, v in tokens.items() if v["name"] != args[0]}
    save("tokens.json", left)
    print(f"{len(tokens) - len(left)} Token entfernt")


def main():
    cmd, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("serve", [])
    if cmd in ("serve", "demo"):
        if DEMO:
            DATA.mkdir(parents=True, exist_ok=True)
            target = "Demo-Daten (ohne Homey, ohne Anmeldung)"
        else:
            if not (DATA / "apikey").exists():
                sys.exit(f"{DATA}/apikey fehlt")
            target = homey_target()[0]
            if CONFIG["allow_http"]:
                log("allow_http ist an: Anmeldung auch ohne HTTPS")
        log(f"lausche auf {LISTEN}:{PORT}, Homey {target}")
        ThreadingHTTPServer((LISTEN, PORT), Handler).serve_forever()
    elif cmd == "adduser":
        cmd_adduser(args)
    elif cmd == "token":
        cmd_token(args)
    elif cmd == "revoke":
        cmd_revoke(args)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()

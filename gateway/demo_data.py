"""Erfundene Wohnung fuer den Demo-Modus (gateway.py demo / HOMEY_DASH_DEMO=1).

Ahmt die Antworten der lokalen Homey-API nach, die das Gateway liest, und nimmt Schaltbefehle
im Speicher an. Dazu Beispiele fuer floorplan.json, groups.json, order.json und allow.json.
Keine echten Geraete, Namen oder IDs.
"""

import copy
import os
import random
import threading
import time

# Sprache der Demo-Namen: HOMEY_DASH_DEMO_LANG=de|en (Vorgabe en)
EN = os.environ.get("HOMEY_DASH_DEMO_LANG", "en") != "de"


def L(de, en):
    return en if EN else de

_lock = threading.Lock()
_n = 0


def _id(prefix):
    global _n
    _n += 1
    return f"{prefix}-{_n:04d}-demo-0000-{_n:012d}"


ZONE_NAMES = [L("Wohnzimmer", "Living room"), L("Küche", "Kitchen"), L("Schlafzimmer", "Bedroom"), L("Kinderzimmer", "Kids room"), L("Bad", "Bathroom"), L("Flur", "Hallway"), L("Arbeitszimmer", "Office"), L("Balkon", "Balcony")]
ROOT = _id("zone")
ZONES = {ROOT: {"id": ROOT, "name": L("Zuhause", "Home"), "parent": None, "icon": "home", "active": True, "sortIndex": 0}}
Z = {}
for i, name in enumerate(ZONE_NAMES):
    zid = _id("zone")
    Z[name] = zid
    ZONES[zid] = {"id": zid, "name": name, "parent": ROOT, "icon": "default", "active": False, "sortIndex": i + 1}
Z[L("Zählerschrank", "Meter cabinet")] = _id("zone")
ZONES[Z[L("Zählerschrank", "Meter cabinet")]] = {"id": Z[L("Zählerschrank", "Meter cabinet")], "name": L("Zählerschrank", "Meter cabinet"), "parent": Z[L("Flur", "Hallway")], "icon": "default",
                             "active": False, "sortIndex": 0}

CAP_META = {
    "onoff": ("Eingeschaltet", None, "boolean", True),
    "dim": ("Helligkeit", "%", "number", True),
    "target_temperature": ("Zieltemperatur", "°C", "number", True),
    "measure_temperature": ("Temperatur", "°C", "number", False),
    "measure_humidity": ("Luftfeuchtigkeit", "%", "number", False),
    "measure_power": ("Leistung", "W", "number", False),
    "meter_power": ("Energie", "kWh", "number", False),
    "measure_battery": ("Batterie", "%", "number", False),
    "alarm_motion": ("Bewegung", None, "boolean", False),
    "alarm_contact": ("Kontakt", None, "boolean", False),
    "measure_luminance": ("Helligkeit", "lx", "number", False),
    "vt_onoff": ("Heizt", None, "boolean", False),
}

DEVICES = {}


def dev(name, zone, cls, available=True, **caps):
    did = _id("dev")
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    obj = {}
    for cap, value in caps.items():
        title, units, typ, setable = CAP_META[cap]
        c = {"value": value, "title": title, "type": typ, "setable": setable, "lastUpdated": now}
        if units:
            c["units"] = units
        if cap == "dim":
            c.update(min=0, max=1, step=0.01)
        if cap == "target_temperature":
            c.update(min=4, max=35, step=0.5)
        obj[cap] = c
    DEVICES[did] = {"id": did, "name": name, "zone": Z.get(zone, ROOT), "class": cls, "available": available,
                    "capabilities": list(caps), "capabilitiesObj": obj}
    return did


def light(name, zone, on=False, dim=None):
    return dev(name, zone, "light", onoff=on, **({} if dim is None else {"dim": dim}))


def thermostat(name, zone, target, ist, on=True, heating=False):
    return dev(name, zone, "thermostat", onoff=on, target_temperature=target, measure_temperature=ist, vt_onoff=heating)


# Wohnzimmer
spots = [light(f"Spot {i}", L("Wohnzimmer", "Living room"), True, 0.6) for i in range(1, 5)]
stehlampe = light(L("Stehlampe", "Floor lamp"), L("Wohnzimmer", "Living room"), True, 0.45)
thermostat(L("Thermostat", "Thermostat"), L("Wohnzimmer", "Living room"), 21.5, 21.1, heating=True)
tv = dev(L("Fernseher", "TV"), L("Wohnzimmer", "Living room"), "socket", onoff=True, measure_power=87.0, meter_power=212.4)
dev(L("Bewegungsmelder", "Motion sensor"), L("Wohnzimmer", "Living room"), "sensor", alarm_motion=True, measure_luminance=118, measure_temperature=21.3, measure_battery=78)
# Kueche
light(L("Arbeitsfläche", "Worktop"), L("Küche", "Kitchen"), True)
light(L("Hängelampe", "Pendant"), L("Küche", "Kitchen"), False, 0.0)
thermostat(L("Thermostat", "Thermostat"), L("Küche", "Kitchen"), 19.0, 19.6)
dev(L("Kühlschrank", "Fridge"), L("Küche", "Kitchen"), "socket", onoff=True, measure_power=64.0, meter_power=388.0)
dev(L("Bewegungsmelder", "Motion sensor"), L("Küche", "Kitchen"), "sensor", alarm_motion=False, measure_luminance=240, measure_battery=91)
# Schlafzimmer
light(L("Nachttisch links", "Bedside left"), L("Schlafzimmer", "Bedroom"), False, 0.0)
light(L("Nachttisch rechts", "Bedside right"), L("Schlafzimmer", "Bedroom"), False, 0.0)
light(L("Deckenlampe", "Ceiling light"), L("Schlafzimmer", "Bedroom"), False)
thermostat(L("Thermostat", "Thermostat"), L("Schlafzimmer", "Bedroom"), 18.0, 18.4)
dev(L("Fenster", "Window"), L("Schlafzimmer", "Bedroom"), "sensor", alarm_contact=False, measure_battery=14)
# Kinderzimmer
light(L("Nachtlicht", "Night light"), L("Kinderzimmer", "Kids room"), True, 0.2)
light(L("Deckenlampe", "Ceiling light"), L("Kinderzimmer", "Kids room"), False, 0.0)
thermostat(L("Thermostat", "Thermostat"), L("Kinderzimmer", "Kids room"), 20.0, 19.4, heating=True)
# Bad
bad = [light(f"Spot {i}", L("Bad", "Bathroom"), True, 1.0) for i in range(1, 4)]
light(L("Spiegel", "Mirror"), L("Bad", "Bathroom"), True)
thermostat(L("Thermostat", "Thermostat"), L("Bad", "Bathroom"), 22.0, 21.2, heating=True)
dev(L("Klima", "Climate"), L("Bad", "Bathroom"), "sensor", measure_temperature=22.0, measure_humidity=68, measure_battery=64)
dev(L("Bewegungsmelder", "Motion sensor"), L("Bad", "Bathroom"), "sensor", alarm_motion=True, measure_luminance=310, measure_battery=55)
# Flur
light(L("Flurlicht", "Hall light"), L("Flur", "Hallway"), True, 0.7)
dev(L("Bewegungsmelder", "Motion sensor"), L("Flur", "Hallway"), "sensor", alarm_motion=False, measure_luminance=40, measure_battery=88)
phases = [dev(f"Phase L{i}", L("Zählerschrank", "Meter cabinet"), "sensor", measure_power=p) for i, p in ((1, 312.0), (2, 226.0), (3, 181.0))]
# Arbeitszimmer
schreibtisch = light(L("Schreibtischlampe", "Desk lamp"), L("Arbeitszimmer", "Office"), True, 0.8)
thermostat(L("Thermostat", "Thermostat"), L("Arbeitszimmer", "Office"), 19.5, 17.9, on=False)
dev(L("Computer", "Computer"), L("Arbeitszimmer", "Office"), "socket", onoff=True, measure_power=142.0, meter_power=96.1)
dev(L("Drucker", "Printer"), L("Arbeitszimmer", "Office"), "socket", available=False, onoff=False, measure_power=0.0)
# Balkon
lichterkette = dev(L("Lichterkette", "Fairy lights"), L("Balkon", "Balcony"), "socket", onoff=False, measure_power=0.0)
dev(L("Wetter", "Weather"), None, "sensor", measure_temperature=6.4, measure_humidity=81)

FLOWS = {}
AFLOWS = {}
FLOW_IDS = []
for name, advanced in ((L("Gute Nacht", "Good night"), False), (L("Kino", "Movie night"), True), (L("Alles aus", "All off"), False), (L("Ich gehe", "Leaving"), True), (L("Lüften", "Airing"), False)):
    fid = _id("flow")
    (AFLOWS if advanced else FLOWS)[fid] = {"id": fid, "name": name, "enabled": True, "triggerable": True}
    FLOW_IDS.append(fid)
ALL_OFF = FLOW_IDS[2]

USER = _id("user")
USERS = {USER: {"id": USER, "name": "Demo", "role": "owner",
                "properties": {"favoriteFlows": FLOW_IDS, "favoriteDevices": [stehlampe, schreibtisch, lichterkette, tv]}}}

FILES = {
    "allow.json": [lichterkette],
    "groups.json": [
        {"id": "wz-decke", "name": L("Decke", "Ceiling"), "members": spots},
        {"id": "bad-spots", "name": "Spots", "members": bad},
    ],
    "order.json": [L("Wohnzimmer", "Living room"), L("Küche", "Kitchen"), L("Arbeitszimmer", "Office"), L("Flur", "Hallway"), L("Bad", "Bathroom"), L("Schlafzimmer", "Bedroom"), L("Kinderzimmer", "Kids room"), L("Balkon", "Balcony")],
    "floorplan.json": {
        "source": "demo flat, any unit (here centimetres)",
        "rooms": [
            {"zone": L("Balkon", "Balcony"), "outdoor": True, "poly": [[250, -260], [850, -260], [850, 0], [250, 0]]},
            {"poly": [[0, 0], [900, 0], [900, 600], [0, 600]],
             "parts": [{"zone": L("Wohnzimmer", "Living room"), "poly": [[0, 0], [600, 0], [600, 600], [0, 600]]},
                       {"zone": L("Küche", "Kitchen"), "poly": [[600, 0], [900, 0], [900, 600], [600, 600]]}]},
            {"zone": L("Schlafzimmer", "Bedroom"), "poly": [[900, 0], [1350, 0], [1350, 450], [900, 450]]},
            {"zone": L("Bad", "Bathroom"), "poly": [[900, 450], [1350, 450], [1350, 750], [900, 750]]},
            {"zone": L("Flur", "Hallway"), "poly": [[500, 600], [900, 600], [900, 1000], [500, 1000]]},
            {"zone": L("Kinderzimmer", "Kids room"), "poly": [[900, 750], [1350, 750], [1350, 1200], [900, 1200]]},
            {"zone": L("Arbeitszimmer", "Office"), "poly": [[0, 600], [500, 600], [500, 1000], [0, 1000]]},
        ],
    },
}


def file(name):
    """Beispieldatei oder None."""
    return copy.deepcopy(FILES.get(name))


def _jitter():
    """Leistungswerte leicht schwanken lassen, damit Kurve und Animation etwas zeigen."""
    for d in DEVICES.values():
        c = d["capabilitiesObj"].get("measure_power")
        if c and c["value"] and d["available"]:
            c["value"] = round(max(1.0, c["value"] * random.uniform(0.93, 1.07)), 1)


def request(method, path, body=None):
    with _lock:
        if method == "GET":
            if path == "/api/manager/zones/zone":
                return copy.deepcopy(ZONES)
            if path == "/api/manager/devices/device":
                _jitter()
                return copy.deepcopy(DEVICES)
            if path == "/api/manager/flow/flow":
                return copy.deepcopy(FLOWS)
            if path == "/api/manager/flow/advancedflow":
                return copy.deepcopy(AFLOWS)
            if path == "/api/manager/users/user":
                return copy.deepcopy(USERS)
        parts = path.strip("/").split("/")
        # PUT /api/manager/devices/device/<id>/capability/<cap>
        if method == "PUT" and len(parts) == 7 and parts[5] == "capability" and parts[4] in DEVICES:
            d = DEVICES[parts[4]]
            cap, value = parts[6], (body or {}).get("value")
            d["capabilitiesObj"][cap]["value"] = value
            if cap == "dim" and "onoff" in d["capabilitiesObj"]:
                d["capabilitiesObj"]["onoff"]["value"] = value > 0
            if cap == "onoff" and d["class"] == "light" and value and "dim" in d["capabilitiesObj"] \
                    and not d["capabilitiesObj"]["dim"]["value"]:
                d["capabilitiesObj"]["dim"]["value"] = 1.0
            return None
        # POST /api/manager/flow/<kind>/<id>/trigger
        if method == "POST" and len(parts) == 6 and parts[5] == "trigger":
            if parts[4] == ALL_OFF:
                for d in DEVICES.values():
                    if d["class"] == "light":
                        d["capabilitiesObj"]["onoff"]["value"] = False
            return None
    raise ConnectionError(f"Demo kennt {method} {path} nicht")

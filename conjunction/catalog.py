"""Orbital element catalogue from CelesTrak (public GP data, OMM JSON)."""
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

CACHE = Path(__file__).resolve().parent.parent / "cache"
URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=json"
# CelesTrak refreshes GP data every 2 hours and refuses repeat downloads in between.
MAX_AGE_S = 2 * 3600

GROUPS = {
    "active": "Active satellites",
    "stations": "Space stations",
    "visual": "Brightest objects",
    "cosmos-2251-debris": "Cosmos 2251 debris",
    "iridium-33-debris": "Iridium 33 debris",
    "fengyun-1c-debris": "Fengyun-1C debris",
    "cosmos-1408-debris": "Cosmos 1408 debris",
}

CONSTELLATIONS = ["STARLINK", "ONEWEB", "KUIPER", "IRIDIUM", "GLOBALSTAR", "ORBCOMM", "FLOCK", "LEMUR",
                  "SPIRE", "YAOGAN", "QIANFAN", "GUOWANG", "SWARM", "TIANQI", "JILIN", "GPS", "BEIDOU",
                  "GALILEO", "COSMOS", "GONETS", "O3B"]


def _fetch(group, log):
    path = CACHE / f"{group}.json"
    fresh = path.exists() and time.time() - path.stat().st_mtime < MAX_AGE_S
    if not fresh:
        try:
            r = requests.get(URL.format(group), timeout=60)
            if r.status_code == 200 and r.text.lstrip().startswith("["):
                CACHE.mkdir(exist_ok=True)
                path.write_text(r.text)
                log(f"Downloaded {GROUPS[group]} from CelesTrak")
            elif path.exists():
                log(f"CelesTrak has no newer data for {GROUPS[group]}; using cached copy")
            else:
                raise RuntimeError(f"CelesTrak returned {r.status_code}: {r.text[:120]}")
        except requests.RequestException as exc:
            if not path.exists():
                raise
            log(f"CelesTrak unreachable ({exc.__class__.__name__}); using cached {GROUPS[group]}")
    return json.loads(path.read_text())


def kind_of(name):
    n = name.upper()
    if " DEB" in n or n.endswith("DEB") or "DEBRIS" in n:
        return "debris"
    if "R/B" in n or "ROCKET" in n:
        return "rocket body"
    return "payload"


def family_of(name):
    n = name.upper()
    for c in CONSTELLATIONS:
        if n.startswith(c) or f" {c}" in n:
            return c
    return ""


def load(log=print):
    """All objects, de-duplicated by NORAD id, annotated with kind, family and element age."""
    now = datetime.now(timezone.utc)
    objs = {}
    for group in GROUPS:
        for r in _fetch(group, log):
            nid = int(r["NORAD_CAT_ID"])
            if nid in objs:
                continue
            epoch = datetime.fromisoformat(r["EPOCH"]).replace(tzinfo=timezone.utc)
            name = r["OBJECT_NAME"].strip()
            objs[nid] = {
                **r, "group": group, "kind": kind_of(name), "family": family_of(name),
                "age_days": (now - epoch).total_seconds() / 86400,
            }
    stamp = max((CACHE / f"{g}.json").stat().st_mtime for g in GROUPS if (CACHE / f"{g}.json").exists())
    return list(objs.values()), datetime.fromtimestamp(stamp, timezone.utc)

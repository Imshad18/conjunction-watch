"""All-vs-all conjunction screening with SGP4.

1. Propagate every object on a fixed time grid (vectorised SGP4).
2. At each step, a k-d tree returns pairs within a search radius large enough that no
   encounter can slip between two steps (miss threshold + max relative speed * step / 2).
3. For each pair, assume straight-line relative motion around the step to get the time
   and distance of closest approach.
4. Pairs below the threshold are refined with direct SGP4 calls (golden-section search).
"""
import math
import time
from datetime import datetime, timedelta, timezone

import numpy as np
from scipy.spatial import cKDTree
from sgp4 import omm
from sgp4.api import Satrec, SatrecArray, jday

R_EARTH = 6378.137
MAX_REL_SPEED = 16.0  # km/s, head-on LEO encounter
HARD_BODY_M = {"payload": 5.0, "rocket body": 4.0, "debris": 0.5}


def make_satrecs(objs):
    sats, keep = [], []
    for o in objs:
        s = Satrec()
        try:
            omm.initialize(s, {k: str(v) for k, v in o.items() if k.isupper()})
        except Exception:
            continue
        sats.append(s)
        keep.append(o)
    return sats, keep


def _jd(dt):
    jd, fr = jday(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second + dt.microsecond / 1e6)
    return jd, fr


def _pos(sat, t0_jd, t0_fr, sec):
    e, r, v = sat.sgp4(t0_jd, t0_fr + sec / 86400.0)
    return (np.array(r), np.array(v)) if e == 0 else (None, None)


def _refine(s1, s2, jd, fr, t_guess, half):
    """Golden-section search for the minimum separation in [t_guess-half, t_guess+half] (seconds)."""
    def dist(t):
        r1, _ = _pos(s1, jd, fr, t)
        r2, _ = _pos(s2, jd, fr, t)
        return np.inf if r1 is None or r2 is None else float(np.linalg.norm(r2 - r1))
    a, b = t_guess - half, t_guess + half
    g = (math.sqrt(5) - 1) / 2
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = dist(c), dist(d)
    for _ in range(40):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = dist(c)
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = dist(d)
        if b - a < 0.001:
            break
    t = (a + b) / 2
    return t, dist(t)


def gmst(jd_ut1):
    """Greenwich mean sidereal time (radians), IAU 1982."""
    T = (jd_ut1 - 2451545.0) / 36525.0
    s = 67310.54841 + (876600 * 3600 + 8640184.812866) * T + 0.093104 * T ** 2 - 6.2e-6 * T ** 3
    return (s % 86400) / 86400 * 2 * math.pi


def collision_probability(miss_km, sigma_km, hbr_m):
    """Circular-Gaussian Pc in the encounter plane, small-object approximation."""
    R = hbr_m / 1000.0
    s2 = sigma_km ** 2
    return float(min(1.0, R ** 2 / (2 * s2) * math.exp(-miss_km ** 2 / (2 * s2))))


def _category(a, b):
    if a["kind"] != "payload" or b["kind"] != "payload":
        return "debris"
    if a["family"] == "STARLINK" and b["family"] == "STARLINK":
        return "starlink"
    return "payload"


def _summary(events, threshold_km):
    miss = np.array([e["miss_km"] for e in events]) if events else np.zeros(0)
    alt = np.array([e["alt_km"] for e in events]) if events else np.zeros(0)
    cats = [e["category"] for e in events]
    bins = np.linspace(0, threshold_km, 21)
    abins = np.arange(150, 2100, 50)
    return {
        "total": len(events),
        "under_1km": int((miss < 1).sum()), "under_200m": int((miss < 0.2).sum()),
        "by_category": {c: cats.count(c) for c in ("starlink", "payload", "debris")},
        "miss_hist": {"edges": bins.round(3).tolist(), "counts": np.histogram(miss, bins)[0].tolist()},
        "alt_hist": {"edges": abins.tolist(), "counts": np.histogram(alt, abins)[0].tolist()},
        "max_pc": max((e["pc"] for e in events), default=0.0),
    }


def screen(objs, hours=24.0, threshold_km=10.0, step_s=20.0, start=None, progress=None, max_events=3000):
    t_run = time.time()
    start = start or datetime.now(timezone.utc).replace(microsecond=0)
    jd0, fr0 = _jd(start)
    sats, objs = make_satrecs(objs)
    objs_by_id = {int(o["NORAD_CAT_ID"]): o for o in objs}
    arr = SatrecArray(sats)
    n = len(sats)
    steps = np.arange(0, hours * 3600 + step_s, step_s)
    radius = threshold_km + MAX_REL_SPEED * step_s / 2
    chunk = max(1, int(2e7 // (n * 6)))  # keep position+velocity arrays around ~1 GB worst case
    raw = []
    pairs_checked = 0
    for c0 in range(0, len(steps), chunk):
        sec = steps[c0:c0 + chunk]
        err, r, v = arr.sgp4(np.full(len(sec), jd0), fr0 + sec / 86400.0)
        for k in range(len(sec)):
            ok = err[:, k] == 0
            idx = np.flatnonzero(ok)
            p = r[idx, k]
            pr = cKDTree(p).query_pairs(radius, output_type="ndarray")
            if len(pr) == 0:
                continue
            pairs_checked += len(pr)
            i, j = idx[pr[:, 0]], idx[pr[:, 1]]
            dr = r[j, k] - r[i, k]
            dv = v[j, k] - v[i, k]
            vv = np.maximum((dv * dv).sum(1), 1e-12)
            tau = np.clip(-(dr * dv).sum(1) / vv, -step_s / 2, step_s / 2)
            d = np.linalg.norm(dr + dv * tau[:, None], axis=1)
            hit = d < threshold_km * 1.5
            for a, b, t, dd, sp in zip(i[hit], j[hit], sec[k] + tau[hit], d[hit], np.sqrt(vv[hit])):
                raw.append((int(a), int(b), float(t), float(dd), float(sp)))
        if progress:
            progress(5 + 75 * min(1, (c0 + chunk) / len(steps)),
                     f"Screened {min(c0 + chunk, len(steps))}/{len(steps)} time steps · "
                     f"{pairs_checked:,} pair checks · {len(raw):,} close passes so far")

    # One entry per encounter: same pair within 10 minutes = same pass
    raw.sort(key=lambda x: (x[0], x[1], x[2]))
    merged = []
    for e in raw:
        if merged and merged[-1][0] == e[0] and merged[-1][1] == e[1] and e[2] - merged[-1][2] < 600:
            if e[3] < merged[-1][3]:
                merged[-1] = e
        else:
            merged.append(e)

    events, co_orbiting = [], 0
    for m, (a, b, t, _, sp) in enumerate(merged):
        if progress and m % 50 == 0:
            progress(80 + 18 * m / max(1, len(merged)), f"Refining encounter {m + 1}/{len(merged)} with full SGP4…")
        if sp < 0.05:  # docked, formation flying or freshly separated objects
            co_orbiting += 1
            continue
        tca, miss = _refine(sats[a], sats[b], jd0, fr0, t, step_s)
        if not np.isfinite(miss) or miss > threshold_km:
            continue
        r1, v1 = _pos(sats[a], jd0, fr0, tca)
        r2, v2 = _pos(sats[b], jd0, fr0, tca)
        # Radial / in-track / cross-track components of the miss vector in the primary's frame
        R = r1 / np.linalg.norm(r1)
        C = np.cross(r1, v1)
        C /= np.linalg.norm(C)
        I = np.cross(C, R)
        dvec = r2 - r1
        rel = v2 - v1
        when = start + timedelta(seconds=tca)
        jd_t = jd0 + fr0 + tca / 86400
        lon = (math.atan2(r1[1], r1[0]) - gmst(jd_t)) % (2 * math.pi)
        lon = math.degrees(lon - 2 * math.pi if lon > math.pi else lon)
        lat = math.degrees(math.asin(r1[2] / np.linalg.norm(r1)))
        oa, ob = objs[a], objs[b]
        sigma = math.hypot(0.3 + 1.0 * oa["age_days"], 0.3 + 1.0 * ob["age_days"])
        hbr = HARD_BODY_M[oa["kind"]] + HARD_BODY_M[ob["kind"]]
        events.append({
            "a": int(oa["NORAD_CAT_ID"]), "b": int(ob["NORAD_CAT_ID"]),
            "tca": when.isoformat().replace("+00:00", "Z"), "tca_s": round(tca, 3),
            "miss_km": round(miss, 4), "rel_speed_kms": round(float(np.linalg.norm(rel)), 3),
            "radial_km": round(float(dvec @ R), 4), "intrack_km": round(float(dvec @ I), 4),
            "crosstrack_km": round(float(dvec @ C), 4),
            "alt_km": round(float(np.linalg.norm(r1) - R_EARTH), 1), "lat": round(lat, 2), "lon": round(lon, 2),
            "sigma_km": round(sigma, 2), "pc": collision_probability(miss, sigma, hbr),
        })
    events.sort(key=lambda e: e["miss_km"])
    for e in events:
        e["category"] = _category(objs_by_id[e["a"]], objs_by_id[e["b"]])
    summary = _summary(events, threshold_km)
    events = events[:max_events]

    used = {e["a"] for e in events} | {e["b"] for e in events}
    kinds = {}
    for o in objs:
        kinds[o["kind"]] = kinds.get(o["kind"], 0) + 1
    return {
        "start": start.isoformat().replace("+00:00", "Z"), "hours": hours, "threshold_km": threshold_km,
        "step_s": step_s, "objects": n, "kinds": kinds, "pair_checks": pairs_checked,
        "co_orbiting_skipped": co_orbiting, "runtime_s": round(time.time() - t_run, 1),
        "summary": summary, "events": events,
        "objects_involved": {int(o["NORAD_CAT_ID"]): {
            "name": o["OBJECT_NAME"], "id": o.get("OBJECT_ID"), "kind": o["kind"], "family": o["family"],
            "group": o["group"], "epoch": o["EPOCH"], "age_days": round(o["age_days"], 2),
            "inclination": o["INCLINATION"], "period_min": round(1440 / float(o["MEAN_MOTION"]), 2),
        } for o in objs if int(o["NORAD_CAT_ID"]) in used},
    }

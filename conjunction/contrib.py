"""Turning predictions into a public, verifiable record.

- CDM: a Conjunction Data Message (CCSDS 508.0-B-1 key=value layout) for one event.
- Prediction package: the run's notable events, published before closest approach (timestamped by Zenodo).
- Verification: after closest approach, newer element sets show whether either object manoeuvred.
"""
import csv
import io
import json
import math
import zipfile
from datetime import datetime, timezone

from . import catalog

MU = 398600.4418
REPO_URL = "https://github.com/Imshad18/conjunction-watch"
MANEUVER_KM = 0.3      # unexplained semi-major-axis change that counts as a manoeuvre
PLANE_DEG = 0.01       # unexplained inclination change


def _now():
    return datetime.now(timezone.utc)


def _epoch(s):
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _sma(n_rev_day):
    n = float(n_rev_day) * 2 * math.pi / 86400
    return (MU / n ** 2) ** (1 / 3)


def notable(run, max_km=1.0, min_pc=1e-5, limit=200):
    ev = [e for e in run["events"] if e["miss_km"] <= max_km or e["pc"] >= min_pc]
    return sorted(ev, key=lambda e: e["miss_km"])[:limit]


# ------------------------------------------------------------------ CDM
def cdm(run, ev, originator="Conjunction Watch"):
    A, B = run["objects_involved"][str(ev["a"])], run["objects_involved"][str(ev["b"])]
    created = _now().strftime("%Y-%m-%dT%H:%M:%S.000")
    tca = ev["tca"].replace("Z", "")
    sig_m = ev["sigma_km"] * 1000 / math.sqrt(2)

    def obj(tag, o, nid):
        return f"""COMMENT {tag} element set epoch {o['epoch']}, {o.get('age_days', 0):.2f} days before screening
OBJECT                       = {tag}
OBJECT_DESIGNATOR            = {nid}
CATALOG_NAME                 = SATCAT
OBJECT_NAME                  = {o['name']}
INTERNATIONAL_DESIGNATOR     = {o.get('id') or 'UNKNOWN'}
OBJECT_TYPE                  = {'DEBRIS' if o['kind'] == 'debris' else 'ROCKET BODY' if o['kind'] == 'rocket body' else 'PAYLOAD'}
EPHEMERIS_NAME               = NONE
COVARIANCE_METHOD            = DEFAULT
MANEUVERABLE                 = N/A
REF_FRAME                    = RTN
COMMENT Position covariance is an assumed isotropic value, not an operator-provided covariance
CR_R                         = {sig_m ** 2:.4e} [m**2]
CT_R                         = 0.0000e+00 [m**2]
CT_T                         = {sig_m ** 2:.4e} [m**2]
CN_R                         = 0.0000e+00 [m**2]
CN_T                         = 0.0000e+00 [m**2]
CN_N                         = {sig_m ** 2:.4e} [m**2]
"""
    return f"""CCSDS_CDM_VERS               = 1.0
COMMENT Informational message from public GP (TLE) data propagated with SGP4. Not an operational CDM.
CREATION_DATE                = {created}
ORIGINATOR                   = {originator}
MESSAGE_ID                   = CW_{ev['a']}_{ev['b']}_{tca[:19].replace('-', '').replace(':', '')}
TCA                          = {tca}
MISS_DISTANCE                = {ev['miss_km'] * 1000:.1f} [m]
RELATIVE_SPEED               = {ev['rel_speed_kms'] * 1000:.1f} [m/s]
RELATIVE_POSITION_R          = {ev['radial_km'] * 1000:.1f} [m]
RELATIVE_POSITION_T          = {ev['intrack_km'] * 1000:.1f} [m]
RELATIVE_POSITION_N          = {ev['crosstrack_km'] * 1000:.1f} [m]
COLLISION_PROBABILITY        = {ev['pc']:.3e}
COLLISION_PROBABILITY_METHOD = FOSTER-1992
{obj('OBJECT1', A, ev['a'])}{obj('OBJECT2', B, ev['b'])}"""


# ------------------------------------------------------------------ texts
def notice_email(run, ev, author):
    A, B = run["objects_involved"][str(ev["a"])], run["objects_involved"][str(ev["b"])]
    return f"""Subject: Predicted close approach {A['name']} / {B['name']} at {ev['tca'][:19].replace('T', ' ')} UTC

Hello,

My independent screening of the public CelesTrak catalogue predicts a close approach between

  {A['name']} (NORAD {ev['a']}) and {B['name']} (NORAD {ev['b']})
  Time of closest approach  {ev['tca'][:19].replace('T', ' ')} UTC
  Miss distance             {ev['miss_km'] * 1000:.0f} m (radial {ev['radial_km'] * 1000:.0f} m, in-track {ev['intrack_km'] * 1000:.0f} m, cross-track {ev['crosstrack_km'] * 1000:.0f} m)
  Relative speed            {ev['rel_speed_kms']:.2f} km/s
  Altitude                  {ev['alt_km']:.0f} km
  Estimated Pc              {ev['pc']:.1e} (assumed covariance)

This is based on public element sets propagated with SGP4, so it is far less accurate than your own
ephemerides and the official 18 SDS screening; I am sharing it in case it is useful. A CDM-format file is attached.

Best regards,
{author.get('name') or '<your name>'}
{author.get('affiliation') or ''}
"""


def social_post(run, ev, outcome=None):
    A, B = run["objects_involved"][str(ev["a"])], run["objects_involved"][str(ev["b"])]
    base = (f"{A['name']} and {B['name']} pass {ev['miss_km'] * 1000:.0f} m apart at {ev['rel_speed_kms']:.1f} km/s, "
            f"{ev['tca'][:16].replace('T', ' ')} UTC, {ev['alt_km']:.0f} km up")
    if outcome and outcome.get("maneuvered"):
        who = " and ".join(outcome["maneuvered"])
        return f"Predicted: {base}. Newer orbital data shows {who} changed orbit around that time, consistent with an avoidance manoeuvre."
    return f"Close approach coming up: {base}. Screened from public data with {REPO_URL}"


# ------------------------------------------------------------------ verification
def _check_object(old, new, tca):
    if new is None:
        return {"status": "missing", "text": "No longer in the public catalogue (decayed, re-catalogued or removed)."}
    e_old, e_new = _epoch(old["EPOCH"]), _epoch(new["EPOCH"])
    if e_new <= tca:
        return {"status": "waiting", "text": f"Newest elements ({e_new:%m-%d %H:%M}) are from before closest approach."}
    dt = (e_new - e_old).total_seconds() / 86400
    n_pred = float(old["MEAN_MOTION"]) + 2 * float(old.get("MEAN_MOTION_DOT") or 0) * dt  # drag trend from the old set
    da = _sma(float(new["MEAN_MOTION"])) - _sma(n_pred)
    di = float(new["INCLINATION"]) - float(old["INCLINATION"])
    moved = abs(da) > MANEUVER_KM or abs(di) > PLANE_DEG
    return {"status": "maneuver" if moved else "steady", "da_km": round(da, 3), "di_deg": round(di, 4), "days": round(dt, 2),
            "text": (f"Orbit changed: semi-major axis {da * 1000:+.0f} m beyond drag, inclination {di:+.4f}° over {dt:.1f} d."
                     if moved else f"No manoeuvre: semi-major axis within {abs(da) * 1000:.0f} m of the drag trend over {dt:.1f} d.")}


def verify(run):
    """Outcome of every notable event whose closest approach has passed."""
    if not any("omm" in o for o in run["objects_involved"].values()):
        return {"available": False, "reason": "This run predates outcome tracking; runs from now on can be verified."}
    objs, stamp = catalog.load(lambda m: None)
    latest = {int(o["NORAD_CAT_ID"]): o for o in objs}
    now = _now()
    out = []
    for ev in notable(run):
        tca = _epoch(ev["tca"].replace("Z", ""))
        if tca > now:
            continue
        res = {"a": ev["a"], "b": ev["b"], "tca": ev["tca"], "miss_km": ev["miss_km"]}
        maneuvered, waiting = [], False
        for side in ("a", "b"):
            o = run["objects_involved"][str(ev[side])]
            chk = _check_object(o["omm"], latest.get(ev[side]), tca)
            res[side + "_check"] = chk
            if chk["status"] == "maneuver":
                maneuvered.append(o["name"])
            waiting |= chk["status"] == "waiting"
        res["maneuvered"] = maneuvered
        res["outcome"] = ("maneuver" if maneuvered else "waiting" if waiting else "no maneuver")
        out.append(res)
    counts = {k: sum(r["outcome"] == k for r in out) for k in ("maneuver", "no maneuver", "waiting")}
    return {"available": True, "checked_at": now.isoformat(timespec="seconds"), "elements_time": stamp.isoformat(timespec="minutes"),
            "results": out, "counts": counts}


# ------------------------------------------------------------------ packages
def _csv(run, events):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["tca_utc", "norad_a", "name_a", "norad_b", "name_b", "miss_m", "rel_speed_kms", "radial_m", "intrack_m",
                "crosstrack_m", "alt_km", "lat", "lon", "pc_estimate"])
    for e in events:
        A, B = run["objects_involved"][str(e["a"])], run["objects_involved"][str(e["b"])]
        w.writerow([e["tca"], e["a"], A["name"], e["b"], B["name"], round(e["miss_km"] * 1000, 1), e["rel_speed_kms"],
                    round(e["radial_km"] * 1000, 1), round(e["intrack_km"] * 1000, 1), round(e["crosstrack_km"] * 1000, 1),
                    e["alt_km"], e["lat"], e["lon"], f"{e['pc']:.3e}"])
    return buf.getvalue()


def prediction_package(run, author, max_km=1.0):
    events = notable(run, max_km)
    readme = f"""# Conjunction predictions, screening of {run['start'][:16].replace('T', ' ')} UTC

{run['objects']:,} objects from the public CelesTrak catalogue (elements as of {run.get('elements_time', '')[:16]}) screened
all-vs-all with SGP4 over {run['hours']} h. This archive lists the {len(events)} closest approaches under {max_km} km or with
estimated Pc >= 1e-5, published before they happen so they can be checked afterwards.

Prepared by {author.get('name') or 'the author'}{(', ' + author['affiliation']) if author.get('affiliation') else ''} with {REPO_URL}.

Files: predictions.csv, run.json (full run including the element sets used), cdm/*.txt (one CDM-format file per event).
Accuracy is limited by public two-line elements (around 1 km); collision probabilities use an assumed covariance.
"""
    z = io.BytesIO()
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as f:
        f.writestr("README.md", readme)
        f.writestr("predictions.csv", _csv(run, events))
        f.writestr("run.json", json.dumps(run))
        for e in events[:100]:
            f.writestr(f"cdm/{e['a']}_{e['b']}_{e['tca'][:19].replace(':', '')}.txt", cdm(run, e))
    return z.getvalue(), events


def outcome_package(run, ver, author):
    lines = ["# Outcome of conjunction predictions", "",
             f"Predictions from the screening of {run['start'][:16].replace('T', ' ')} UTC, checked {ver['checked_at'][:16]} UTC against",
             f"element sets from {ver['elements_time']}. An orbit change of more than {MANEUVER_KM * 1000:.0f} m in semi-major axis beyond",
             "the drag trend (or 0.01 deg in inclination) between the predicting element set and the first set after closest",
             "approach is counted as a manoeuvre. Station-keeping can also cause this, so it is evidence, not proof, of avoidance.", "",
             f"Manoeuvres detected: {ver['counts']['maneuver']}; no manoeuvre: {ver['counts']['no maneuver']}; awaiting data: {ver['counts']['waiting']}.", "",
             "| TCA (UTC) | Objects | Miss (m) | Outcome |", "|---|---|---|---|"]
    for r in ver["results"]:
        A, B = run["objects_involved"][str(r["a"])]["name"], run["objects_involved"][str(r["b"])]["name"]
        lines.append(f"| {r['tca'][:16].replace('T', ' ')} | {A} / {B} | {r['miss_km'] * 1000:.0f} | "
                     f"{('manoeuvre: ' + ', '.join(r['maneuvered'])) if r['maneuvered'] else r['outcome']} |")
    lines += ["", f"Prepared by {author.get('name') or 'the author'} with {REPO_URL}."]
    z = io.BytesIO()
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as f:
        f.writestr("README.md", "\n".join(lines) + "\n")
        f.writestr("outcomes.json", json.dumps(ver, indent=1))
    return z.getvalue()


def zenodo_meta(kind, run, author, creator, related_doi=None, extra=""):
    when = run["start"][:16].replace("T", " ")
    title = (f"Satellite conjunction predictions, {when} UTC" if kind == "predictions"
             else f"Outcomes of satellite conjunction predictions from {when} UTC")
    meta = {
        "upload_type": "dataset", "title": title, "creators": [creator],
        "description": (f"<p>All-vs-all screening of {run['objects']:,} catalogued objects over {run['hours']} h using public "
                        f"CelesTrak element sets and SGP4. {extra}</p><p>Software: {REPO_URL}</p>"),
        "keywords": ["space debris", "conjunction assessment", "space situational awareness", "SGP4", "satellites"],
        "license": "cc-by-4.0",
        "related_identifiers": [{"identifier": REPO_URL, "relation": "isSupplementedBy", "resource_type": "software"}],
    }
    if related_doi:
        meta["related_identifiers"].append({"identifier": related_doi, "relation": "isSupplementTo"})
    return meta

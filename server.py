"""Conjunction Watch web server.

Run:  python server.py   then open http://localhost:8001
"""
import json
import queue
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sgp4.exporter import export_tle

from conjunction import catalog, contrib, screen, zenodo

ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
app = FastAPI(title="Conjunction Watch")
app.add_middleware(GZipMiddleware, minimum_size=2000)

jobs = {}
job_queue = queue.Queue()


class ScreenRequest(BaseModel):
    hours: float = 24
    threshold_km: float = 5
    step_s: float = 20


def worker():
    while True:
        jid = job_queue.get()
        job = jobs[jid]
        job["status"] = "running"

        def log(msg, pct=None):
            job["log"].append(msg)
            if pct is not None:
                job["pct"] = round(pct, 1)

        try:
            log("Loading orbital elements…", 1)
            objs, stamp = catalog.load(lambda m: log(m))
            log(f"{len(objs):,} objects, elements as of {stamp:%Y-%m-%d %H:%M} UTC", 4)
            res = screen.screen(objs, job["hours"], job["threshold_km"], job["step_s"],
                                progress=lambda p, m: log(m, p))
            res["elements_time"] = stamp.isoformat().replace("+00:00", "Z")
            RUNS.mkdir(exist_ok=True)
            name = f"run_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.json"
            (RUNS / name).write_text(json.dumps(res))
            job.update(status="done", pct=100, file=name)
            log(f"Done: {res['summary']['total']:,} conjunctions under {job['threshold_km']} km "
                f"in {res['runtime_s']} s")
        except Exception as exc:
            traceback.print_exc()
            job.update(status="error", error=str(exc))
            log(f"ERROR: {exc}")


threading.Thread(target=worker, daemon=True).start()


def _submit(req: ScreenRequest):
    jid = uuid.uuid4().hex[:10]
    jobs[jid] = {"id": jid, "status": "queued", "pct": 0, "log": [], "created": time.time(), **req.model_dump()}
    job_queue.put(jid)
    return jobs[jid]


@app.post("/api/screen")
def start_screen(req: ScreenRequest):
    if not (1 <= req.hours <= 72 and 0.1 <= req.threshold_km <= 25 and 5 <= req.step_s <= 60):
        raise HTTPException(400, "hours 1–72, threshold 0.1–25 km, step 5–60 s")
    return _submit(req)


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    if jid not in jobs:
        raise HTTPException(404)
    return jobs[jid]


@app.get("/api/jobs")
def list_jobs():
    return sorted(({k: v for k, v in j.items() if k != "log"} for j in jobs.values()), key=lambda j: -j["created"])


@app.get("/api/runs")
def list_runs():
    out = []
    for p in sorted(RUNS.glob("run_*.json"), reverse=True):
        try:
            r = json.loads(p.read_text())
            out.append({"file": p.name, "start": r["start"], "hours": r["hours"], "threshold_km": r["threshold_km"],
                        "objects": r["objects"], "total": r["summary"]["total"]})
        except Exception:
            continue
    return out


@app.get("/api/runs/{name}")
def get_run(name: str):
    p = RUNS / Path(name).name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="application/json")


# ------------------------------------------------------------------ contribution
class Author(BaseModel):
    name: str = ""
    affiliation: str = ""
    email: str = ""
    orcid: str = ""


class EventRef(BaseModel):
    run: str
    a: int
    b: int
    tca: str
    author: Author = Author()


class ZenodoReq(BaseModel):
    author: Author
    token: str
    sandbox: bool = True
    related_doi: str = ""


class PublishReq(BaseModel):
    id: int
    token: str
    sandbox: bool = True


def _run(name):
    p = RUNS / Path(name).name
    if not p.exists():
        raise HTTPException(404, "Run not found")
    return json.loads(p.read_text())


def _event(run, a, b, tca):
    for e in run["events"]:
        if e["a"] == a and e["b"] == b and e["tca"] == tca:
            return e
    raise HTTPException(404, "Event not found")


@app.post("/api/cdm")
def get_cdm(ref: EventRef):
    run = _run(ref.run)
    return PlainTextResponse(contrib.cdm(run, _event(run, ref.a, ref.b, ref.tca)))


@app.post("/api/notice")
def get_notice(ref: EventRef):
    run = _run(ref.run)
    ev = _event(run, ref.a, ref.b, ref.tca)
    return {"email": contrib.notice_email(run, ev, ref.author.model_dump()), "post": contrib.social_post(run, ev)}


@app.get("/api/verify/{name}")
def verify(name: str):
    return contrib.verify(_run(name))


@app.post("/api/predictions/{name}")
def predictions_package(name: str, author: Author):
    data, _ = contrib.prediction_package(_run(name), author.model_dump())
    return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="predictions_{Path(name).stem}.zip"'})


@app.post("/api/zenodo/predictions/{name}")
def zenodo_predictions(name: str, req: ZenodoReq):
    run = _run(name)
    data, events = contrib.prediction_package(run, req.author.model_dump())
    meta = contrib.zenodo_meta("predictions", run, req.author.model_dump(), zenodo.creator(req.author.model_dump()),
                               extra=f"{len(events)} closest approaches, published before they occur.")
    try:
        return zenodo.draft({f"predictions_{Path(name).stem}.zip": data}, meta, req.token, req.sandbox)
    except Exception as exc:
        raise HTTPException(502, str(exc))


@app.post("/api/zenodo/outcomes/{name}")
def zenodo_outcomes(name: str, req: ZenodoReq):
    run = _run(name)
    ver = contrib.verify(run)
    if not ver.get("available") or not ver["results"]:
        raise HTTPException(400, "No verified outcomes yet")
    data = contrib.outcome_package(run, ver, req.author.model_dump())
    meta = contrib.zenodo_meta("outcomes", run, req.author.model_dump(), zenodo.creator(req.author.model_dump()),
                               related_doi=req.related_doi or None,
                               extra=f"Manoeuvres detected after {ver['counts']['maneuver']} of {len(ver['results'])} predicted events.")
    try:
        return zenodo.draft({f"outcomes_{Path(name).stem}.zip": data}, meta, req.token, req.sandbox)
    except Exception as exc:
        raise HTTPException(502, str(exc))


@app.post("/api/zenodo-publish")
def zenodo_publish(req: PublishReq):
    try:
        return zenodo.publish(req.id, req.token, req.sandbox)
    except Exception as exc:
        raise HTTPException(502, str(exc))


_tle_cache = {}


@app.get("/api/catalog")
def get_catalog():
    """Two-line elements for every object, for live propagation in the browser."""
    objs, stamp = catalog.load(lambda m: None)
    key = stamp.isoformat()
    if key not in _tle_cache:
        sats, objs = screen.make_satrecs(objs)
        rows = []
        for s, o in zip(sats, objs):
            l1, l2 = export_tle(s)
            rows.append([int(o["NORAD_CAT_ID"]), o["OBJECT_NAME"], o["kind"], o["family"], l1, l2])
        _tle_cache.clear()
        _tle_cache[key] = {"elements_time": key, "objects": rows}
    return _tle_cache[key]


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")

if __name__ == "__main__":
    # Start a fresh 24 h screening if the newest run is older than 6 hours
    newest = max(RUNS.glob("run_*.json"), default=None, key=lambda p: p.stat().st_mtime) if RUNS.exists() else None
    if newest is None or time.time() - newest.stat().st_mtime > 6 * 3600:
        _submit(ScreenRequest())
    print("Conjunction Watch → http://localhost:8001")
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="warning")

"""Zenodo deposits: upload files as a draft, then publish for a permanent DOI."""
import requests


def _base(sandbox):
    return "https://sandbox.zenodo.org/api" if sandbox else "https://zenodo.org/api"


def creator(author):
    name = (author.get("name") or "Unknown").strip()
    parts = name.split()
    c = {"name": f"{parts[-1]}, {' '.join(parts[:-1])}" if len(parts) > 1 else name}
    if author.get("affiliation"):
        c["affiliation"] = author["affiliation"]
    if author.get("orcid"):
        c["orcid"] = author["orcid"]
    return c


def draft(files, metadata, token, sandbox=True):
    """files: {filename: bytes}. Returns the draft id, review link and reserved DOI."""
    base, auth = _base(sandbox), {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{base}/deposit/depositions", json={}, headers=auth, timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"Zenodo refused the request ({r.status_code}): {r.text[:200]}")
    dep = r.json()
    for name, data in files.items():
        u = requests.put(f"{dep['links']['bucket']}/{name}", data=data, headers=auth, timeout=300)
        if u.status_code >= 300:
            raise RuntimeError(f"Upload of {name} failed ({u.status_code}): {u.text[:200]}")
    m = requests.put(f"{base}/deposit/depositions/{dep['id']}", json={"metadata": metadata}, headers=auth, timeout=60)
    if m.status_code >= 300:
        raise RuntimeError(f"Metadata rejected ({m.status_code}): {m.text[:300]}")
    d = m.json()
    return {"id": d["id"], "html": d["links"].get("html"), "sandbox": sandbox,
            "doi": d.get("metadata", {}).get("prereserve_doi", {}).get("doi")}


def publish(dep_id, token, sandbox=True):
    r = requests.post(f"{_base(sandbox)}/deposit/depositions/{dep_id}/actions/publish",
                      headers={"Authorization": f"Bearer {token}"}, timeout=120)
    if r.status_code >= 300:
        raise RuntimeError(f"Publish failed ({r.status_code}): {r.text[:300]}")
    d = r.json()
    return {"doi": d.get("doi"), "url": d.get("doi_url") or d["links"].get("html")}

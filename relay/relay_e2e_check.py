#!/usr/bin/env python3
"""Live HTTPS end-to-end check for the deployed mobile capture relay (never prints tokens).

Server (root):  sudo -n python3 relay_e2e_check.py --env-file /etc/qingjian-relay.env
Windows local:  python relay_e2e_check.py --ssh your-relay-host
Uses deviceId 'relay-e2e-check'; afterwards purge with
  sudo -n -u qingjian env MOBILE_CAPTURE_STATE_DIR=/var/lib/qingjian-relay python3 relay_server.py admin purge-device relay-e2e-check
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import relay_server as rs  # noqa: E402

DEVICE_ID = "relay-e2e-check"
KEYS = ("MOBILE_CAPTURE_DEVICE_TOKEN", "MOBILE_CAPTURE_DESKTOP_TOKEN")


def parse_env(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            if k.strip() in KEYS:
                out[k.strip()] = v.strip()
    if set(out) != set(KEYS):
        raise SystemExit("token source did not provide both tokens")
    return out


def load_tokens(args) -> dict:
    if args.env_file:
        with open(args.env_file, encoding="utf-8") as fh:
            return parse_env(fh.read())
    proc = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", args.ssh, "sudo -n grep -E '^MOBILE_CAPTURE_(DEVICE|DESKTOP)_TOKEN=' /etc/qingjian-relay.env"],
        capture_output=True, timeout=30,
    )
    if proc.returncode != 0:
        raise SystemExit("failed to read tokens over ssh")
    return parse_env(proc.stdout.decode("utf-8"))


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def call(self, method, path, token=None, body=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("User-Agent", "mobile-capture-relay-e2e/1")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        if data is not None:
            req.add_header("Content-Type", "application/octet-stream" if raw is not None else "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload, status, headers = resp.read(), resp.status, resp.headers
        except urllib.error.HTTPError as err:
            payload, status, headers = err.read(), err.code, err.headers
        if headers.get("Content-Type", "").startswith("application/json"):
            return status, json.loads(payload)
        return status, payload


def envelope(payload: dict, previous: dict | None = None) -> dict:
    p = {"type": "note", "body": "", "source": "", "thought": "", "due": "", "tags": "", "attachments": []}
    p.update(payload)
    clean = {
        "id": previous["id"] if previous else str(uuid.uuid4()),
        "revision": previous["revision"] + 1 if previous else 1,
        "date": previous["date"] if previous else "2026-11-19",
        "createdAt": previous["createdAt"] if previous else "2026-11-19T09:40:00.000Z",
        "previousDigest": previous["digest"] if previous else None,
        "payload": p,
    }
    return {**clean, "digest": rs.sha256_text(rs.stable_json(clean))}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://relay.example.com/mobile-capture/v1")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--env-file")
    src.add_argument("--ssh")
    args = ap.parse_args()
    tok = load_tokens(args)
    dev, desk = tok["MOBILE_CAPTURE_DEVICE_TOKEN"], tok["MOBILE_CAPTURE_DESKTOP_TOKEN"]
    c = Client(args.base)
    results = []

    def check(name, cond, detail=""):
        results.append((name, bool(cond)))
        print(("PASS " if cond else "FAIL ") + name + (f" :: {detail}" if detail and not cond else ""))

    s, b = c.call("GET", "/health")
    check("no-token health -> 401", s == 401)
    s, b = c.call("GET", "/health", token="x" * 48)
    check("wrong-token health -> 401", s == 401)
    s, b = c.call("GET", "/health", token=dev)
    check("device health -> 200 role=device", s == 200 and b.get("role") == "device", str(b))
    s, b = c.call("GET", "/health", token=desk)
    check("desktop health -> 200 role=desktop", s == 200 and b.get("role") == "desktop", str(b))
    s, b = c.call("GET", "/desktop/pull", token=dev)
    check("device token on desktop/pull -> 403", s == 403)

    s, prev_meta = c.call("GET", "/meta/projects", token=dev)
    projects = [{"slug": "e2e测试", "title": "relay e2e"}, {"slug": "工作台"}]
    s, b = c.call("PUT", "/meta/projects", token=desk, body={"projects": projects})
    check("desktop PUT meta/projects", s == 200 and b.get("count") == 2, str(b))
    s, b = c.call("GET", "/meta/projects", token=dev)
    check("device GET meta/projects roundtrip", s == 200 and b.get("projects") == projects, str(b))

    img = b"\x89PNG\r\n\x1a\n" + os.urandom(48 * 1024)
    h = hashlib.sha256(img).hexdigest()
    s, b = c.call("PUT", "/attachments/" + "0" * 64, token=dev, raw=img)
    check("attachment hash mismatch -> 400", s == 400 and b.get("error") == "hash-mismatch", str(b))
    s, b = c.call("PUT", f"/attachments/{h}", token=dev, raw=img)
    check("attachment upload -> 201/200", s in (200, 201), str(b))

    att = {"id": str(uuid.uuid4()), "name": "e2e.png", "ext": ".png", "hash": h, "size": len(img)}
    e1 = envelope({"body": "relay e2e 含图记录 😀", "attachments": [att]})
    op1 = str(uuid.uuid4())
    s, b = c.call("POST", "/ops", token=dev, body={"opId": op1, "deviceId": DEVICE_ID, "kind": "upsert", "envelope": e1})
    check("upsert rev1 queued", s == 201 and b["op"]["state"] == "queued", str(b))
    s, b = c.call("POST", "/ops", token=dev, body={"opId": op1, "deviceId": DEVICE_ID, "kind": "upsert", "envelope": e1})
    check("upsert replay idempotent", s == 200 and b.get("replayed") is True, str(b))

    s, b = c.call("GET", "/desktop/pull?limit=50", token=desk)
    mine = [o for o in b.get("ops", []) if o["deviceId"] == DEVICE_ID]
    check("desktop pull sees op as pulled", s == 200 and mine and mine[0]["opId"] == op1 and mine[0]["state"] == "pulled", str(b)[:300])
    s, blob = c.call("GET", f"/desktop/attachments/{h}", token=desk)
    check("desktop download sha256 matches", s == 200 and hashlib.sha256(blob).hexdigest() == h)
    s, b = c.call("POST", "/desktop/ack", token=desk, body={"acks": [{
        "opId": op1, "state": "landed", "revision": 1, "digest": e1["digest"], "blockHash": "e" * 64,
        "path": "00_Inbox/Daily/2026-11-19.md"}]})
    check("desktop ack landed", s == 200 and b["results"][0]["ok"], str(b))
    s, b = c.call("GET", f"/desktop/attachments/{h}", token=desk)
    check("attachment purged right after landed (404)", s == 404, str(b))
    s, b = c.call("GET", f"/ops/status?ids={op1}", token=dev)
    check("device status landed with blockHash", s == 200 and b["ops"][0]["state"] == "landed" and b["ops"][0]["result"]["blockHash"] == "e" * 64, str(b))

    e2 = envelope({"body": "relay e2e 改过"}, previous=e1)
    op2 = str(uuid.uuid4())
    s, b = c.call("POST", "/ops", token=dev, body={"opId": op2, "deviceId": DEVICE_ID, "kind": "upsert", "envelope": e2})
    check("upsert rev2 queued", s == 201, str(b))
    c.call("GET", "/desktop/pull?limit=50", token=desk)
    s, b = c.call("POST", "/desktop/ack", token=desk, body={"acks": [{"opId": op2, "state": "conflict", "error": "e2e simulated manual edit",
                                                                         "revision": 1, "digest": e1["digest"], "blockHash": "f" * 64}]})
    s, b = c.call("GET", f"/ops/status?ids={op2}", token=dev)
    check("conflict ack visible to device", b["ops"][0]["state"] == "conflict", str(b))

    op3 = str(uuid.uuid4())
    s, b = c.call("POST", "/ops", token=dev, body={"opId": op3, "deviceId": DEVICE_ID, "kind": "delete", "captureId": e1["id"],
                                                    "targetRevision": 1, "expectedDigest": e1["digest"]})
    check("delete of landed capture queued for desktop", s == 201 and b["op"]["state"] == "queued", str(b))
    s, b = c.call("GET", "/desktop/pull?limit=50", token=desk)
    tgt = [o for o in b.get("ops", []) if o["opId"] == op3]
    check("desktop pull delete target", tgt and tgt[0]["target"]["captureId"] == e1["id"], str(b)[:300])
    s, b = c.call("POST", "/desktop/ack", token=desk, body={"acks": [{"opId": op3, "state": "deleted", "path": "00_Inbox/Daily/2026-11-19.md"}]})
    s, b = c.call("GET", f"/ops/status?ids={op3}", token=dev)
    check("delete ack -> deleted", b["ops"][0]["state"] == "deleted", str(b))

    img2 = os.urandom(20 * 1024)
    h2 = hashlib.sha256(img2).hexdigest()
    c.call("PUT", f"/attachments/{h2}", token=dev, raw=img2)
    e4 = envelope({"type": "issue", "body": "relay e2e 未拉走即取消", "attachments": [{"id": str(uuid.uuid4()), "name": "b.jpg", "ext": ".jpg", "hash": h2, "size": len(img2)}]})
    op4 = str(uuid.uuid4())
    c.call("POST", "/ops", token=dev, body={"opId": op4, "deviceId": DEVICE_ID, "kind": "upsert", "envelope": e4})
    s, b = c.call("POST", "/ops", token=dev, body={"opId": str(uuid.uuid4()), "deviceId": DEVICE_ID, "kind": "delete", "captureId": e4["id"],
                                                    "targetRevision": 1, "expectedDigest": e4["digest"]})
    check("delete before pull resolved by relay", s == 201 and b["op"]["state"] == "deleted" and b["op"]["result"]["resolvedBy"] == "relay", str(b))
    s, b = c.call("GET", f"/ops/status?ids={op4}", token=dev)
    check("cancelled upsert state", b["ops"][0]["state"] == "cancelled", str(b))

    # restore projects metadata as it was before the check
    if prev_meta.get("updatedAt"):
        c.call("PUT", "/meta/projects", token=desk, body={"projects": prev_meta.get("projects", [])})
        print("INFO projects metadata restored to previous list")
    else:
        print("INFO projects metadata was unset before check -> run admin clear-projects")
    s, b = c.call("GET", "/health", token=desk)
    print("INFO stats after check:", json.dumps(b.get("stats"), ensure_ascii=False))
    failed = [n for n, ok in results if not ok]
    print(f"SUMMARY {len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

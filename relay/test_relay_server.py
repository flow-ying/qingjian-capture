#!/usr/bin/env python3
"""Unit + in-process HTTP tests for relay_server.py (stdlib unittest only).

Run: python3 test_relay_server.py   (Node.js optional for cross-language digest parity tests)
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import uuid

import relay_server as rs

DEVICE_TOKEN = "d" * 20 + "evice-token-for-tests-0123456789"
DESKTOP_TOKEN = "k" * 20 + "esktop-token-for-tests-012345678"
CORE_CJS = Path(os.environ.get(
    "MOBILE_CAPTURE_CORE_CJS",
    str(Path(__file__).resolve().parent.parent / "desktop" / "standalone" / "core.cjs"),
))


def make_envelope(payload: dict, *, revision: int = 1, previous: dict | None = None, cid: str | None = None) -> dict:
    p = {"type": payload.get("type", "note"), "body": payload.get("body", ""), "source": payload.get("source", ""),
         "thought": payload.get("thought", ""), "due": payload.get("due", ""), "tags": payload.get("tags", ""),
         "attachments": payload.get("attachments", [])}
    if payload.get("project"):
        p["project"] = payload["project"]
    clean = {
        "id": previous["id"] if previous else (cid or str(uuid.uuid4())),
        "revision": previous["revision"] + 1 if previous else revision,
        "date": previous["date"] if previous else "2026-11-19",
        "createdAt": previous["createdAt"] if previous else "2026-11-19T09:30:00.123Z",
        "previousDigest": previous["digest"] if previous else None,
        "payload": p,
    }
    return {**clean, "digest": hashlib.sha256(rs.stable_json(clean).encode("utf-8")).hexdigest()}


def att(data: bytes, ext: str = ".jpg", name: str = "photo.jpg") -> dict:
    return {"id": str(uuid.uuid4()), "name": name, "ext": ext, "hash": hashlib.sha256(data).hexdigest(), "size": len(data)}


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


class RelayTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="relay-test-"))
        self.clock = Clock()
        self.cfg = rs.RelayConfig(
            state_dir=self.tmp / "state", device_token=DEVICE_TOKEN, desktop_token=DESKTOP_TOKEN,
            port=0, max_blob_bytes=64 * 1024, max_store_bytes=200 * 1024, max_active_ops=50,
            keep_terminal=5, now_fn=self.clock,
        )
        self.store = rs.RelayStore(self.cfg)
        self.server = rs.RelayHTTPServer(("127.0.0.1", 0), rs.make_handler(self.cfg, self.store))
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.store.db.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def req(self, method, path, *, token=None, body=None, raw=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        if token:
            h["Authorization"] = f"Bearer {token}"
        data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
        if data is not None:
            h["Content-Length"] = str(len(data))
        conn.request(method, rs.BASE + path, body=data, headers=h)
        resp = conn.getresponse()
        payload = resp.read()
        conn.close()
        ctype = resp.getheader("Content-Type", "")
        return resp.status, (json.loads(payload) if ctype.startswith("application/json") else payload), resp

    def dev(self, method, path, **kw):
        return self.req(method, path, token=DEVICE_TOKEN, **kw)

    def desk(self, method, path, **kw):
        return self.req(method, path, token=DESKTOP_TOKEN, **kw)

    def upload(self, data: bytes):
        return self.dev("PUT", f"/attachments/{hashlib.sha256(data).hexdigest()}", raw=data,
                        headers={"Content-Type": "application/octet-stream"})

    def post_upsert(self, env, op_id=None, device="my-phone"):
        return self.dev("POST", "/ops", body={"opId": op_id or str(uuid.uuid4()), "deviceId": device, "kind": "upsert", "envelope": env})

    def blob_files(self):
        return sorted(p.name for p in (self.cfg.state_dir / "blobs").iterdir() if not p.name.startswith("."))


class AuthAndRoutingTests(RelayTestBase):
    def test_missing_and_invalid_token(self):
        s, b, r = self.req("GET", "/health")
        self.assertEqual((s, b["error"]), (401, "unauthorized"))
        self.assertIn("Bearer", r.getheader("WWW-Authenticate"))
        s, b, _ = self.req("GET", "/health", token="x" * 40)
        self.assertEqual(s, 401)

    def test_roles(self):
        s, b, _ = self.dev("GET", "/health")
        self.assertEqual((s, b["role"], b["protocol"]), (200, "device", 1))
        self.assertNotIn("stats", b)
        s, b, _ = self.desk("GET", "/health")
        self.assertEqual((s, b["role"]), (200, "desktop"))
        self.assertIn("stats", b)
        self.assertEqual(self.dev("GET", "/desktop/pull")[0], 403)
        self.assertEqual(self.desk("POST", "/ops", body={})[0], 403)
        self.assertEqual(self.dev("PUT", "/meta/projects", body={"projects": []})[0], 403)

    def test_not_found_and_method(self):
        self.assertEqual(self.dev("GET", "/nope")[0], 404)
        s, _, r = self.dev("DELETE", "/ops")
        self.assertEqual(s, 405)
        self.assertEqual(r.getheader("Allow"), "POST")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/other/health")
        self.assertEqual(conn.getresponse().status, 404)
        conn.close()

    def test_json_too_large_and_invalid(self):
        s, b, _ = self.dev("POST", "/ops", raw=b"{" + b" " * (512 * 1024 + 10) + b"}")
        self.assertEqual((s, b["error"]), (413, "payload-too-large"))
        s, b, _ = self.dev("POST", "/ops", raw=b"not json")
        self.assertEqual((s, b["error"]), (400, "invalid-json"))

    def test_config_rejects_weak_or_equal_tokens(self):
        with self.assertRaises(ValueError):
            rs.RelayConfig(state_dir=self.tmp / "x", device_token="short", desktop_token=DESKTOP_TOKEN)
        with self.assertRaises(ValueError):
            rs.RelayConfig(state_dir=self.tmp / "x", device_token=DESKTOP_TOKEN, desktop_token=DESKTOP_TOKEN)


class AttachmentTests(RelayTestBase):
    def test_upload_idempotent_and_hash_checked(self):
        data = os.urandom(4096)
        s, b, _ = self.upload(data)
        self.assertEqual((s, b["already"]), (201, False))
        s, b, _ = self.upload(data)
        self.assertEqual((s, b["already"]), (200, True))
        s, b, _ = self.dev("PUT", "/attachments/" + "0" * 64, raw=b"abc")
        self.assertEqual((s, b["error"]), (400, "hash-mismatch"))
        self.assertEqual(self.blob_files(), [hashlib.sha256(data).hexdigest()])
        self.assertEqual([p for p in (self.cfg.state_dir / "blobs").iterdir() if p.name.endswith(".tmp")], [])

    def test_size_and_quota_limits(self):
        big = os.urandom(64 * 1024 + 1)
        s, b, _ = self.upload(big)
        self.assertEqual((s, b["error"]), (413, "payload-too-large"))
        for _ in range(3):
            self.assertEqual(self.upload(os.urandom(60 * 1024))[0], 201)
        s, b, _ = self.upload(os.urandom(60 * 1024))
        self.assertEqual((s, b["error"]), (507, "storage-quota-exceeded"))

    def test_device_cannot_download(self):
        data = os.urandom(100)
        self.upload(data)
        self.assertEqual(self.dev("GET", f"/desktop/attachments/{hashlib.sha256(data).hexdigest()}")[0], 403)

    def test_desktop_cannot_download_unqueued_blob(self):
        data = os.urandom(100)
        self.upload(data)
        s, b, _ = self.desk("GET", f"/desktop/attachments/{hashlib.sha256(data).hexdigest()}")
        self.assertEqual((s, b["error"]), (404, "attachment-not-found"))


class OperationFlowTests(RelayTestBase):
    def test_full_upsert_land_purges_attachment(self):
        data = os.urandom(2048)
        a = att(data)
        env = make_envelope({"type": "note", "body": "手机速记 😀\n第二行", "attachments": [a], "project": "工作台"})
        s, b, _ = self.post_upsert(env)
        self.assertEqual((s, b["error"]), (409, "attachment-missing"))
        self.upload(data)
        op_id = str(uuid.uuid4())
        s, b, _ = self.post_upsert(env, op_id)
        self.assertEqual((s, b["op"]["state"]), (201, "queued"))
        s, b, _ = self.post_upsert(env, op_id)
        self.assertEqual((s, b["replayed"], b["op"]["state"]), (200, True, "queued"))
        changed = make_envelope({"type": "note", "body": "different"}, cid=env["id"])
        self.assertEqual(self.post_upsert(changed, op_id)[1]["error"], "op-id-reused")
        s, b, _ = self.post_upsert(env)
        self.assertEqual((s, b["error"], b["existingOpId"]), (409, "duplicate-revision", op_id))
        s, b, _ = self.post_upsert(changed)
        self.assertEqual((s, b["error"]), (409, "revision-conflict"))

        s, b, _ = self.desk("GET", "/desktop/pull?limit=10")
        self.assertEqual(len(b["ops"]), 1)
        op = b["ops"][0]
        self.assertEqual((op["state"], op["envelope"]["digest"], op["envelope"]["payload"]["project"]), ("pulled", env["digest"], "工作台"))
        s, blob, r = self.desk("GET", f"/desktop/attachments/{a['hash']}")
        self.assertEqual((s, hashlib.sha256(blob).hexdigest()), (200, a["hash"]))
        self.assertEqual(r.getheader("X-Content-SHA256"), a["hash"])
        self.assertEqual(self.dev("GET", f"/ops/status?ids={op_id}")[1]["ops"][0]["state"], "pulled")
        # pull again re-delivers un-acked ops (at-least-once)
        self.assertEqual(len(self.desk("GET", "/desktop/pull")[1]["ops"]), 1)

        bad_ack = {"opId": op_id, "state": "landed", "revision": 1, "digest": "0" * 64, "blockHash": "1" * 64}
        res = self.desk("POST", "/desktop/ack", body={"acks": [bad_ack]})[1]["results"][0]
        self.assertEqual((res["ok"], res["error"]), (False, "invalid-ack"))
        ack = {"opId": op_id, "state": "landed", "revision": 1, "digest": env["digest"], "blockHash": "a" * 64,
               "path": "00_Inbox/Daily/2026-11-19.md"}
        res = self.desk("POST", "/desktop/ack", body={"acks": [ack]})[1]["results"][0]
        self.assertEqual((res["ok"], res["state"], res["replayed"]), (True, "landed", False))
        self.assertEqual(self.blob_files(), [])  # zero image-bed: purged immediately
        self.assertEqual(self.desk("GET", f"/desktop/attachments/{a['hash']}")[0], 404)
        res = self.desk("POST", "/desktop/ack", body={"acks": [ack]})[1]["results"][0]
        self.assertTrue(res["replayed"])
        res = self.desk("POST", "/desktop/ack", body={"acks": [{**ack, "state": "conflict", "error": "x"}]})[1]["results"][0]
        self.assertEqual(res["error"], "already-terminal")
        st = self.dev("GET", f"/ops/status?ids={op_id},{uuid.uuid4()}")[1]
        self.assertEqual(st["ops"][0]["state"], "landed")
        self.assertEqual(st["ops"][0]["result"]["blockHash"], "a" * 64)
        self.assertEqual(len(st["unknown"]), 1)
        self.assertEqual(self.desk("GET", "/desktop/pull")[1]["ops"], [])

        # revision 2 edit -> conflict ack, then delete -> deleted
        env2 = make_envelope({"type": "note", "body": "改过的内容"}, previous=env)
        op2 = str(uuid.uuid4())
        self.assertEqual(self.post_upsert(env2, op2)[0], 201)
        self.desk("GET", "/desktop/pull")
        res = self.desk("POST", "/desktop/ack", body={"acks": [{"opId": op2, "state": "conflict", "error": "原笔记中的记录已修改",
                                                                "revision": 1, "digest": env["digest"], "blockHash": "b" * 64}]})[1]
        self.assertTrue(res["results"][0]["ok"])
        self.assertEqual(self.dev("GET", f"/ops/status?ids={op2}")[1]["ops"][0]["state"], "conflict")
        op3 = str(uuid.uuid4())
        s, b, _ = self.dev("POST", "/ops", body={"opId": op3, "deviceId": "my-phone", "kind": "delete", "captureId": env["id"],
                                                 "targetRevision": 1, "expectedDigest": env["digest"]})
        self.assertEqual((s, b["op"]["state"]), (201, "queued"))
        s, b, _ = self.dev("POST", "/ops", body={"opId": str(uuid.uuid4()), "deviceId": "my-phone", "kind": "delete",
                                                 "captureId": env["id"], "targetRevision": 1, "expectedDigest": env["digest"]})
        self.assertEqual((s, b["error"]), (409, "delete-pending"))
        pulled = self.desk("GET", "/desktop/pull")[1]["ops"][0]
        self.assertEqual(pulled["target"], {"captureId": env["id"], "targetRevision": 1, "expectedDigest": env["digest"]})
        res = self.desk("POST", "/desktop/ack", body={"acks": [{"opId": op3, "state": "landed", "revision": 1, "digest": env["digest"], "blockHash": "c" * 64}]})[1]
        self.assertEqual(res["results"][0]["error"], "invalid-ack")
        res = self.desk("POST", "/desktop/ack", body={"acks": [{"opId": op3, "state": "deleted", "path": "00_Inbox/Daily/2026-11-19.md"}]})[1]
        self.assertTrue(res["results"][0]["ok"])
        self.assertEqual(self.post_upsert(make_envelope({"body": "x"}, previous=env))[1]["error"], "capture-deleted")

    def test_delete_before_pull_cancels_locally(self):
        data = os.urandom(1000)
        self.upload(data)
        env = make_envelope({"type": "issue", "body": "要不要取消", "attachments": [att(data, ".png", "a.png")]})
        op1 = str(uuid.uuid4())
        self.post_upsert(env, op1)
        self.assertEqual(len(self.blob_files()), 1)
        s, b, _ = self.dev("POST", "/ops", body={"opId": str(uuid.uuid4()), "deviceId": "my-tablet", "kind": "delete",
                                                 "captureId": env["id"], "targetRevision": 1, "expectedDigest": env["digest"]})
        self.assertEqual((s, b["op"]["state"], b["op"]["result"]["resolvedBy"]), (201, "deleted", "relay"))
        self.assertEqual(self.dev("GET", f"/ops/status?ids={op1}")[1]["ops"][0]["state"], "cancelled")
        self.assertEqual(self.blob_files(), [])
        self.assertEqual(self.desk("GET", "/desktop/pull")[1]["ops"], [])

    def test_delete_after_pull_goes_to_desktop(self):
        env = make_envelope({"body": "已被电脑拉走"})
        self.post_upsert(env)
        self.desk("GET", "/desktop/pull")
        s, b, _ = self.dev("POST", "/ops", body={"opId": str(uuid.uuid4()), "deviceId": "my-phone", "kind": "delete",
                                                 "captureId": env["id"], "targetRevision": 1, "expectedDigest": env["digest"]})
        self.assertEqual(b["op"]["state"], "queued")
        kinds = [o["kind"] for o in self.desk("GET", "/desktop/pull")[1]["ops"]]
        self.assertEqual(kinds, ["upsert", "delete"])

    def test_envelope_validation(self):
        env = make_envelope({"body": "ok"})
        self.assertEqual(self.post_upsert({**env, "digest": "0" * 64})[1]["error"], "digest-mismatch")
        raw = make_envelope({"body": "  not trimmed  "})
        self.assertEqual(self.post_upsert(raw)[1]["error"], "not-normalized")
        crlf = make_envelope({"body": "a\r\nb"})
        self.assertEqual(self.post_upsert(crlf)[1]["error"], "not-normalized")
        self.assertEqual(self.post_upsert(make_envelope({"type": "idea", "body": "x", "tags": "nohash"}))[1]["error"], "invalid-payload")
        self.assertEqual(self.post_upsert(make_envelope({"type": "note", "body": "x", "due": "2026-11-20"}))[1]["error"], "invalid-payload")
        self.assertEqual(self.post_upsert(make_envelope({"type": "note", "body": ""}))[1]["error"], "invalid-payload")
        self.assertEqual(self.post_upsert(make_envelope({"body": "x", "project": "#工作台"}))[1]["error"], "invalid-payload")
        bad_rev = make_envelope({"body": "x"})
        bad_rev["previousDigest"] = "a" * 64
        self.assertEqual(self.post_upsert(bad_rev)[1]["error"], "invalid-envelope")
        s, b, _ = self.dev("POST", "/ops", body={"opId": "not-uuid", "deviceId": "my-phone", "kind": "upsert", "envelope": env})
        self.assertEqual(b["error"], "invalid-op")
        s, b, _ = self.dev("POST", "/ops", body={"opId": str(uuid.uuid4()), "deviceId": "Bad Device", "kind": "upsert", "envelope": env})
        self.assertEqual(b["error"], "invalid-op")
        ok = make_envelope({"type": "idea", "body": "想法", "tags": "#a #b"})
        self.assertEqual(self.post_upsert(ok)[0], 201)
        task = make_envelope({"type": "task", "body": "交作业", "due": "2026-11-20"})
        self.assertEqual(self.post_upsert(task)[0], 201)

    def test_extra_unknown_fields_are_dropped_from_canonical(self):
        env = make_envelope({"body": "extra"})
        env_extra = {**env, "deviceId": "ignored", "payload": {**env["payload"], "future": 1}}
        s, b, _ = self.post_upsert(env_extra)
        self.assertEqual(s, 201)
        pulled = self.desk("GET", "/desktop/pull")[1]["ops"][0]["envelope"]
        self.assertNotIn("future", pulled["payload"])
        self.assertNotIn("deviceId", pulled)

    def test_queue_full(self):
        self.cfg.max_active_ops = 2
        self.post_upsert(make_envelope({"body": "1"}))
        self.post_upsert(make_envelope({"body": "2"}))
        s, b, _ = self.post_upsert(make_envelope({"body": "3"}))
        self.assertEqual((s, b["error"]), (429, "queue-full"))

    def test_pull_limit_and_more(self):
        for i in range(3):
            self.post_upsert(make_envelope({"body": f"n{i}"}))
        b = self.desk("GET", "/desktop/pull?limit=2")[1]
        self.assertEqual((len(b["ops"]), b["more"]), (2, True))
        self.assertEqual(self.desk("GET", "/desktop/pull?limit=0")[0], 400)
        self.assertEqual(self.desk("GET", "/desktop/pull?limit=x")[0], 400)

    def test_ack_path_validation(self):
        env = make_envelope({"body": "p"})
        op = str(uuid.uuid4())
        self.post_upsert(env, op)
        for bad_path in ("../etc/passwd", "/abs.md", "C:/x.md", "a/./b.md"):
            res = self.desk("POST", "/desktop/ack", body={"acks": [{"opId": op, "state": "landed", "revision": 1,
                                                                    "digest": env["digest"], "blockHash": "a" * 64, "path": bad_path}]})[1]
            self.assertEqual(res["results"][0]["error"], "invalid-ack", bad_path)
        res = self.desk("POST", "/desktop/ack", body={"acks": [{"opId": str(uuid.uuid4()), "state": "landed"}]})[1]
        self.assertEqual(res["results"][0]["error"], "op-not-found")
        self.assertEqual(self.desk("POST", "/desktop/ack", body={"acks": []})[0], 400)


class ProjectsAndGcTests(RelayTestBase):
    def test_projects_roundtrip(self):
        b = self.dev("GET", "/meta/projects")[1]
        self.assertEqual((b["projects"], b["updatedAt"]), ([], None))
        s, b, _ = self.desk("PUT", "/meta/projects", body={"projects": [{"slug": "工作台", "title": "Personal Workbench"}, {"slug": "Sid"}]})
        self.assertEqual((s, b["count"]), (200, 2))
        b = self.dev("GET", "/meta/projects")[1]
        self.assertEqual(b["projects"], [{"slug": "工作台", "title": "Personal Workbench"}, {"slug": "Sid"}])
        self.assertIsNotNone(b["etag"])
        for bad_slug in ("有 空格", "#工作台", "a[b]", ""):
            self.assertEqual(self.desk("PUT", "/meta/projects", body={"projects": [{"slug": bad_slug}]})[0], 400, bad_slug)
        self.assertEqual(self.desk("PUT", "/meta/projects", body={"projects": [{"slug": "a"}, {"slug": "a"}]})[0], 400)
        self.assertEqual(self.store.clear_projects()["cleared"], 1)

    def test_gc_expires_old_ops_and_orphans(self):
        data = os.urandom(500)
        self.upload(data)
        env = make_envelope({"body": "old", "attachments": [att(data)]})
        op = str(uuid.uuid4())
        self.post_upsert(env, op)
        orphan = os.urandom(300)
        self.upload(orphan)
        self.clock.t += 2 * 3600
        res = self.store.gc()
        self.assertEqual(res["blobsRemoved"], 0)  # orphan still within 24h, queued blob active
        self.clock.t += 25 * 3600
        res = self.store.gc()
        self.assertEqual(res["blobsRemoved"], 1)  # orphan gone
        self.assertEqual(self.blob_files(), [att(data)["hash"]])
        self.clock.t += 31 * 86400
        res = self.store.gc()
        self.assertEqual((res["expired"], res["blobsRemoved"]), (1, 1))
        self.assertEqual(self.dev("GET", f"/ops/status?ids={op}")[1]["ops"][0]["state"], "expired")
        self.assertEqual(self.blob_files(), [])
        self.clock.t += 31 * 86400
        self.assertEqual(self.store.gc()["pruned"], 1)
        self.assertEqual(self.dev("GET", f"/ops/status?ids={op}")[1]["unknown"], [op])

    def test_keep_terminal_cap(self):
        ids = []
        for i in range(8):
            env = make_envelope({"body": f"t{i}"})
            op = str(uuid.uuid4())
            self.post_upsert(env, op)
            ids.append((op, env))
            self.clock.t += 1
        self.desk("GET", "/desktop/pull?limit=50")
        acks = [{"opId": op, "state": "landed", "revision": 1, "digest": env["digest"], "blockHash": "a" * 64} for op, env in ids]
        self.desk("POST", "/desktop/ack", body={"acks": acks})
        self.assertEqual(self.store.gc()["pruned"], 3)
        self.assertEqual(sum(self.store.stats()["ops"].values()), 5)

    def test_purge_device(self):
        data = os.urandom(200)
        self.upload(data)
        self.post_upsert(make_envelope({"body": "e2e", "attachments": [att(data)]}), device="relay-e2e-check")
        self.post_upsert(make_envelope({"body": "keep"}), device="my-phone")
        res = self.store.purge_device("relay-e2e-check")
        self.assertEqual(res, {"opsRemoved": 1, "blobsRemoved": 1})
        self.assertEqual(self.store.stats()["ops"], {"queued": 1})


@unittest.skipUnless(shutil.which("node") and CORE_CJS.is_file(), "node or core.cjs unavailable")
class CrossLanguageDigestTests(unittest.TestCase):
    """Envelopes built by desktop core.cjs must validate here byte-for-byte, and vice versa."""

    SCRIPT = r"""
const core=require(process.argv[2]);
const input=JSON.parse(require('fs').readFileSync(0,'utf8'));
const out={built:[],validated:[]};
for(const c of input.build){const prev=c.previous?core.envelope(c.id,c.previous.payload,null):null;
  const first=c.previous?{...prev}:null;
  const e=core.envelope(c.id,c.payload,first);out.built.push(first?[first,e]:[e]);}
for(const e of input.validate){try{core.validate(e);core.block(e);out.validated.push(true);}catch(err){out.validated.push(String(err.message));}}
process.stdout.write(JSON.stringify(out));
"""

    def run_node(self, data):
        with tempfile.NamedTemporaryFile("w", suffix=".cjs", delete=False, encoding="utf-8") as fh:
            fh.write(self.SCRIPT)
            script = fh.name
        try:
            proc = subprocess.run(["node", script, str(CORE_CJS)], input=json.dumps(data, ensure_ascii=False).encode("utf-8"),
                                  capture_output=True, timeout=30, check=True)
        finally:
            os.unlink(script)
        return json.loads(proc.stdout.decode("utf-8"))

    def test_parity(self):
        tricky = "引号\"反斜杠\\ 制表\t 换行\n emoji 😀👍🏽 \u2028分隔\u2029 控制\x01\x1f 斜杠/ <tag>"
        cases = [
            {"id": str(uuid.uuid4()), "payload": {"type": "note", "body": "  手机速记\r\n第二行  "}},
            {"id": str(uuid.uuid4()), "payload": {"type": "idea", "body": tricky, "tags": "#AI，工作流 #移动"}},
            {"id": str(uuid.uuid4()), "payload": {"type": "task", "body": "交作业", "due": "2026-11-20", "project": "#项目/工作台"}},
            {"id": str(uuid.uuid4()), "payload": {"type": "link", "body": "", "source": "https://example.com/a?b=c",
                                                  "attachments": [att(b"img", ".png", "截图 [1].png")]}},
            {"id": str(uuid.uuid4()), "payload": {"type": "diary", "body": "改后"},
             "previous": {"payload": {"type": "diary", "body": "改前"}}},
        ]
        out = self.run_node({"build": cases, "validate": []})
        for chain in out["built"]:
            for e in chain:
                clean, digest = rs.canonical_envelope(e)
                self.assertEqual(digest, e["digest"])
        py_envs = [make_envelope({"type": "issue", "body": tricky}), make_envelope({"type": "note", "body": "x", "project": "Sid",
                                                                                   "attachments": [att(b"zz")]})]
        res = self.run_node({"build": [], "validate": py_envs})
        self.assertEqual(res["validated"], [True, True])


if __name__ == "__main__":
    unittest.main(verbosity=1)

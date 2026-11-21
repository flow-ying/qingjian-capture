#!/usr/bin/env python3
"""Mobile capture relay (protocol v1) for Qingjian mobile -> desktop bridge.

Zero third-party dependencies. Listens on 127.0.0.1 behind Caddy at /mobile-capture/v1/*.
Mobile devices enqueue capture operations (upsert/delete) plus content-addressed attachments;
the desktop Qingjian process pulls, lands them through desktop-capture-bridge and acks.
Attachments are physically removed as soon as no active operation references them.
See docs/protocol.md for the authoritative contract.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit

TOKYO = timezone(timedelta(hours=9), "JST")  # Japan has no DST
PROTOCOL_VERSION = 1
SERVICE_VERSION = "1.0.0"
BASE = "/mobile-capture/v1"

TYPES = ("note", "diary", "task", "issue", "idea", "link")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
OP_ID_RE = UUID_RE
HEX64_RE = re.compile(r"^[a-f0-9]{64}$")
EXT_RE = re.compile(r"^\.[a-z0-9]{1,8}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEVICE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
PROJECT_BAD_RE = re.compile(r"[\s#\[\]|<>]")
IDEA_TAGS_RE = re.compile(r"^#[^\s#\[\]<>]+(?: #[^\s#\[\]<>]+){0,2}$")
# JavaScript String.prototype.trim() whitespace set (WhiteSpace + LineTerminator).
JS_WS = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

ACTIVE = ("queued", "pulled")
TERMINAL = ("landed", "deleted", "conflict", "failed", "cancelled", "expired")
ACK_STATES = {"upsert": ("landed", "conflict", "failed"), "delete": ("deleted", "conflict", "failed")}

DEVICE, DESKTOP = "device", "desktop"


class RelayError(Exception):
    def __init__(self, status: int, code: str, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra or {}


def bad(code: str, message: str) -> RelayError:
    return RelayError(400, code, message)


# ---------------------------------------------------------------------------
# Envelope canonicalisation (mirrors desktop-capture-orb standalone/core.cjs)
# ---------------------------------------------------------------------------

def js_len(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def stable_json(value) -> str:
    """Equivalent of JavaScript JSON.stringify for the plain objects used by core.cjs."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256_text(value: str) -> str:
    try:
        raw = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise bad("invalid-text", "Text contains lone surrogate code points") from exc
    return hashlib.sha256(raw).hexdigest()


def _canon_text(value, max_len: int, field: str, *, required: bool = False) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or "\x00" in value or js_len(value) > max_len:
        raise bad("invalid-payload", f"{field} must be a string of at most {max_len} UTF-16 units")
    if "\r" in value or value != value.strip(JS_WS):
        raise bad("not-normalized", f"{field} must be produced by core.envelope() (LF line endings, trimmed)")
    return value


def _valid_date(value) -> bool:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _is_int(value, lo: int, hi: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and lo <= value <= hi


def canonical_payload(p) -> dict:
    if not isinstance(p, dict) or p.get("type") not in TYPES:
        raise bad("invalid-payload", "payload.type must be one of " + ",".join(TYPES))
    out = {
        "type": p["type"],
        "body": _canon_text(p.get("body"), 50000, "payload.body"),
        "source": _canon_text(p.get("source"), 4000, "payload.source"),
        "thought": _canon_text(p.get("thought"), 20000, "payload.thought"),
        "due": _canon_text(p.get("due"), 10, "payload.due"),
        "tags": _canon_text(p.get("tags"), 200, "payload.tags"),
        "attachments": [],
    }
    proj = p.get("project")
    if proj is not None and proj != "":
        proj = _canon_text(proj, 60, "payload.project")
        if not proj or proj.startswith("#") or PROJECT_BAD_RE.search(proj):
            raise bad("invalid-payload", "payload.project must be a bare slug without #, spaces or brackets")
    if out["due"] and (out["type"] != "task" or not _valid_date(out["due"])):
        raise bad("invalid-payload", "payload.due is only valid for task with YYYY-MM-DD")
    if out["type"] == "idea" and not IDEA_TAGS_RE.fullmatch(out["tags"]):
        raise bad("invalid-payload", "idea requires 1-3 normalized tags like '#a #b'")
    atts = p.get("attachments", [])
    if not isinstance(atts, list) or len(atts) > 20:
        raise bad("invalid-payload", "payload.attachments must be a list of at most 20 items")
    for a in atts:
        if not isinstance(a, dict) or not isinstance(a.get("id"), str) or not UUID_RE.fullmatch(a["id"]):
            raise bad("invalid-attachment", "attachment.id must be a UUID v4")
        if not isinstance(a.get("ext"), str) or not EXT_RE.fullmatch(a["ext"]):
            raise bad("invalid-attachment", "attachment.ext must match ^\\.[a-z0-9]{1,8}$")
        if not isinstance(a.get("hash"), str) or not HEX64_RE.fullmatch(a["hash"]):
            raise bad("invalid-attachment", "attachment.hash must be lowercase SHA-256 hex")
        if not _is_int(a.get("size"), 1, 25 * 1024 * 1024):
            raise bad("invalid-attachment", "attachment.size must be an integer in bytes")
        out["attachments"].append({
            "id": a["id"],
            "name": _canon_text(a.get("name"), 240, "attachment.name", required=True),
            "ext": a["ext"],
            "hash": a["hash"],
            "size": a["size"],
        })
    if proj:
        out["project"] = proj  # core.cjs spreads project after attachments
    if not (out["body"] or out["source"] or out["thought"] or out["attachments"]):
        raise bad("invalid-payload", "capture has no content")
    return out


def canonical_envelope(e) -> tuple[dict, str]:
    """Return (clean envelope without digest, digest). Raises RelayError when invalid."""
    if not isinstance(e, dict):
        raise bad("invalid-envelope", "envelope must be an object")
    if not isinstance(e.get("id"), str) or not UUID_RE.fullmatch(e["id"]):
        raise bad("invalid-envelope", "envelope.id must be a UUID v4")
    if not _is_int(e.get("revision"), 1, 10000):
        raise bad("invalid-envelope", "envelope.revision must be an integer 1..10000")
    if not _valid_date(e.get("date")):
        raise bad("invalid-envelope", "envelope.date must be YYYY-MM-DD")
    created = e.get("createdAt")
    try:
        if not isinstance(created, str) or len(created) > 40:
            raise ValueError
        datetime.fromisoformat(created.replace("Z", "+00:00"))
    except ValueError as exc:
        raise bad("invalid-envelope", "envelope.createdAt must be an ISO-8601 timestamp") from exc
    prev = e.get("previousDigest", "missing")
    if e["revision"] == 1 and prev is not None:
        raise bad("invalid-envelope", "revision 1 requires previousDigest=null")
    if e["revision"] > 1 and not (isinstance(prev, str) and HEX64_RE.fullmatch(prev)):
        raise bad("invalid-envelope", "revision>1 requires previousDigest SHA-256 hex")
    clean = {
        "id": e["id"],
        "revision": e["revision"],
        "date": e["date"],
        "createdAt": created,
        "previousDigest": prev,
        "payload": canonical_payload(e.get("payload")),
    }
    digest = sha256_text(stable_json(clean))
    if e.get("digest") != digest:
        raise bad("digest-mismatch", "envelope.digest does not match sha256(JSON.stringify(clean envelope))")
    return clean, digest


# ---------------------------------------------------------------------------
# Configuration & storage
# ---------------------------------------------------------------------------

class RelayConfig:
    def __init__(
        self,
        *,
        state_dir: Path,
        device_token: str = "",
        desktop_token: str = "",
        host: str = "127.0.0.1",
        port: int = 8941,
        max_blob_bytes: int = 8 * 1024 * 1024,
        max_store_bytes: int = 256 * 1024 * 1024,
        max_json_bytes: int = 512 * 1024,
        max_active_ops: int = 1000,
        keep_terminal: int = 500,
        retention_days: int = 30,
        orphan_blob_hours: int = 24,
        gc_interval_sec: int = 600,
        require_tokens: bool = True,
        now_fn=None,
    ):
        if require_tokens:
            for name, tok in (("MOBILE_CAPTURE_DEVICE_TOKEN", device_token), ("MOBILE_CAPTURE_DESKTOP_TOKEN", desktop_token)):
                if not tok or len(tok) < 32:
                    raise ValueError(f"{name} must be at least 32 characters")
            if device_token == desktop_token:
                raise ValueError("device and desktop tokens must differ")
        self.device_token = device_token.encode("utf-8")
        self.desktop_token = desktop_token.encode("utf-8")
        self.state_dir = Path(state_dir)
        self.host, self.port = host, port
        self.max_blob_bytes = max_blob_bytes
        self.max_store_bytes = max_store_bytes
        self.max_json_bytes = max_json_bytes
        self.max_active_ops = max_active_ops
        self.keep_terminal = keep_terminal
        self.retention_sec = retention_days * 86400
        self.orphan_blob_sec = orphan_blob_hours * 3600
        self.gc_interval_sec = gc_interval_sec
        self.now_fn = now_fn or time.time

    @classmethod
    def from_env(cls, *, require_tokens: bool = True, state_dir: str | None = None) -> "RelayConfig":
        env = os.environ.get
        return cls(
            state_dir=Path(state_dir or env("MOBILE_CAPTURE_STATE_DIR", "/var/lib/qingjian-relay")),
            device_token=env("MOBILE_CAPTURE_DEVICE_TOKEN", "").strip(),
            desktop_token=env("MOBILE_CAPTURE_DESKTOP_TOKEN", "").strip(),
            host=env("MOBILE_CAPTURE_HOST", "127.0.0.1"),
            port=int(env("MOBILE_CAPTURE_PORT", "8941")),
            max_blob_bytes=int(env("MOBILE_CAPTURE_MAX_BLOB_BYTES", str(8 * 1024 * 1024))),
            max_store_bytes=int(env("MOBILE_CAPTURE_MAX_STORE_BYTES", str(256 * 1024 * 1024))),
            require_tokens=require_tokens,
        )


def iso(ts: float | None) -> str | None:
    return None if ts is None else datetime.fromtimestamp(ts, TOKYO).isoformat(timespec="seconds")


SCHEMA = """
CREATE TABLE IF NOT EXISTS ops(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT UNIQUE NOT NULL,
  body_hash TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT,
  spec TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  result TEXT,
  created_at REAL NOT NULL,
  pulled_at REAL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_state ON ops(state, seq);
CREATE INDEX IF NOT EXISTS ops_capture ON ops(capture_id, seq);
CREATE TABLE IF NOT EXISTS op_blobs(op_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(op_id, hash));
CREATE INDEX IF NOT EXISTS op_blobs_hash ON op_blobs(hash);
CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, touched_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL);
"""


class RelayStore:
    def __init__(self, cfg: RelayConfig):
        self.cfg = cfg
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        self.blob_dir = cfg.state_dir / "blobs"
        self.blob_dir.mkdir(exist_ok=True)
        for p in (cfg.state_dir, self.blob_dir):
            if p.is_symlink():
                raise ValueError(f"{p} must not be a symlink")
        self.db = sqlite3.connect(str(cfg.state_dir / "relay.sqlite3"), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()
        self.reserved = 0

    # -- helpers -----------------------------------------------------------
    def _tx(self):
        store = self

        class _Tx:
            def __enter__(self_inner):
                store.db.execute("BEGIN IMMEDIATE")

            def __exit__(self_inner, exc_type, exc, tb):
                store.db.execute("ROLLBACK" if exc_type else "COMMIT")
                return False

        return _Tx()

    def _blob_path(self, h: str) -> Path:
        if not HEX64_RE.fullmatch(h):
            raise bad("invalid-hash", "hash must be lowercase SHA-256 hex")
        return self.blob_dir / h

    def _store_bytes(self) -> int:
        return int(self.db.execute("SELECT COALESCE(SUM(size),0) FROM blobs").fetchone()[0])

    def _op_view(self, row) -> dict:
        view = {
            "opId": row["op_id"],
            "seq": row["seq"],
            "deviceId": row["device_id"],
            "kind": row["kind"],
            "captureId": row["capture_id"],
            "revision": row["revision"],
            "state": row["state"],
            "createdAt": iso(row["created_at"]),
            "updatedAt": iso(row["updated_at"]),
        }
        if row["digest"]:
            view["digest"] = row["digest"]
        if row["error"]:
            view["error"] = row["error"]
        if row["result"]:
            view["result"] = json.loads(row["result"])
        return view

    def _purge_blobs(self, hashes=None, *, force_unreferenced_age: bool = False) -> int:
        """Delete blobs without active references.

        hashes given  -> only consider these (immediate purge after terminal transition)
        hashes None   -> periodic sweep: also drop never-referenced uploads older than orphan window
        """
        now = self.cfg.now_fn()
        if hashes is None:
            rows = self.db.execute("SELECT hash, touched_at FROM blobs").fetchall()
        else:
            hashes = list(set(hashes))
            if not hashes:
                return 0
            marks = ",".join("?" * len(hashes))
            rows = self.db.execute(f"SELECT hash, touched_at FROM blobs WHERE hash IN ({marks})", hashes).fetchall()
        removed = 0
        for r in rows:
            h = r["hash"]
            active = self.db.execute(
                "SELECT 1 FROM op_blobs ob JOIN ops o ON o.op_id=ob.op_id WHERE ob.hash=? AND o.state IN ('queued','pulled') LIMIT 1",
                (h,),
            ).fetchone()
            if active:
                continue
            if hashes is None and not force_unreferenced_age and r["touched_at"] > now - self.cfg.orphan_blob_sec:
                continue
            try:
                (self.blob_dir / h).unlink()
            except FileNotFoundError:
                pass
            self.db.execute("DELETE FROM blobs WHERE hash=?", (h,))
            removed += 1
        return removed

    # -- attachments -------------------------------------------------------
    def put_blob(self, h: str, stream, length: int) -> dict:
        target = self._blob_path(h)
        if length <= 0:
            raise bad("empty-body", "attachment body must not be empty")
        if length > self.cfg.max_blob_bytes:
            raise RelayError(413, "attachment-too-large", f"attachment exceeds {self.cfg.max_blob_bytes} bytes")
        with self.lock:
            row = self.db.execute("SELECT size FROM blobs WHERE hash=?", (h,)).fetchone()
            exists = bool(row) and target.is_file()
            if exists:
                self.db.execute("UPDATE blobs SET touched_at=? WHERE hash=?", (self.cfg.now_fn(), h))
            else:
                if self._store_bytes() + self.reserved + length > self.cfg.max_store_bytes:
                    raise RelayError(507, "storage-quota-exceeded", "relay attachment storage is full; wait for desktop to land queued items")
                self.reserved += length
        if exists:
            _drain(stream, length)
            return {"ok": True, "hash": h, "size": row["size"], "already": True}
        tmp = self.blob_dir / f".{h}.{secrets.token_hex(6)}.tmp"
        try:
            hasher = hashlib.sha256()
            got = 0
            with tmp.open("xb") as fh:
                while got < length:
                    chunk = stream.read(min(65536, length - got))
                    if not chunk:
                        break
                    hasher.update(chunk)
                    fh.write(chunk)
                    got += len(chunk)
                fh.flush()
                os.fsync(fh.fileno())
            if got != length:
                raise bad("incomplete-body", "attachment body truncated")
            if hasher.hexdigest() != h:
                raise bad("hash-mismatch", "attachment SHA-256 does not match URL hash")
            os.chmod(tmp, 0o600)
            with self.lock:
                os.replace(tmp, target)
                self.db.execute(
                    "INSERT INTO blobs(hash,size,touched_at) VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET size=excluded.size, touched_at=excluded.touched_at",
                    (h, length, self.cfg.now_fn()),
                )
            return {"ok": True, "hash": h, "size": length, "already": False}
        finally:
            with self.lock:
                self.reserved -= length
            if tmp.exists():
                tmp.unlink()

    def open_blob_for_desktop(self, h: str):
        path = self._blob_path(h)
        with self.lock:
            active = self.db.execute(
                "SELECT 1 FROM op_blobs ob JOIN ops o ON o.op_id=ob.op_id WHERE ob.hash=? AND o.state IN ('queued','pulled') LIMIT 1",
                (h,),
            ).fetchone()
            if not active or not path.is_file():
                raise RelayError(404, "attachment-not-found", "attachment not queued (already landed, purged or never uploaded)")
            return path.open("rb"), path.stat().st_size

    # -- operations --------------------------------------------------------
    def submit_op(self, body) -> tuple[int, dict]:
        if not isinstance(body, dict):
            raise bad("invalid-op", "body must be an object")
        op_id, device_id, kind = body.get("opId"), body.get("deviceId"), body.get("kind")
        if not isinstance(op_id, str) or not OP_ID_RE.fullmatch(op_id):
            raise bad("invalid-op", "opId must be a UUID v4")
        if not isinstance(device_id, str) or not DEVICE_RE.fullmatch(device_id):
            raise bad("invalid-op", "deviceId must match ^[a-z0-9][a-z0-9-]{0,39}$")
        if kind == "upsert":
            clean, digest = canonical_envelope(body.get("envelope"))
            spec = {**clean, "digest": digest}
            capture_id, revision = clean["id"], clean["revision"]
            hashes = {a["hash"]: a["size"] for a in clean["payload"]["attachments"]}
        elif kind == "delete":
            capture_id, revision, digest = body.get("captureId"), body.get("targetRevision"), body.get("expectedDigest")
            if not isinstance(capture_id, str) or not UUID_RE.fullmatch(capture_id):
                raise bad("invalid-op", "captureId must be a UUID v4")
            if not _is_int(revision, 1, 10000):
                raise bad("invalid-op", "targetRevision must be an integer 1..10000")
            if not isinstance(digest, str) or not HEX64_RE.fullmatch(digest):
                raise bad("invalid-op", "expectedDigest must be SHA-256 hex")
            spec = {"captureId": capture_id, "targetRevision": revision, "expectedDigest": digest}
            hashes = {}
        else:
            raise bad("invalid-op", "kind must be upsert or delete")
        body_hash = sha256_text(stable_json({"deviceId": device_id, "kind": kind, "spec": spec}))
        now = self.cfg.now_fn()
        with self.lock, self._tx():
            prior = self.db.execute("SELECT * FROM ops WHERE op_id=?", (op_id,)).fetchone()
            if prior:
                if prior["body_hash"] != body_hash:
                    raise RelayError(409, "op-id-reused", "opId already used for a different operation")
                return 200, {"ok": True, "replayed": True, "op": self._op_view(prior)}
            active_count = self.db.execute("SELECT COUNT(*) FROM ops WHERE state IN ('queued','pulled')").fetchone()[0]
            if active_count >= self.cfg.max_active_ops:
                raise RelayError(429, "queue-full", "too many pending operations; wait for desktop")
            rows = self.db.execute("SELECT * FROM ops WHERE capture_id=? ORDER BY seq", (capture_id,)).fetchall()
            live = [r for r in rows if r["state"] in ACTIVE or r["state"] in ("landed", "deleted")]
            if kind == "upsert":
                if any(r["kind"] == "delete" and r["state"] in ACTIVE + ("deleted",) for r in rows):
                    raise RelayError(409, "capture-deleted", "capture has a pending or completed delete")
                for r in live:
                    if r["kind"] == "upsert" and r["revision"] == revision:
                        code = "duplicate-revision" if r["digest"] == digest else "revision-conflict"
                        raise RelayError(409, code, "revision already queued or landed", {"existingOpId": r["op_id"]})
                for h, size in hashes.items():
                    b = self.db.execute("SELECT size FROM blobs WHERE hash=?", (h,)).fetchone()
                    if not b or b["size"] != size or not (self.blob_dir / h).is_file():
                        raise RelayError(409, "attachment-missing", "upload attachment first via PUT /attachments/{hash}", {"hash": h})
                state, result, cancelled = "queued", None, []
            else:
                cancellable = bool(rows) and all(r["state"] in ("queued", "cancelled") for r in rows) and any(
                    r["state"] == "queued" and r["kind"] == "upsert" and r["revision"] == 1 for r in rows
                )
                if cancellable:
                    cancelled = [r["op_id"] for r in rows if r["state"] == "queued"]
                    state, result = "deleted", {"resolvedBy": "relay", "cancelledOpIds": cancelled}
                else:
                    if any(r["kind"] == "delete" and r["state"] in ACTIVE for r in rows):
                        raise RelayError(409, "delete-pending", "a delete for this capture is already pending")
                    state, result, cancelled = "queued", None, []
            self.db.execute(
                "INSERT INTO ops(op_id,body_hash,device_id,kind,capture_id,revision,digest,spec,state,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (op_id, body_hash, device_id, kind, capture_id, revision, digest, stable_json(spec), state,
                 stable_json(result) if result else None, now, now),
            )
            for h in hashes:
                self.db.execute("INSERT OR IGNORE INTO op_blobs(op_id,hash) VALUES(?,?)", (op_id, h))
            purge = []
            for cid in cancelled:
                self.db.execute(
                    "UPDATE ops SET state='cancelled', error='cancelled-by-device-before-pull', updated_at=? WHERE op_id=?",
                    (now, cid),
                )
                purge += [r["hash"] for r in self.db.execute("SELECT hash FROM op_blobs WHERE op_id=?", (cid,))]
            self._purge_blobs(purge)
            row = self.db.execute("SELECT * FROM ops WHERE op_id=?", (op_id,)).fetchone()
            return 201, {"ok": True, "replayed": False, "op": self._op_view(row)}

    def status(self, op_ids: list[str]) -> dict:
        if not op_ids or len(op_ids) > 100 or any(not OP_ID_RE.fullmatch(i) for i in op_ids):
            raise bad("invalid-query", "ids must be 1-100 comma separated opId UUIDs")
        with self.lock:
            marks = ",".join("?" * len(op_ids))
            rows = self.db.execute(f"SELECT * FROM ops WHERE op_id IN ({marks})", op_ids).fetchall()
            found = {r["op_id"]: self._op_view(r) for r in rows}
        return {"ok": True, "ops": [found[i] for i in op_ids if i in found], "unknown": [i for i in op_ids if i not in found]}

    def pull(self, limit: int) -> dict:
        now = self.cfg.now_fn()
        with self.lock, self._tx():
            rows = self.db.execute(
                "SELECT * FROM ops WHERE state IN ('queued','pulled') ORDER BY seq LIMIT ?", (limit + 1,)
            ).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            ids = [r["op_id"] for r in rows if r["state"] == "queued"]
            for i in ids:
                self.db.execute("UPDATE ops SET state='pulled', pulled_at=?, updated_at=? WHERE op_id=?", (now, now, i))
            out = []
            for r in rows:
                v = self._op_view(r)
                if r["op_id"] in ids:
                    v["state"] = "pulled"
                spec = json.loads(r["spec"])
                if r["kind"] == "upsert":
                    v["envelope"] = spec
                else:
                    v["target"] = spec
                out.append(v)
        return {"ok": True, "ops": out, "more": more}

    def ack(self, body) -> dict:
        acks = body.get("acks") if isinstance(body, dict) else None
        if not isinstance(acks, list) or not 1 <= len(acks) <= 100:
            raise bad("invalid-ack", "acks must be a list of 1-100 items")
        now = self.cfg.now_fn()
        results = []
        with self.lock, self._tx():
            purge = []
            for a in acks:
                try:
                    results.append(self._ack_one(a, now, purge))
                except RelayError as err:
                    results.append({"opId": a.get("opId") if isinstance(a, dict) else None, "ok": False, "error": err.code, "message": err.message})
            self._purge_blobs(purge)
        return {"ok": True, "results": results}

    def _ack_one(self, a, now: float, purge: list) -> dict:
        if not isinstance(a, dict) or not isinstance(a.get("opId"), str) or not OP_ID_RE.fullmatch(a["opId"]):
            raise bad("invalid-ack", "opId must be a UUID v4")
        row = self.db.execute("SELECT * FROM ops WHERE op_id=?", (a["opId"],)).fetchone()
        if not row:
            raise RelayError(404, "op-not-found", "unknown opId")
        state = a.get("state")
        if state not in ACK_STATES[row["kind"]]:
            raise bad("invalid-ack", f"state for {row['kind']} must be one of {ACK_STATES[row['kind']]}")
        result = {}
        for key in ("revision",):
            if a.get(key) is not None:
                if not _is_int(a[key], 1, 10000):
                    raise bad("invalid-ack", "revision must be an integer")
                result[key] = a[key]
        for key in ("digest", "blockHash"):
            if a.get(key) is not None:
                if not isinstance(a[key], str) or not HEX64_RE.fullmatch(a[key]):
                    raise bad("invalid-ack", f"{key} must be SHA-256 hex")
                result[key] = a[key]
        if a.get("path") is not None:
            p = a["path"]
            if (not isinstance(p, str) or not 1 <= len(p) <= 300 or p.startswith(("/", "\\")) or "\x00" in p
                    or ":" in p or any(seg in ("..", ".") for seg in re.split(r"[\\/]", p))):
                raise bad("invalid-ack", "path must be a Vault-relative path")
            result["path"] = p
        error = a.get("error")
        if error is not None and (not isinstance(error, str) or len(error) > 500):
            raise bad("invalid-ack", "error must be a string of at most 500 chars")
        if state == "landed":
            if result.get("revision") != row["revision"] or result.get("digest") != row["digest"] or "blockHash" not in result:
                raise bad("invalid-ack", "landed ack requires matching revision, digest and blockHash")
        if state in ("conflict", "failed") and not error:
            raise bad("invalid-ack", "conflict/failed ack requires error text")
        if row["state"] in TERMINAL:
            if row["state"] == state:
                return {"opId": row["op_id"], "ok": True, "state": state, "replayed": True}
            raise RelayError(409, "already-terminal", f"op already {row['state']}")
        self.db.execute(
            "UPDATE ops SET state=?, error=?, result=?, updated_at=? WHERE op_id=?",
            (state, error, stable_json(result) if result else None, now, row["op_id"]),
        )
        purge += [r["hash"] for r in self.db.execute("SELECT hash FROM op_blobs WHERE op_id=?", (row["op_id"],))]
        return {"opId": row["op_id"], "ok": True, "state": state, "replayed": False}

    # -- metadata ----------------------------------------------------------
    def put_projects(self, body) -> dict:
        projects = body.get("projects") if isinstance(body, dict) else None
        if not isinstance(projects, list) or len(projects) > 200:
            raise bad("invalid-projects", "projects must be a list of at most 200 items")
        clean, seen = [], set()
        for p in projects:
            if not isinstance(p, dict):
                raise bad("invalid-projects", "each project must be an object")
            slug, title = p.get("slug"), p.get("title", "")
            if (not isinstance(slug, str) or not 1 <= js_len(slug) <= 60 or slug.startswith("#")
                    or PROJECT_BAD_RE.search(slug) or "\x00" in slug):
                raise bad("invalid-projects", "slug must be a bare project short name without spaces/#/brackets")
            if not isinstance(title, str) or js_len(title) > 120 or "\x00" in title:
                raise bad("invalid-projects", "title must be a string of at most 120 chars")
            if slug in seen:
                raise bad("invalid-projects", f"duplicate slug {slug}")
            seen.add(slug)
            item = {"slug": slug}
            if title.strip():
                item["title"] = title.strip()
            clean.append(item)
        raw = stable_json(clean)
        now = self.cfg.now_fn()
        with self.lock:
            self.db.execute(
                "INSERT INTO meta(key,value,updated_at) VALUES('projects',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (raw, now),
            )
        return {"ok": True, "count": len(clean), "etag": sha256_text(raw)[:16], "updatedAt": iso(now)}

    def get_projects(self) -> dict:
        with self.lock:
            row = self.db.execute("SELECT value, updated_at FROM meta WHERE key='projects'").fetchone()
        if not row:
            return {"ok": True, "projects": [], "etag": None, "updatedAt": None}
        return {"ok": True, "projects": json.loads(row["value"]), "etag": sha256_text(row["value"])[:16], "updatedAt": iso(row["updated_at"])}

    # -- maintenance -------------------------------------------------------
    def gc(self) -> dict:
        now = self.cfg.now_fn()
        with self.lock, self._tx():
            cutoff = now - self.cfg.retention_sec
            expired = self.db.execute(
                "UPDATE ops SET state='expired', error='not-landed-within-retention', updated_at=? WHERE state IN ('queued','pulled') AND created_at<?",
                (now, cutoff),
            ).rowcount
            old = [r[0] for r in self.db.execute(
                "SELECT op_id FROM ops WHERE state NOT IN ('queued','pulled') AND updated_at<?", (cutoff,))]
            extra = [r[0] for r in self.db.execute(
                "SELECT op_id FROM ops WHERE state NOT IN ('queued','pulled') ORDER BY updated_at DESC, seq DESC LIMIT -1 OFFSET ?",
                (self.cfg.keep_terminal,))]
            drop = list(set(old + extra))
            for oid in drop:
                self.db.execute("DELETE FROM op_blobs WHERE op_id=?", (oid,))
                self.db.execute("DELETE FROM ops WHERE op_id=?", (oid,))
            blobs_removed = self._purge_blobs(None)
        tmp_removed = 0
        for p in self.blob_dir.glob(".*.tmp"):
            try:
                if p.stat().st_mtime < now - 3600:
                    p.unlink()
                    tmp_removed += 1
            except FileNotFoundError:
                pass
        return {"expired": expired, "pruned": len(drop), "blobsRemoved": blobs_removed, "tmpRemoved": tmp_removed}

    def stats(self) -> dict:
        with self.lock:
            counts = {r[0]: r[1] for r in self.db.execute("SELECT state, COUNT(*) FROM ops GROUP BY state")}
            blobs = self.db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM blobs").fetchone()
            files = [p for p in self.blob_dir.iterdir() if p.is_file() and not p.name.startswith(".")]
        return {"ops": counts, "blobCount": blobs[0], "blobBytes": blobs[1], "blobFiles": len(files),
                "maxStoreBytes": self.cfg.max_store_bytes, "projectsSet": self.get_projects()["updatedAt"] is not None}

    def purge_device(self, device_id: str) -> dict:
        if not DEVICE_RE.fullmatch(device_id):
            raise ValueError("invalid device id")
        with self.lock, self._tx():
            ids = [r[0] for r in self.db.execute("SELECT op_id FROM ops WHERE device_id=?", (device_id,))]
            hashes = []
            for oid in ids:
                hashes += [r[0] for r in self.db.execute("SELECT hash FROM op_blobs WHERE op_id=?", (oid,))]
                self.db.execute("DELETE FROM op_blobs WHERE op_id=?", (oid,))
                self.db.execute("DELETE FROM ops WHERE op_id=?", (oid,))
            removed = self._purge_blobs(hashes)
        return {"opsRemoved": len(ids), "blobsRemoved": removed}

    def clear_projects(self) -> dict:
        with self.lock:
            n = self.db.execute("DELETE FROM meta WHERE key='projects'").rowcount
        return {"cleared": n}


def _drain(stream, length: int) -> None:
    left = length
    while left > 0:
        chunk = stream.read(min(65536, left))
        if not chunk:
            break
        left -= len(chunk)


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

ROUTES = [
    # (method, regex, roles, handler-name)
    ("GET", re.compile(r"^/health$"), (DEVICE, DESKTOP), "health"),
    ("PUT", re.compile(r"^/attachments/([a-f0-9]{64})$"), (DEVICE,), "put_attachment"),
    ("POST", re.compile(r"^/ops$"), (DEVICE,), "post_op"),
    ("GET", re.compile(r"^/ops/status$"), (DEVICE, DESKTOP), "op_status"),
    ("GET", re.compile(r"^/meta/projects$"), (DEVICE, DESKTOP), "get_projects"),
    ("PUT", re.compile(r"^/meta/projects$"), (DESKTOP,), "put_projects"),
    ("GET", re.compile(r"^/desktop/pull$"), (DESKTOP,), "pull"),
    ("GET", re.compile(r"^/desktop/attachments/([a-f0-9]{64})$"), (DESKTOP,), "get_attachment"),
    ("POST", re.compile(r"^/desktop/ack$"), (DESKTOP,), "ack"),
]


def make_handler(cfg: RelayConfig, store: RelayStore):
    class RelayHandler(BaseHTTPRequestHandler):
        server_version = "MobileCaptureRelay/1.0"
        protocol_version = "HTTP/1.1"

        def setup(self):
            super().setup()
            self.request.settimeout(30.0)

        def log_message(self, format: str, *args) -> None:
            clean_path = urlsplit(getattr(self, "path", "/")).path
            status = str(args[1]) if len(args) >= 2 else "-"
            sys.stderr.write(f"[{datetime.now(TOKYO).isoformat(timespec='seconds')}] {self.command} {clean_path} -> {status}\n")
            sys.stderr.flush()

        def _send_json(self, status: int, payload: dict, extra: dict | None = None) -> None:
            body = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _role(self) -> str:
            auth = self.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                raise RelayError(401, "unauthorized", "Missing Bearer token")
            presented = auth[len("Bearer "):].strip().encode("utf-8")
            is_device = hmac.compare_digest(presented, cfg.device_token)
            is_desktop = hmac.compare_digest(presented, cfg.desktop_token)
            if is_device:
                return DEVICE
            if is_desktop:
                return DESKTOP
            raise RelayError(401, "unauthorized", "Invalid Bearer token")

        def _content_length(self, cap: int) -> int:
            raw = self.headers.get("Content-Length")
            if raw is None:
                raise RelayError(411, "length-required", "Content-Length header is required")
            try:
                n = int(raw)
            except ValueError as exc:
                raise bad("invalid-content-length", "Invalid Content-Length") from exc
            if n < 0:
                raise bad("invalid-content-length", "Invalid Content-Length")
            if n > cap:
                raise RelayError(413, "payload-too-large", f"Request exceeds {cap} bytes")
            return n

        def _json_body(self):
            n = self._content_length(cfg.max_json_bytes)
            if n == 0:
                raise bad("empty-body", "Request body must not be empty")
            raw = self.rfile.read(n)
            if len(raw) != n:
                raise bad("incomplete-body", "Request body truncated")
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise bad("invalid-json", "Body must be UTF-8 JSON") from exc

        def _dispatch(self, method: str) -> None:
            parsed = urlsplit(self.path)
            try:
                if not parsed.path.startswith(BASE + "/"):
                    raise RelayError(404, "not-found", "Not found")
                sub = parsed.path[len(BASE):]
                matches = [(m, rx.fullmatch(sub), roles, name) for m, rx, roles, name in ROUTES if rx.fullmatch(sub)]
                if not matches:
                    raise RelayError(404, "not-found", "Not found")
                chosen = next((x for x in matches if x[0] == method), None)
                if not chosen:
                    allow = ",".join(sorted({x[0] for x in matches}))
                    raise RelayError(405, "method-not-allowed", "Method not allowed", {"_allow": allow})
                role = self._role()
                if role not in chosen[2]:
                    raise RelayError(403, "forbidden-role", f"{role} token cannot call this endpoint")
                qs = parse_qs(parsed.query, keep_blank_values=True) if parsed.query else {}
                getattr(self, "h_" + chosen[3])(role, chosen[1], qs)
            except RelayError as err:
                extra = {}
                if err.status == 401:
                    extra["WWW-Authenticate"] = 'Bearer realm="mobile-capture"'
                if "_allow" in err.extra:
                    extra["Allow"] = err.extra.pop("_allow")
                self._send_json(err.status, {"ok": False, "error": err.code, "message": err.message, **err.extra}, extra)
            except Exception:  # pragma: no cover - defensive
                self._send_json(500, {"ok": False, "error": "internal-error"})

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_DELETE(self):
            self._dispatch("DELETE")

        def do_PATCH(self):
            self._dispatch("PATCH")

        def do_HEAD(self):
            self._dispatch("HEAD")

        def do_OPTIONS(self):
            self._dispatch("OPTIONS")

        # -- endpoint handlers ---------------------------------------------
        def h_health(self, role, m, qs):
            payload = {"ok": True, "service": "mobile-capture-relay", "version": SERVICE_VERSION,
                       "protocol": PROTOCOL_VERSION, "role": role, "time": iso(cfg.now_fn())}
            if role == DESKTOP:
                payload["stats"] = store.stats()
            self._send_json(200, payload)

        def h_put_attachment(self, role, m, qs):
            n = self._content_length(cfg.max_blob_bytes)
            if n == 0:
                raise bad("empty-body", "attachment body must not be empty")
            res = store.put_blob(m.group(1), self.rfile, n)
            self._send_json(200 if res["already"] else 201, res)

        def h_post_op(self, role, m, qs):
            status, res = store.submit_op(self._json_body())
            self._send_json(status, res)

        def h_op_status(self, role, m, qs):
            vals = qs.get("ids", [])
            if len(vals) != 1:
                raise bad("invalid-query", "ids query parameter required")
            self._send_json(200, store.status([i for i in vals[0].split(",") if i]))

        def h_get_projects(self, role, m, qs):
            self._send_json(200, store.get_projects())

        def h_put_projects(self, role, m, qs):
            self._send_json(200, store.put_projects(self._json_body()))

        def h_pull(self, role, m, qs):
            raw = qs.get("limit", ["20"])
            try:
                limit = int(raw[0])
            except ValueError as exc:
                raise bad("invalid-query", "limit must be integer") from exc
            if not 1 <= limit <= 50:
                raise bad("invalid-query", "limit must be 1..50")
            self._send_json(200, store.pull(limit))

        def h_get_attachment(self, role, m, qs):
            h = m.group(1)
            fh, size = store.open_blob_for_desktop(h)
            with fh:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(size))
                self.send_header("X-Content-SHA256", h)
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Connection", "close")
                self.end_headers()
                while True:
                    chunk = fh.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        def h_ack(self, role, m, qs):
            self._send_json(200, store.ack(self._json_body()))

    return RelayHandler


class RelayHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_gc_thread(store: RelayStore, interval: int) -> threading.Thread:
    def loop():
        while True:
            time.sleep(interval)
            try:
                res = store.gc()
                if any(res.values()):
                    sys.stderr.write(f"[gc] {json.dumps(res)}\n")
                    sys.stderr.flush()
            except Exception as exc:  # pragma: no cover
                sys.stderr.write(f"[gc] error {type(exc).__name__}\n")

    t = threading.Thread(target=loop, name="relay-gc", daemon=True)
    t.start()
    return t


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Mobile capture relay")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("serve")
    adm = sub.add_parser("admin")
    adm.add_argument("action", choices=["stats", "gc", "purge-device", "clear-projects"])
    adm.add_argument("arg", nargs="?")
    adm.add_argument("--state-dir")
    args = ap.parse_args(argv)
    if args.cmd == "admin":
        store = RelayStore(RelayConfig.from_env(require_tokens=False, state_dir=args.state_dir))
        if args.action == "stats":
            out = store.stats()
        elif args.action == "gc":
            out = store.gc()
        elif args.action == "purge-device":
            if not args.arg:
                ap.error("purge-device requires a deviceId")
            out = store.purge_device(args.arg)
        else:
            out = store.clear_projects()
        print(json.dumps(out, ensure_ascii=False))
        return 0
    cfg = RelayConfig.from_env()
    store = RelayStore(cfg)
    store.gc()
    start_gc_thread(store, cfg.gc_interval_sec)
    server = RelayHTTPServer((cfg.host, cfg.port), make_handler(cfg, store))
    sys.stderr.write(f"Listening on http://{cfg.host}:{cfg.port}{BASE}/\n")
    sys.stderr.flush()
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())

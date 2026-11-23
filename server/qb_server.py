#!/usr/bin/env python3
"""Questboard sync + dev server.

Single-user, zero dependencies (Python stdlib + SQLite).

  POST /api/sync                       push dirty records, pull everything newer than `since`
  POST /api/logs                       devices ship log batches here
  GET  /api/logs?after=&device=&platform=&level=&q=&limit=
  GET  /api/devices                    last-seen info per device
  GET  /api/state[?coll=]              full current record set (debug)
  GET  /api/releases/<platform>/latest {code, name, sha256, size, notes, url}
  GET  /api/releases/<platform>/download
  POST /api/releases/<platform>?code=&name=&notes=   (raw file body) publish an update
  POST /api/backups/<app>              (raw body) store a backup of an app's own data (app: jump); newest 7 kept
  GET  /api/backups/<app>/latest       {created, size, sha256}
  GET  /api/backups/<app>/download     the newest backup
  GET  /api/health
  GET  /                               tiny web console (live logs + devices)

Auth: `Authorization: Bearer $QB_TOKEN` (header only).
"""

import hashlib
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DATA_DIR = os.environ.get("QB_DATA", "/data")
TOKEN = os.environ.get("QB_TOKEN", "")
PORT = int(os.environ.get("QB_PORT", "8787"))
MAX_LOG_ROWS = int(os.environ.get("QB_MAX_LOG_ROWS", "100000"))
KEEP_RELEASES = int(os.environ.get("QB_KEEP_RELEASES", "3"))  # newest builds kept per platform; older files are deleted
KEEP_BACKUPS = int(os.environ.get("QB_KEEP_BACKUPS", "7"))     # newest app backups kept per app
BACKUP_APPS = {"jump"}  # apps that keep their whole local data here (Jump: its event log, gzip JSON)

COLLECTIONS = {"quests", "habits", "checkins", "rewards", "ledger", "sessions", "goals", "prefs"}
PLATFORMS = {"extension", "android", "jump"}  # jump = the Jump training app (github.com/fumeia/jump)
APK_PLATFORMS = {"android", "jump"}
ID_RE = re.compile(r"^[A-Za-z0-9_\-:.]{1,80}$")
MAX_BODY = 300 * 1024 * 1024       # release uploads (authenticated only)
MAX_JSON_BODY = 5 * 1024 * 1024    # sync / logs
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                               "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}
PULL_LIMIT = 5000
LEVELS = ["debug", "info", "warn", "error"]

_lock = threading.Lock()
_db = None


def now_ms():
    return int(time.time() * 1000)


def db():
    global _db
    if _db is None:
        os.makedirs(os.path.join(DATA_DIR, "releases"), exist_ok=True)
        os.makedirs(os.path.join(DATA_DIR, "backups"), exist_ok=True)
        _db = sqlite3.connect(os.path.join(DATA_DIR, "questboard.db"), check_same_thread=False)
        _db.execute("PRAGMA journal_mode=WAL")
        _db.executescript(
            """
            CREATE TABLE IF NOT EXISTS records (
              coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
              updated_at INTEGER NOT NULL, seq INTEGER NOT NULL, device TEXT,
              PRIMARY KEY (coll, id));
            CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
            CREATE TABLE IF NOT EXISTS devices (
              id TEXT PRIMARY KEY, platform TEXT, version TEXT, name TEXT,
              last_seen INTEGER, last_sync INTEGER, ip TEXT);
            CREATE TABLE IF NOT EXISTS logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, received INTEGER,
              device TEXT, platform TEXT, version TEXT, level TEXT, tag TEXT, msg TEXT, ctx TEXT);
            CREATE INDEX IF NOT EXISTS logs_device ON logs(device, id);
            CREATE TABLE IF NOT EXISTS releases (
              platform TEXT, code INTEGER, name TEXT, file TEXT, sha256 TEXT, size INTEGER,
              notes TEXT, created INTEGER, PRIMARY KEY (platform, code));
            """
        )
        _db.commit()
    return _db


# ---------------------------------------------------------------- handlers

def touch_device(body, ip, synced=False):
    dev = str(body.get("device") or "")[:80]
    if not dev:
        return
    db().execute(
        """INSERT INTO devices(id, platform, version, name, last_seen, last_sync, ip)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET platform=excluded.platform, version=excluded.version,
             name=COALESCE(excluded.name, devices.name), last_seen=excluded.last_seen,
             last_sync=COALESCE(excluded.last_sync, devices.last_sync), ip=excluded.ip""",
        (dev, str(body.get("platform", ""))[:20], str(body.get("version", ""))[:40],
         (str(body["name"])[:80] if body.get("name") else None), now_ms(),
         now_ms() if synced else None, ip),
    )


def upsert_record(d, coll, rec, device, seq):
    """LWW write inside an open transaction (caller holds _lock). Returns new seq or None."""
    rid = str(rec.get("id", ""))
    upd = rec.get("updatedAt")
    data = json.dumps(rec, separators=(",", ":"), sort_keys=True)
    row = d.execute("SELECT updated_at, data FROM records WHERE coll=? AND id=?", (coll, rid)).fetchone()
    if row and (upd < row[0] or (upd == row[0] and data <= row[1])):
        return None
    seq += 1
    d.execute("INSERT OR REPLACE INTO records(coll, id, data, updated_at, seq, device) VALUES(?,?,?,?,?,?)",
              (coll, rid, data, int(upd), seq, device))
    return seq


def get_record(coll, rid):
    row = db().execute("SELECT data FROM records WHERE coll=? AND id=?", (coll, rid)).fetchone()
    return json.loads(row[0]) if row else None


def server_write(records, device="server"):
    """Write [(coll, rec)] from server-side integrations (e.g. Notion)."""
    with _lock:
        d = db()
        seq = d.execute("SELECT COALESCE(MAX(seq),0) FROM records").fetchone()[0]
        n = 0
        for coll, rec in records:
            new = upsert_record(d, coll, rec, device, seq)
            if new:
                seq = new
                n += 1
        d.commit()
    return n


def server_log(level, tag, msg, ctx=None):
    """Server-side events show up in `qb logs` like device logs."""
    print(f"{level.upper()} [{tag}] {msg}", flush=True)
    with _lock:
        db().execute("INSERT INTO logs(ts, received, device, platform, version, level, tag, msg, ctx) VALUES(?,?,?,?,?,?,?,?,?)",
                     (now_ms(), now_ms(), "server", "server", "", level, tag, msg[:8000],
                      json.dumps(ctx)[:8000] if ctx is not None else None))
        db().commit()


def do_sync(body, ip):
    since = int(body.get("since") or 0)
    changes = body.get("changes") or []
    if not isinstance(changes, list):
        raise ValueError("changes must be a list")
    device = str(body.get("device") or "")[:80]
    accepted = rejected = 0
    with _lock:
        d = db()
        seq = d.execute("SELECT COALESCE(MAX(seq),0) FROM records").fetchone()[0]
        for ch in changes:
            coll, rec = (ch or {}).get("c"), (ch or {}).get("r")
            if coll not in COLLECTIONS or not isinstance(rec, dict):
                rejected += 1
                continue
            rid = str(rec.get("id", ""))
            upd = rec.get("updatedAt")
            if not ID_RE.match(rid) or not isinstance(upd, (int, float)) or isinstance(upd, bool):
                rejected += 1
                continue
            if len(json.dumps(rec)) > 256 * 1024:
                rejected += 1
                continue
            new = upsert_record(d, coll, rec, device, seq)  # last-writer-wins
            if new:
                seq = new
                accepted += 1
        touch_device(body, ip, synced=True)
        d.commit()
        rows = d.execute(
            "SELECT coll, data, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?", (since, PULL_LIMIT)
        ).fetchall()
        head = d.execute("SELECT COALESCE(MAX(seq),0) FROM records").fetchone()[0]
    out = [{"c": r[0], "r": json.loads(r[1])} for r in rows]
    cursor = rows[-1][2] if rows else head
    return {"cursor": cursor, "changes": out, "more": len(rows) == PULL_LIMIT,
            "accepted": accepted, "rejected": rejected, "serverTime": now_ms()}


def do_logs_post(body, ip):
    entries = body.get("entries") or []
    with _lock:
        d = db()
        rx = now_ms()
        for e in entries[:2000]:
            ctx = e.get("ctx")
            d.execute(
                "INSERT INTO logs(ts, received, device, platform, version, level, tag, msg, ctx) VALUES(?,?,?,?,?,?,?,?,?)",
                (int(e.get("ts") or rx), rx, str(body.get("device", ""))[:80], str(body.get("platform", ""))[:20],
                 str(body.get("version", ""))[:40], str(e.get("level", "info"))[:10], str(e.get("tag", ""))[:40],
                 str(e.get("msg", ""))[:8000], json.dumps(ctx)[:8000] if ctx is not None else None),
            )
        touch_device(body, ip)
        d.execute("DELETE FROM logs WHERE id <= (SELECT COALESCE(MAX(id),0) FROM logs) - ?", (MAX_LOG_ROWS,))
        d.commit()
    return {"ok": True, "stored": min(len(entries), 2000)}


def do_logs_get(q):
    after = int(q.get("after", ["0"])[0] or 0)
    limit = min(int(q.get("limit", ["200"])[0] or 200), 2000)
    sql = "SELECT id, ts, device, platform, version, level, tag, msg, ctx FROM logs WHERE id > ?"
    args = [after]
    if q.get("device"):
        sql += " AND device LIKE ?"
        args.append(q["device"][0] + "%")
    if q.get("platform"):
        sql += " AND platform = ?"
        args.append(q["platform"][0])
    if q.get("level") and q["level"][0] in LEVELS:
        lv = LEVELS[LEVELS.index(q["level"][0]):]
        sql += " AND level IN (%s)" % ",".join("?" * len(lv))
        args += lv
    if q.get("q"):
        sql += " AND msg LIKE ?"
        args.append("%" + q["q"][0] + "%")
    tail = after == 0
    sql += " ORDER BY id DESC LIMIT ?" if tail else " ORDER BY id ASC LIMIT ?"
    args.append(limit)
    with _lock:
        rows = db().execute(sql, args).fetchall()
    if tail:
        rows.reverse()
    keys = ["id", "ts", "device", "platform", "version", "level", "tag", "msg", "ctx"]
    return {"logs": [dict(zip(keys, r)) for r in rows]}


def do_devices():
    with _lock:
        rows = db().execute(
            "SELECT id, platform, version, name, last_seen, last_sync, ip FROM devices ORDER BY last_seen DESC").fetchall()
    keys = ["id", "platform", "version", "name", "lastSeen", "lastSync", "ip"]
    return {"devices": [dict(zip(keys, r)) for r in rows], "serverTime": now_ms(),
            "releases": {p: latest_release(p) for p in PLATFORMS}}


def do_state(q):
    coll = q.get("coll", [None])[0]
    with _lock:
        if coll:
            rows = db().execute("SELECT coll, data FROM records WHERE coll=? ORDER BY updated_at", (coll,)).fetchall()
        else:
            rows = db().execute("SELECT coll, data FROM records ORDER BY coll, updated_at").fetchall()
    out = {}
    for c, data in rows:
        out.setdefault(c, []).append(json.loads(data))
    return out


def backup_files(app):
    """Newest first: [(created_ms, path)]. Files are named <app>-<created_ms>.bin."""
    d = os.path.join(DATA_DIR, "backups")
    out = []
    for f in os.listdir(d) if os.path.isdir(d) else []:
        m = re.match(rf"^{re.escape(app)}-(\d+)\.bin$", f)
        if m:
            out.append((int(m.group(1)), os.path.join(d, f)))
    return sorted(out, reverse=True)


def latest_backup(app):
    files = backup_files(app)
    if not files:
        return None
    created, path = files[0]
    data = open(path, "rb").read()
    return {"app": app, "created": created, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "url": f"/api/backups/{app}/download"}


def store_backup(app, data):
    created = now_ms()
    path = os.path.join(DATA_DIR, "backups", f"{app}-{created}.bin")
    with open(path + ".part", "wb") as f:
        f.write(data)
    os.replace(path + ".part", path)
    for _, old in backup_files(app)[KEEP_BACKUPS:]:
        try:
            os.remove(old)
        except OSError:
            pass
    return latest_backup(app)


def prune_releases(platform):
    """Keep the newest KEEP_RELEASES builds of a platform; delete the APK files of the rest.
    Called with _lock held and the database open. Phones only ever install the newest build."""
    if KEEP_RELEASES <= 0:
        return
    old = db().execute("SELECT code, file FROM releases WHERE platform=? ORDER BY code DESC LIMIT -1 OFFSET ?",
                       (platform, KEEP_RELEASES)).fetchall()
    for code, fname in old:
        try:
            os.remove(os.path.join(DATA_DIR, "releases", fname))
        except FileNotFoundError:
            pass
        db().execute("DELETE FROM releases WHERE platform=? AND code=?", (platform, code))


def latest_release(platform):
    with _lock:
        row = db().execute(
            "SELECT code, name, sha256, size, notes, created, file FROM releases WHERE platform=? ORDER BY code DESC LIMIT 1",
            (platform,)).fetchone()
    if not row:
        return None
    return {"platform": platform, "code": row[0], "name": row[1], "sha256": row[2], "size": row[3],
            "notes": row[4], "created": row[5], "file": row[6],
            "url": f"/api/releases/{platform}/download"}


# ---------------------------------------------------------------- HTTP

CONSOLE_HTML = r"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Questboard console</title><style>
:root{color-scheme:dark}body{margin:0;font:13px/1.45 ui-monospace,monospace;background:#16161a;color:#ddd}
header{display:flex;gap:8px;align-items:center;padding:10px 16px;background:#1f1f25;position:sticky;top:0;flex-wrap:wrap}
input,select,button{background:#2a2a32;color:#eee;border:1px solid #3a3a44;border-radius:6px;padding:5px 8px;font:inherit}
#devs{padding:8px 16px;color:#9a9a9a}#logs{padding:0 16px 40px}.l{white-space:pre-wrap;border-bottom:1px solid #222;padding:2px 0;overflow-wrap:anywhere}
#dl{padding:4px 16px 8px;display:flex;gap:8px;flex-wrap:wrap}#dl button{padding:8px 12px}
.error{color:#ff7b72}.warn{color:#e3b341}.debug{color:#777}.t{color:#6e7681}.d{color:#79c0ff}
</style></head><body><header><b>Questboard</b>
<input id="tok" type="password" placeholder="token" size="14">
<select id="lvl"><option value="">all</option><option>info</option><option>warn</option><option>error</option></select>
<input id="dev" placeholder="device prefix" size="12"><input id="q" placeholder="search" size="14">
<button onclick="reset()">apply</button></header><div id="devs"></div><div id="dl"></div><div id="logs"></div>
<script>
const $=id=>document.getElementById(id);let after=0;
try{$('tok').value=localStorage.qbTok||''}catch(e){}
function h(){return{Authorization:'Bearer '+$('tok').value}}
function reset(){try{localStorage.qbTok=$('tok').value}catch(e){};after=0;$('logs').innerHTML='';poll();devs()}
async function devs(){const r=await fetch('/api/devices',{headers:h()});if(!r.ok)return;const j=await r.json();
$('devs').textContent=j.devices.map(d=>`${d.name||d.id} [${d.platform} ${d.version}] seen ${Math.round((j.serverTime-d.lastSeen)/1000)}s ago`).join('  ·  ');
// Downloads: the token goes in a header (never in the URL), so fetch the file and hand it to the browser as a blob.
const names={android:'Questboard app',jump:'Jump app',extension:'GNOME extension'};$('dl').innerHTML='';
for(const [p,r] of Object.entries(j.releases||{})){if(!r)continue;const b=document.createElement('button');
b.textContent=`Download ${names[p]||p} ${r.name}`;b.onclick=()=>dl(p,b);$('dl').append(b)}}
async function dl(p,b){const t=b.textContent;b.textContent='downloading…';
const r=await fetch(`/api/releases/${p}/download`,{headers:h()});if(!r.ok){b.textContent='failed ('+r.status+')';return}
const cd=r.headers.get('Content-Disposition')||'';const m=cd.match(/filename="([^"]+)"/);
const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download=m?m[1]:p;document.body.append(a);a.click();
setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},60000);b.textContent=t}
async function poll(){const p=new URLSearchParams({after,limit:500});if($('lvl').value)p.set('level',$('lvl').value);
if($('dev').value)p.set('device',$('dev').value);if($('q').value)p.set('q',$('q').value);
const r=await fetch('/api/logs?'+p,{headers:h()});if(!r.ok)return;const j=await r.json();
const atBottom=innerHeight+scrollY>=document.body.scrollHeight-40;
for(const l of j.logs){after=Math.max(after,l.id);const e=document.createElement('div');e.className='l '+l.level;
const t=document.createElement('span');t.className='t';t.textContent=new Date(l.ts).toLocaleTimeString();
const d=document.createElement('span');d.className='d';d.textContent=`${l.platform}/${(l.device||'').slice(0,8)}`;
e.append(t,' ',d,` ${String(l.level).toUpperCase()} [${l.tag}] ${l.msg}${l.ctx&&l.ctx!=='null'?' '+l.ctx:''}`);$('logs').append(e)}
if(atBottom&&j.logs.length)scrollTo(0,document.body.scrollHeight)}
reset();setInterval(poll,2000);setInterval(devs,10000);
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "Questboard"
    sys_version = ""
    timeout = 60  # slow clients can't hold threads forever
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("QB_ACCESS_LOG"):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _client_ip(self):
        return self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()

    def _authed(self, q):
        # Header only: tokens in URLs leak into proxy logs and browser history.
        hdr = self.headers.get("Authorization", "")
        tok = hdr[7:] if hdr.startswith("Bearer ") else ""
        ok = bool(TOKEN) and secrets.compare_digest(tok.encode(), TOKEN.encode())
        if not ok:
            time.sleep(0.5)  # brake on guessing
        return ok

    def _send(self, code, obj=None, ctype="application/json", raw=None, filename=None):
        body = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        if code >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit=MAX_BODY):
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > limit:
            raise ValueError("body too large")
        buf = bytearray()
        while len(buf) < n:
            chunk = self.rfile.read(min(1 << 20, n - len(buf)))
            if not chunk:
                break
            buf += chunk
        return bytes(buf)

    def _json(self):
        obj = json.loads(self._body(MAX_JSON_BODY).decode() or "{}")
        if not isinstance(obj, dict):
            raise ValueError("expected a JSON object")
        return obj

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        p = u.path.rstrip("/") or "/"
        if p == "/api/health":
            return self._send(200, {"ok": True, "time": now_ms()})
        if p == "/":
            return self._send(200, ctype="text/html; charset=utf-8", raw=CONSOLE_HTML.encode())
        if not self._authed(q):
            return self._send(401, {"error": "unauthorized"})
        try:
            if p == "/api/logs":
                return self._send(200, do_logs_get(q))
            if p == "/api/devices":
                return self._send(200, do_devices())
            if p == "/api/state":
                return self._send(200, do_state(q))
            m = re.match(r"^/api/backups/(\w+)/(latest|download)$", p)
            if m and m.group(1) in BACKUP_APPS:
                b = latest_backup(m.group(1))
                if not b:
                    return self._send(404, {"error": "no backup"})
                if m.group(2) == "latest":
                    return self._send(200, b)
                with open(backup_files(m.group(1))[0][1], "rb") as f:
                    return self._send(200, ctype="application/octet-stream", raw=f.read(), filename=f"{m.group(1)}-backup.bin")
            m = re.match(r"^/api/releases/(\w+)/(latest|download)$", p)
            if m and m.group(1) in PLATFORMS:
                rel = latest_release(m.group(1))
                if not rel:
                    return self._send(404, {"error": "no release"})
                if m.group(2) == "latest":
                    return self._send(200, rel)
                with open(os.path.join(DATA_DIR, "releases", rel["file"]), "rb") as f:
                    data = f.read()
                ctype = "application/vnd.android.package-archive" if rel["file"].endswith(".apk") else "application/zip"
                return self._send(200, ctype=ctype, raw=data, filename=rel["file"])
            return self._send(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        p = u.path.rstrip("/")
        if not self._authed(q):
            return self._send(401, {"error": "unauthorized"})  # body never read; connection closed
        try:
            if p == "/api/sync":
                return self._send(200, do_sync(self._json(), self._client_ip()))
            if p == "/api/logs":
                return self._send(200, do_logs_post(self._json(), self._client_ip()))
            m = re.match(r"^/api/backups/(\w+)$", p)
            if m and m.group(1) in BACKUP_APPS:
                data = self._body()
                if not data:
                    return self._send(400, {"error": "empty backup"})
                with _lock:
                    return self._send(200, store_backup(m.group(1), data))
            m = re.match(r"^/api/releases/(\w+)$", p)
            if m and m.group(1) in PLATFORMS:
                plat = m.group(1)
                code = int(q.get("code", ["0"])[0])
                name = q.get("name", [str(code)])[0][:40]
                notes = q.get("notes", [""])[0][:2000]
                data = self._body()
                if code <= 0 or not data:
                    return self._send(400, {"error": "need ?code=<int> and a file body"})
                ext = "apk" if plat in APK_PLATFORMS else "zip"
                fname = f"{plat}-{code}.{ext}"
                tmp = os.path.join(DATA_DIR, "releases", fname + ".part")
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, os.path.join(DATA_DIR, "releases", fname))
                sha = hashlib.sha256(data).hexdigest()
                with _lock:
                    db().execute("INSERT OR REPLACE INTO releases VALUES(?,?,?,?,?,?,?,?)",
                                 (plat, code, name, fname, sha, len(data), notes, now_ms()))
                    prune_releases(plat)
                    db().commit()
                return self._send(200, latest_release(plat))
            return self._send(404, {"error": "not found"})
        except (ValueError, json.JSONDecodeError) as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})


def main():
    if len(TOKEN) < 16:
        sys.exit("QB_TOKEN must be set (>= 16 chars). Generate one: python3 -c 'import secrets;print(secrets.token_urlsafe(32))'")
    db()
    if os.environ.get("NOTION_TOKEN"):
        import notion_sync
        notion_sync.start(sys.modules[__name__])
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Questboard server on :{PORT}, data in {DATA_DIR}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

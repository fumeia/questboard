"""Two-way sync between a Notion database (the Studienplaner "Objekte DB") and
Questboard quests. Runs inside the Questboard server when NOTION_TOKEN is set.

Notion page  ->  quest record  `quests/notion.<page id>`
  title       "<Modul> · <Titel>"
  due         Zieldatum
  done        Status in done_statuses        (XP ledger entry `quest.<quest id>`)
  quadrant    Do first if due within N days / urgent status, else Schedule
              (re-sorted automatically as deadlines approach unless moved by hand)
  xp          by Type (Prüfung 100, …)

Questboard -> Notion: checking/unchecking, renaming and changing the due date
are written back to the page.
"""

import datetime as dt
import json
import os
import threading
import time
import urllib.error
import urllib.request

API = os.environ.get("NOTION_API_BASE", "https://api.notion.com")
VERSION = "2025-09-03"
HERE = os.path.dirname(os.path.abspath(__file__))


def load_config(data_dir):
    cfg = json.load(open(os.path.join(HERE, "notion.json")))
    custom = os.path.join(data_dir, "notion.json")
    if os.path.exists(custom):
        cfg.update(json.load(open(custom)))
    if os.environ.get("NOTION_DATA_SOURCE"):
        cfg["data_source_id"] = os.environ["NOTION_DATA_SOURCE"]
    return cfg


class Notion:
    def __init__(self, token):
        self.token = token

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(4):
            req = urllib.request.Request(API + path, data=data, method=method)
            req.add_header("Authorization", "Bearer " + self.token)
            req.add_header("Notion-Version", VERSION)
            req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    time.sleep(float(e.headers.get("Retry-After") or 2 ** attempt))
                    continue
                raise RuntimeError(f"Notion {method} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:300]}")
        raise RuntimeError(f"Notion {method} {path}: gave up after retries")

    def query(self, ds_id, flt):
        cursor = None
        while True:
            body = {"page_size": 100, "filter": flt}
            if cursor:
                body["start_cursor"] = cursor
            res = self.call("POST", f"/v1/data_sources/{ds_id}/query", body)
            yield from res.get("results", [])
            if not res.get("has_more"):
                return
            cursor = res.get("next_cursor")


# ----------------------------------------------------------------- helpers

def plain(prop):
    if not prop:
        return ""
    t = prop.get("type")
    if t in ("title", "rich_text"):
        return "".join(x.get("plain_text", "") for x in prop.get(t) or [])
    if t in ("select", "status"):
        return (prop.get(t) or {}).get("name", "")
    return ""


def iso_ms(s):
    return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def now_ms():
    return int(time.time() * 1000)


def qid(page_id):
    return "notion." + page_id.replace("-", "")


def days_until(date_str, today=None):
    today = today or dt.date.today()
    return (dt.date.fromisoformat(date_str[:10]) - today).days


class NotionSync:
    def __init__(self, srv):
        self.srv = srv
        self.cfg = load_config(srv.DATA_DIR)
        self.api = Notion(os.environ["NOTION_TOKEN"])
        self.modules = {}
        self.last_full = 0
        self.last_poll_iso = None
        d = srv.db()
        d.execute("""CREATE TABLE IF NOT EXISTS notion_state (
            page_id TEXT PRIMARY KEY, notion_edited TEXT, quest_updated INTEGER, ignored INTEGER DEFAULT 0)""")
        d.commit()

    # ---- state
    def state(self, pid):
        with self.srv._lock:
            r = self.srv.db().execute("SELECT notion_edited, quest_updated, ignored FROM notion_state WHERE page_id=?", (pid,)).fetchone()
        return {"notion_edited": r[0], "quest_updated": r[1], "ignored": r[2]} if r else None

    def save_state(self, pid, notion_edited, quest_updated, ignored=0):
        with self.srv._lock:
            self.srv.db().execute("INSERT OR REPLACE INTO notion_state VALUES(?,?,?,?)", (pid, notion_edited, quest_updated, ignored))
            self.srv.db().commit()

    def record(self, coll, rid):
        with self.srv._lock:
            return self.srv.get_record(coll, rid)

    # ---- mapping
    def module_name(self, page):
        rel = (page["properties"].get(self.cfg["props"]["module"]) or {}).get("relation") or []
        if not rel:
            return ""
        mid = rel[0]["id"]
        if mid not in self.modules:
            try:
                mp = self.api.call("GET", f"/v1/pages/{mid}")
                self.modules[mid] = plain(mp["properties"].get(self.cfg["module_title_prop"])) or next(
                    (plain(v) for v in mp["properties"].values() if v.get("type") == "title"), "")
            except Exception as e:  # noqa: BLE001 — module not shared with the integration
                self.srv.server_log("warn", "notion", f"cannot read module {mid}: {e}")
                self.modules[mid] = ""
        return self.modules[mid]

    def parse(self, page):
        p, c = page["properties"], self.cfg["props"]
        base = plain(p.get(c["title"])).strip() or "Untitled"
        module = self.module_name(page)
        due_raw = ((p.get(c["due"]) or {}).get("date") or {}).get("start")
        due = None
        if due_raw:
            due = {"date": due_raw[:10]}
            if "T" in due_raw:
                t = dt.datetime.fromisoformat(due_raw).astimezone()
                due["time"] = t.hour * 60 + t.minute
        status = plain(p.get(c["status"]))
        typ = plain(p.get(c["type"]))
        return {
            "base": base, "module": module, "title": f"{module} · {base}" if module else base,
            "due": due, "status": status, "type": typ, "done": status in self.cfg["done_statuses"],
            "url": page.get("url"), "edited": page.get("last_edited_time"),
            "archived": bool(page.get("archived") or page.get("in_trash")),
        }

    def quadrant(self, n):
        urgent = n["status"] in self.cfg["urgent_statuses"] or (
            n["due"] is not None and days_until(n["due"]["date"]) <= self.cfg["urgent_within_days"])
        important = n["type"] not in self.cfg["unimportant_types"]
        return {(True, True): "q1", (False, True): "q2", (True, False): "q3", (False, False): "q4"}[(urgent, important)]

    # ---- one page
    def handle(self, page, writes):
        pid = page["id"]
        n = self.parse(page)
        if n["type"] not in self.cfg["include_types"]:
            return
        st = self.state(pid)
        if st and st["ignored"]:
            return
        rid = qid(pid)
        q = self.record("quests", rid)
        now = now_ms()

        if q and q.get("deleted"):
            self.save_state(pid, n["edited"], q["updatedAt"], ignored=1)  # deleted in Questboard: leave it alone
            return
        if n["archived"]:
            if q:
                writes.append(("quests", {"id": rid, "deleted": True, "updatedAt": max(now, q["updatedAt"] + 1)}))
            self.save_state(pid, n["edited"], now, ignored=1)
            return
        if not q and n["done"] and n["due"] and days_until(n["due"]["date"]) < -self.cfg["skip_done_older_than_days"]:
            return  # old finished work: don't flood the board

        quest_changed = bool(q and st and q["updatedAt"] > (st["quest_updated"] or 0))
        notion_changed = not st or st["notion_edited"] != n["edited"]

        if quest_changed:
            self.push_to_notion(pid, q, n)
            # re-read so we store Notion's new edit time and don't bounce the change back
            fresh = self.parse(self.api.call("GET", f"/v1/pages/{pid}"))
            self.save_state(pid, fresh["edited"], q["updatedAt"])
            return

        if not notion_changed and q:
            # deadline creeping closer → re-sort, unless the user placed it manually
            if not q.get("done") and not q.get("quadrantManual"):
                want = self.quadrant(n)
                if want != q.get("quadrant"):
                    upd = {**q, "quadrant": want, "updatedAt": max(now, q["updatedAt"] + 1)}
                    writes.append(("quests", upd))
                    self.save_state(pid, n["edited"], upd["updatedAt"])
            return

        rec = dict(q or {"id": rid, "createdAt": now, "notes": "", "scheduled": None})
        rec.update({
            "title": n["title"], "notionTitle": n["base"], "due": n["due"], "xp": self.cfg["xp_by_type"].get(n["type"], 0),
            "source": "notion", "link": n["url"], "notionStatus": n["status"], "kind": n["type"],
        })
        if not rec.get("quadrantManual"):
            rec["quadrant"] = self.quadrant(n)
        if n["module"] and not rec.get("topic"):
            rec["topic"] = n["module"]  # course = topic (for stats); a manual topic is kept
        was_done = bool(q and q.get("done"))
        rec["done"] = n["done"]
        if n["done"] and not was_done:
            rec["doneAt"] = now
            led = self.record("ledger", f"quest.{rid}")
            if not led or led.get("deleted"):
                writes.append(("ledger", {"id": f"quest.{rid}", "at": now, "amount": rec["xp"] or 30, "kind": "quest",
                                          "ref": rid, "note": rec["title"], "updatedAt": now}))
        elif not n["done"] and was_done:
            rec["doneAt"] = None
            led = self.record("ledger", f"quest.{rid}")
            if led and not led.get("deleted"):
                writes.append(("ledger", {"id": f"quest.{rid}", "deleted": True, "updatedAt": max(now, led["updatedAt"] + 1)}))
        rec["updatedAt"] = max(now, (q or {}).get("updatedAt", 0) + 1)
        writes.append(("quests", rec))
        self.save_state(pid, n["edited"], rec["updatedAt"])

    def push_to_notion(self, pid, q, n):
        c = self.cfg["props"]
        props = {}
        if bool(q.get("done")) != n["done"]:
            props[c["status"]] = {"status": {"name": self.cfg["set_done_status"] if q.get("done") else self.cfg["set_open_status"]}}
        title = q.get("title", "")
        prefix = f"{n['module']} · " if n["module"] else ""
        base = title[len(prefix):] if prefix and title.startswith(prefix) else title
        if base and base != n["base"]:
            props[c["title"]] = {"title": [{"text": {"content": base}}]}
        qd = (q.get("due") or {}).get("date")
        nd = (n["due"] or {}).get("date")
        if qd != nd:
            props[c["due"]] = {"date": {"start": qd} if qd else None}
        if props:
            self.api.call("PATCH", f"/v1/pages/{pid}", {"properties": props})
            self.srv.server_log("info", "notion", f"pushed to Notion: {q.get('title')}", {"fields": list(props)})

    # ---- loop
    def poll(self):
        t0 = time.time()
        full = time.time() - self.last_full > self.cfg["full_scan_minutes"] * 60
        ds = self.cfg["data_source_id"]
        if full or not self.last_poll_iso:
            flt = {"or": [{"property": self.cfg["props"]["type"], "select": {"equals": t}} for t in self.cfg["include_types"]]}
        else:
            flt = {"timestamp": "last_edited_time", "last_edited_time": {"on_or_after": self.last_poll_iso}}
        started = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        writes, seen = [], set()
        for page in self.api.query(ds, flt):
            seen.add(page["id"])
            self.handle(page, writes)
        # Questboard-side edits to pages Notion didn't report as changed
        if not full:
            self.push_local_edits(seen, writes)
        n = self.srv.server_write(writes, device="notion") if writes else 0
        self.last_poll_iso = started
        if full:
            self.last_full = time.time()
        if n or full:
            self.srv.server_log("info", "notion", f"{'full' if full else 'incremental'} sync: {len(seen)} page(s), {n} change(s) "
                                f"in {int((time.time() - t0) * 1000)} ms")

    def push_local_edits(self, seen, writes):
        with self.srv._lock:
            rows = self.srv.db().execute(
                "SELECT s.page_id, s.quest_updated, r.data FROM notion_state s JOIN records r "
                "ON r.coll='quests' AND r.id = 'notion.' || REPLACE(s.page_id, '-', '') "
                "WHERE s.ignored = 0 AND r.updated_at > COALESCE(s.quest_updated, 0)").fetchall()
        for pid, _, data in rows:
            if pid in seen:
                continue
            q = json.loads(data)
            if q.get("deleted"):
                continue
            page = self.api.call("GET", f"/v1/pages/{pid}")
            self.handle(page, writes)

    def run(self):
        self.srv.server_log("info", "notion", f"Notion sync started for data source {self.cfg['data_source_id']}")
        while True:
            try:
                self.poll()
            except Exception as e:  # noqa: BLE001
                self.srv.server_log("error", "notion", str(e)[:500])
            time.sleep(self.cfg["poll_seconds"])


def start(srv):
    t = threading.Thread(target=NotionSync(srv).run, name="notion-sync", daemon=True)
    t.start()
    return t

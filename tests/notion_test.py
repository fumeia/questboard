import json, os, sys, threading, datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, sys.argv[1])
os.environ.update(QB_DATA=sys.argv[2], QB_TOKEN="x"*20, NOTION_TOKEN="secret", NOTION_API_BASE="http://127.0.0.1:18799")
today = dt.date.today()
def page(pid, title, typ, status, due, mod="m1", edited="2026-11-04T10:00:00.000Z"):
    return {"id": pid, "url": f"https://notion.so/{pid}", "last_edited_time": edited, "archived": False, "properties": {
        "Titel": {"type": "title", "title": [{"plain_text": title}]}, "Type": {"type": "select", "select": {"name": typ}},
        "Status": {"type": "status", "status": {"name": status}},
        "Zieldatum": {"type": "date", "date": {"start": due} if due else None},
        "Modul": {"type": "relation", "relation": [{"id": mod}]}}}
PAGES = {
 "p1": page("p1", "Übungsblatt 5", "Übungsblatt", "Not started", str(today + dt.timedelta(days=1))),
 "p2": page("p2", "Endprüfung", "Prüfung", "On Track", str(today + dt.timedelta(days=20))),
 "p3": page("p3", "Vorlesung", "Termin", "Not started", str(today)),
 "p4": page("p4", "Altes Blatt 9", "Übungsblatt", "Not started", str(today - dt.timedelta(days=300)), mod="m0"),
}
MOD = {"id": "m1", "properties": {"Modul": {"type": "title", "title": [{"plain_text": "Analysis II"}]},
       "Status": {"type": "status", "status": {"name": "Aktuell"}}}}
OLD = {"id": "m0", "properties": {"Modul": {"type": "title", "title": [{"plain_text": "Lineare Algebra I"}]},
       "Status": {"type": "status", "status": {"name": "Bestanden"}}}}
PATCHES = []
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _s(self, o):
        b = json.dumps(o).encode(); self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"])); self._s({"results": list(PAGES.values()), "has_more": False})
    def do_GET(self):
        pid = self.path.rsplit("/", 1)[1]; self._s(MOD if pid == "m1" else OLD if pid == "m0" else PAGES[pid])
    def do_PATCH(self):
        pid = self.path.rsplit("/", 1)[1]; body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        PATCHES.append((pid, body)); pg = PAGES[pid]
        for k, v in body["properties"].items():
            if "status" in v: pg["properties"]["Status"]["status"] = v["status"]
            if "title" in v: pg["properties"]["Titel"]["title"] = [{"plain_text": v["title"][0]["text"]["content"]}]
            if "date" in v: pg["properties"]["Zieldatum"]["date"] = v["date"]
        pg["last_edited_time"] = "2026-11-04T11:00:00.000Z"; self._s(pg)
threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", 18799), H).serve_forever, daemon=True).start()
import qb_server as srv, notion_sync
ns = notion_sync.NotionSync(srv)
get = lambda c, i: srv.get_record(c, i)
ns.poll()
q1, q2 = get("quests", "notion.p1"), get("quests", "notion.p2")
assert q1["title"] == "Analysis II · Übungsblatt 5" and q1["quadrant"] == "q1" and q1["xp"] == 40, q1
assert q2["quadrant"] == "q2" and q2["xp"] == 100 and get("quests", "notion.p3") is None
assert get("quests", "notion.p4") is None, "old-semester module (Bestanden) must not be imported"
assert q1["topic"] == "Analysis II", "module becomes the topic"
# 1) completed in Notion → quest done + XP once
PAGES["p2"]["properties"]["Status"]["status"]["name"] = "🏆 Completed"; PAGES["p2"]["last_edited_time"] = "2026-11-04T10:05:00.000Z"
ns.last_full = 0; ns.poll(); ns.last_full = 0; ns.poll()
assert get("quests", "notion.p2")["done"] and get("ledger", "quest.notion.p2")["amount"] == 100
# 2) ticked in Questboard (device sync) → Notion gets Completed
q = dict(get("quests", "notion.p1")); q.update(done=True, doneAt=1, updatedAt=q["updatedAt"] + 10)
srv.do_sync({"device": "phone", "changes": [{"c": "quests", "r": q}, {"c": "ledger", "r": {"id": "quest.notion.p1", "at": 1, "amount": 40, "kind": "quest", "updatedAt": q["updatedAt"]}}]}, "x")
ns.poll()
assert PATCHES[-1] == ("p1", {"properties": {"Status": {"status": {"name": "🏆 Completed"}}}}), PATCHES
ns.last_full = 0; ns.poll()
assert len(PATCHES) == 1, "no ping-pong"
assert get("quests", "notion.p1")["done"]
# 3) rename in Questboard pushes base title; manual quadrant survives
q = dict(get("quests", "notion.p1")); q.update(done=False, title="Analysis II · Blatt 5 (Bonus)", quadrant="q3", quadrantManual=True, updatedAt=q["updatedAt"] + 10)
srv.do_sync({"device": "desk", "changes": [{"c": "quests", "r": q}]}, "x")
ns.poll(); ns.last_full = 0; ns.poll()
assert PATCHES[-1][1]["properties"]["Titel"]["title"][0]["text"]["content"] == "Blatt 5 (Bonus)", PATCHES[-1]
assert get("quests", "notion.p1")["quadrant"] == "q3"
# 4) deleted in Questboard → ignored, not recreated
srv.do_sync({"device": "desk", "changes": [{"c": "quests", "r": {"id": "notion.p2", "deleted": True, "updatedAt": 9e12}}]}, "x")
ns.last_full = 0; ns.poll(); assert get("quests", "notion.p2")["deleted"]
print("patches:", len(PATCHES)); print("ALL NOTION TESTS PASSED")

"""Unit checks for the Notion matrix window and goal link (server/notion_sync.py). Run: python3 tests/notion_matrix_test.py"""
import datetime as dt, json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import notion_sync as ns


class FakeSrv:
    def __init__(self, goals):
        import sqlite3
        self.db_ = sqlite3.connect(":memory:", check_same_thread=False)
        self.db_.execute("CREATE TABLE records (coll TEXT, id TEXT, data TEXT)")
        for g in goals:
            self.db_.execute("INSERT INTO records VALUES('goals', ?, ?)", (g["id"], json.dumps(g)))
        import threading
        self._lock = threading.Lock()

    def db(self):
        return self.db_


def sync_with(goals):
    s = ns.NotionSync.__new__(ns.NotionSync)
    s.srv = FakeSrv(goals)
    s.cfg = json.load(open(os.path.join(os.path.dirname(ns.__file__), "notion.json")))
    return s


today = dt.date.today()
iso = lambda d: (today + dt.timedelta(days=d)).isoformat()
def n(due_days=None, done=False, module="Festkörperphysik", base="Blatt 4"):
    return {"due": {"date": iso(due_days)} if due_days is not None else None, "done": done, "module": module, "base": base, "archived": False,
            "status": "", "type": "Übungsblatt"}

goals = [{"id": "g-ss", "title": "5.0 in Festkörperphysik", "createdAt": 1}, {"id": "g-qm", "title": "5.5 in QM 1", "createdAt": 1},
         {"id": "g-as", "title": "5.5 in Astro", "createdAt": 1}, {"id": "g-old", "title": "5.0 in Festkörperphysik alt", "done": True, "createdAt": 9}]
s = sync_with(goals)
fails = []
def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what)
    if not cond: fails.append(what)

check(s.in_matrix(n(3)), "a sheet due in 3 days is in the matrix")
check(s.in_matrix(n(14)), "a sheet due in 14 days is in the matrix (window edge)")
check(not s.in_matrix(n(15)), "a sheet due in 15 days is not (goal only)")
check(s.in_matrix(n(-7)), "a sheet 7 days overdue is still in the matrix")
check(not s.in_matrix(n(-8)), "a sheet 8 days overdue leaves the matrix")
check(s.in_matrix(n(None)), "a sheet without date stays in the matrix")
check(not s.in_matrix(n(2, done=True)), "a finished sheet (not ticked today) is not in the matrix")
check(s.in_matrix(n(2, done=True), {"doneAt": dt.datetime.now().timestamp() * 1000}), "a sheet ticked today stays until tomorrow")
check(s.goal_for(n(module="Festkörperphysik")) == "g-ss", "Festkörperphysik → 5.0 in Festkörperphysik (not the finished one)")
check(s.goal_for(n(module="QM 1")) == "g-qm", "QM 1 → 5.5 in QM 1")
check(s.goal_for(n(module="Quantenmechanik")) == "g-qm", "Quantenmechanik → QM goal")
check(s.goal_for(n(module="Astrophysik")) == "g-as", "Astrophysik → Astro goal")
check(s.goal_for(n(module="Analysis II")) is None, "unknown module → no goal")
print("FAILED: " + ", ".join(fails) if fails else "all passed")
sys.exit(1 if fails else 0)

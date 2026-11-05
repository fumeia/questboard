package com.questboard.app.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.random.Random

/*
 * Kotlin port of extension/store.js — same records, same merge rules, same
 * derived numbers (see docs/DATA_MODEL.md). Records are kept as JSONObject so
 * fields added on the desktop survive a round-trip through the phone.
 */

data class Quadrant(val id: String, val title: String, val short: String, val subtitle: String, val xp: Int)

val QUADRANTS = listOf(
    Quadrant("q1", "Do first", "Do", "Urgent · Important", 30),
    Quadrant("q2", "Schedule", "Plan", "Important · Not urgent", 40),
    Quadrant("q3", "Delegate", "Delegate", "Urgent · Not important", 15),
    Quadrant("q4", "Eliminate", "Drop", "Not urgent · Not important", 5),
)
val COLLECTIONS = listOf("quests", "habits", "checkins", "rewards", "ledger", "sessions", "goals")
val PICKABLE_ICONS = listOf("star", "heart", "book", "dumbbell", "drop", "moon", "music", "game", "film", "pizza",
    "leaf", "bolt", "coffee", "gift", "target", "trophy", "sparkle", "flame", "shield", "repeat")
const val POMODORO_XP = 10
const val STEP_XP = 10
/** Reaching a long-term goal. */
const val GOAL_XP = 100
fun groupBonus(q: JSONObject) = maxOf(10, Math.round(questXp(q) * 0.5).toInt())
private const val DAY_MS = 86_400_000L
private const val TOMBSTONE_TTL = 60 * DAY_MS

private val DEFAULT_REWARDS = listOf(
    listOf("reward.coffee", "Fancy coffee or a treat", 60, "coffee"),
    listOf("reward.episode", "Watch an episode", 80, "film"),
    listOf("reward.gaming", "One hour of gaming", 120, "game"),
    listOf("reward.movie", "Movie night", 250, "star"),
    listOf("reward.takeout", "Order takeout", 300, "pizza"),
    listOf("reward.lazyday", "Guilt-free lazy day", 800, "moon"),
    listOf("reward.purchase", "Buy something nice", 1500, "gift"),
)

data class LevelInfo(val level: Int, val into: Int, val span: Int, val frac: Float)

fun levelInfo(xp: Int): LevelInfo {
    var level = 1
    while (50 * (level + 1) * level <= xp) level++
    val base = 50 * level * (level - 1)
    val next = 50 * (level + 1) * level
    return LevelInfo(level, xp - base, next - base, (xp - base).toFloat() / (next - base))
}

fun habitXp(base: Int, streak: Int): Int = when {
    streak >= 7 -> (base * 1.5).roundToInt()
    streak >= 3 -> (base * 1.2).roundToInt()
    else -> base
}

fun uid(): String = java.lang.Long.toString(System.currentTimeMillis(), 36) +
    (1..6).map { "0123456789abcdefghijklmnopqrstuvwxyz"[Random.nextInt(36)] }.joinToString("")

fun dateKey(d: LocalDate = LocalDate.now()): String = d.toString()
fun dateKeyOf(ms: Long): String = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate().toString()

fun quadXp(id: String) = QUADRANTS.find { it.id == id }?.xp ?: 10
fun questXp(q: JSONObject): Int = q.optInt("xp", 0).takeIf { it > 0 } ?: quadXp(q.optString("quadrant", "q1"))

/** Days until due (negative = overdue) or null. */
fun dueInDays(q: JSONObject, today: LocalDate = LocalDate.now()): Long? {
    val d = q.optJSONObject("due")?.optString("date")?.takeIf { it.isNotEmpty() } ?: return null
    return java.time.temporal.ChronoUnit.DAYS.between(today, LocalDate.parse(d))
}

// JSON helpers ------------------------------------------------------------

fun JSONObject.str(k: String, def: String = "") = if (has(k) && !isNull(k)) optString(k, def) else def
fun JSONObject.bool(k: String) = optBoolean(k, false)
fun JSONObject.copy(): JSONObject = JSONObject(toString())
fun jobj(vararg pairs: Pair<String, Any?>): JSONObject = JSONObject().apply {
    for ((k, v) in pairs) put(k, v ?: JSONObject.NULL)
}

/** Device-local live timer. */
data class Timer(
    val id: String, var label: String, val mode: String, val kind: String, val durationMs: Long,
    var questId: String?, var elapsedMs: Long = 0, var startedAt: Long? = null, var finished: Boolean = false,
    var stepId: String? = null,
) {
    fun toJson() = jobj("id" to id, "label" to label, "mode" to mode, "kind" to kind, "durationMs" to durationMs,
        "questId" to questId, "elapsedMs" to elapsedMs, "startedAt" to startedAt, "finished" to finished, "stepId" to stepId)

    companion object {
        fun from(o: JSONObject) = Timer(o.str("id"), o.str("label"), o.str("mode"), o.str("kind"), o.optLong("durationMs"),
            o.str("questId").ifEmpty { null }, o.optLong("elapsedMs"), if (o.isNull("startedAt")) null else o.optLong("startedAt"),
            o.bool("finished"), o.str("stepId").ifEmpty { null })
    }
}

class Store(context: Context, private val log: (String, String) -> Unit = { _, _ -> }) {
    private val file = File(context.filesDir, "data.json")
    private val colls = COLLECTIONS.associateWith { mutableMapOf<String, JSONObject>() }
    private val dirty = mutableMapOf<String, Long>()
    val timers = mutableListOf<Timer>()
    private val reminded = mutableMapOf<String, String>()
    var deviceId: String = "phone-" + uid(); private set
    var cursor: Long = 0; private set
    private var seeded = false

    private val _version = MutableStateFlow(0)
    /** Bumped on every change; Compose screens observe it. */
    val version: StateFlow<Int> = _version
    var onLocalChange: (() -> Unit)? = null

    private var cache: Derived? = null

    init {
        load()
        seedDefaults()
    }

    // ---- persistence ----------------------------------------------------

    private fun load() {
        if (!file.exists()) return
        try {
            val d = JSONObject(file.readText())
            deviceId = d.optString("deviceId", deviceId)
            cursor = d.optLong("cursor", 0)
            seeded = d.optBoolean("seeded", false)
            d.optJSONObject("colls")?.let { c ->
                for (name in COLLECTIONS) c.optJSONObject(name)?.let { m ->
                    for (k in m.keys()) colls.getValue(name)[k] = m.getJSONObject(k)
                }
            }
            d.optJSONObject("dirty")?.let { m -> for (k in m.keys()) dirty[k] = m.getLong(k) }
            d.optJSONArray("timers")?.let { a -> for (i in 0 until a.length()) timers += Timer.from(a.getJSONObject(i)) }
            d.optJSONObject("reminded")?.let { m -> for (k in m.keys()) reminded[k] = m.getString(k) }
        } catch (e: Exception) {
            val backup = File(file.parentFile, "data.json.corrupt-${System.currentTimeMillis()}")
            file.renameTo(backup)
            log("error", "could not parse data, moved to ${backup.name}: $e")
        }
    }

    @Synchronized
    fun save() {
        val c = JSONObject()
        for ((name, m) in colls) c.put(name, JSONObject().apply { for ((k, v) in m) put(k, v) })
        val d = jobj("version" to 2, "deviceId" to deviceId, "cursor" to cursor, "seeded" to seeded, "colls" to c,
            "dirty" to JSONObject(dirty as Map<*, *>), "timers" to JSONArray(timers.map { it.toJson() }),
            "reminded" to JSONObject(reminded as Map<*, *>))
        val tmp = File(file.parentFile, "data.json.tmp")
        tmp.writeText(d.toString())
        tmp.renameTo(file)
    }

    private fun seedDefaults() {
        if (seeded) return
        for ((id, title, cost, icon) in DEFAULT_REWARDS) {
            val sid = id as String
            if (colls.getValue("rewards")[sid] == null) {
                colls.getValue("rewards")[sid] = jobj("id" to sid, "title" to title, "cost" to cost, "icon" to icon,
                    "repeatable" to true, "createdAt" to 1, "updatedAt" to 1)
                dirty["rewards/$sid"] = 1
            }
        }
        seeded = true
        save()
    }

    private fun changed(local: Boolean = true) {
        cache = null
        save()
        _version.value = _version.value + 1
        if (local) onLocalChange?.invoke()
    }

    // ---- generic records --------------------------------------------------

    fun get(coll: String, id: String): JSONObject? = colls.getValue(coll)[id]?.takeIf { !it.bool("deleted") }
    fun all(coll: String): List<JSONObject> = colls.getValue(coll).values.filter { !it.bool("deleted") }

    private fun put(coll: String, rec: JSONObject): JSONObject {
        val old = colls.getValue(coll)[rec.str("id")]
        rec.put("updatedAt", max(System.currentTimeMillis(), (old?.optLong("updatedAt") ?: 0) + 1))
        colls.getValue(coll)[rec.str("id")] = rec
        dirty["$coll/${rec.str("id")}"] = rec.getLong("updatedAt")
        return rec
    }

    private fun del(coll: String, id: String) {
        val old = colls.getValue(coll)[id] ?: return
        if (!old.bool("deleted")) put(coll, jobj("id" to id, "deleted" to true))
    }

    private fun patch(coll: String, id: String, fields: Map<String, Any?>): JSONObject? {
        val r = get(coll, id)?.copy() ?: return null
        for ((k, v) in fields) r.put(k, v ?: JSONObject.NULL)
        return put(coll, r)
    }

    // ---- sync hooks -------------------------------------------------------

    fun dirtyCount() = dirty.size

    @Synchronized
    fun collectDirty(maxN: Int = 2000): Pair<JSONArray, Map<String, Long>> {
        val changes = JSONArray()
        val marks = mutableMapOf<String, Long>()
        for ((key, at) in dirty.toMap()) {
            if (changes.length() >= maxN) break
            val c = key.substringBefore('/')
            val id = key.substringAfter('/')
            val r = colls[c]?.get(id)
            if (r == null) { dirty.remove(key); continue }
            changes.put(jobj("c" to c, "r" to r))
            marks[key] = at
        }
        return changes to marks
    }

    @Synchronized
    fun applyRemote(changes: JSONArray, newCursor: Long, marks: Map<String, Long>): Int {
        var touched = 0
        for ((k, at) in marks) if (dirty[k] == at) dirty.remove(k)
        for (i in 0 until changes.length()) {
            val ch = changes.getJSONObject(i)
            val c = ch.str("c")
            val r = ch.getJSONObject("r")
            val m = colls[c] ?: continue
            val id = r.str("id")
            val local = m[id]
            val ru = r.optLong("updatedAt")
            if (dirty.containsKey("$c/$id") && local != null && local.optLong("updatedAt") > ru) continue
            if (local == null || ru >= local.optLong("updatedAt")) {
                if (local == null || local.toString() != r.toString()) { m[id] = r; touched++ }
            }
        }
        cursor = max(cursor, newCursor)
        val cutoff = System.currentTimeMillis() - TOMBSTONE_TTL
        for ((c, m) in colls) m.entries.removeIf { (id, r) -> r.bool("deleted") && r.optLong("updatedAt") < cutoff && !dirty.containsKey("$c/$id") }
        changed(local = false)
        return touched
    }

    // ---- derived ------------------------------------------------------------

    private class Derived(
        val lifetime: Int, val balance: Int, val doneByDay: Map<String, Int>, val activeDays: Set<String>,
        val questMs: Map<String, Long>, val stepMs: Map<String, Long>, val focusByDay: Map<String, Long>, val checkins: Set<String>,
    )

    private fun derived(): Derived {
        cache?.let { return it }
        var lifetime = 0
        var balance = 0
        val doneByDay = mutableMapOf<String, Int>()
        val active = mutableSetOf<String>()
        val questMs = mutableMapOf<String, Long>()
        val stepMs = mutableMapOf<String, Long>()
        val focus = mutableMapOf<String, Long>()
        for (l in all("ledger")) {
            val a = l.optInt("amount")
            balance += a
            if (a > 0) lifetime += a
            val day = dateKeyOf(l.optLong("at"))
            when (l.str("kind")) {
                "quest" -> { doneByDay[day] = (doneByDay[day] ?: 0) + 1; active += day }
                "habit" -> active += day
            }
        }
        for (s in all("sessions")) {
            val q = s.str("questId")
            if (q.isNotEmpty()) questMs[q] = (questMs[q] ?: 0) + s.optLong("durationMs")
            val st = s.str("stepId")
            if (q.isNotEmpty() && st.isNotEmpty()) stepMs["$q/$st"] = (stepMs["$q/$st"] ?: 0) + s.optLong("durationMs")
            if (s.str("kind") != "break") focus[s.str("date")] = (focus[s.str("date")] ?: 0) + s.optLong("durationMs")
        }
        val checkins = all("checkins").map { it.str("id") }.toSet()
        return Derived(lifetime, balance, doneByDay, active, questMs, stepMs, focus, checkins).also { cache = it }
    }

    val xp get() = derived().lifetime
    val balance get() = derived().balance
    fun completedOn(key: String = dateKey()) = derived().doneByDay[key] ?: 0

    fun focusOn(key: String = dateKey(), now: Long = System.currentTimeMillis()): Long {
        var ms = derived().focusByDay[key] ?: 0
        if (key == dateKey()) for (t in runningTimers()) if (t.kind != "break") ms += liveSegment(t, now)
        return ms
    }

    fun streak(): Int {
        val days = derived().activeDays
        var d = LocalDate.now()
        if (!days.contains(dateKey(d))) d = d.minusDays(1)
        var n = 0
        while (days.contains(dateKey(d))) { n++; d = d.minusDays(1) }
        return n
    }

    // ---- quests -------------------------------------------------------------

    val quests get() = all("quests")
    fun getQuest(id: String) = get("quests", id)
    fun openQuests() = quests.filter { !it.bool("done") }.sortedBy { it.optLong("createdAt") }

    fun visibleQuests(quadrant: String): List<JSONObject> {
        val today = dateKey()
        val order = { q: JSONObject -> q.optJSONObject("due")?.str("date")?.ifEmpty { null } ?: "9999" }
        val inQ = quests.filter { it.str("quadrant") == quadrant }
            .sortedWith(compareBy<JSONObject>({ order(it) }, { it.optLong("createdAt") }))
        return inQ.filter { !it.bool("done") } +
            inQ.filter { it.bool("done") && !it.isNull("doneAt") && dateKeyOf(it.optLong("doneAt")) == today }
    }

    fun dueOn(key: String) = openQuests().filter { it.optJSONObject("due")?.str("date") == key }
    fun scheduledOn(key: String) = quests.filter { it.optJSONObject("scheduled")?.str("date") == key }

    fun addQuest(title: String, quadrant: String = "q1", scheduled: JSONObject? = null, due: JSONObject? = null,
                 goalId: String? = null): JSONObject? {
        val t = title.trim()
        if (t.isEmpty()) return null
        val q = put("quests", jobj("id" to uid(), "title" to t, "quadrant" to quadrant, "done" to false, "doneAt" to null,
            "createdAt" to System.currentTimeMillis(), "scheduled" to scheduled, "notes" to "", "due" to due))
        if (goalId != null) q.put("goalId", goalId)
        changed()
        return q
    }

    fun updateQuest(id: String, fields: Map<String, Any?>) {
        val f = if (fields.containsKey("quadrant")) fields + ("quadrantManual" to true) else fields
        if (patch("quests", id, f) != null) {
            if (fields.containsKey("scheduled")) reminded.remove(id)
            changed()
        }
    }

    fun setDone(id: String, done: Boolean) {
        val q = getQuest(id) ?: return
        if (q.bool("done") == done) return
        val now = System.currentTimeMillis()
        if (done) {
            for (t in timers) if (t.questId == id && t.startedAt != null) credit(t, now)
            creditSlot(q, now)
            val steps = q.optJSONArray("steps") ?: JSONArray()
            val newSteps = JSONArray()
            for (i in 0 until steps.length()) {
                val st = steps.getJSONObject(i).copy()
                if (!st.bool("done")) {
                    st.put("done", true)
                    put("ledger", jobj("id" to "step.$id.${st.str("id")}", "at" to now, "amount" to STEP_XP, "kind" to "step", "ref" to id, "note" to st.str("title")))
                }
                newSteps.put(st)
            }
            val fields = mutableMapOf<String, Any?>("done" to true, "doneAt" to now)
            if (steps.length() > 0) fields["steps"] = newSteps
            patch("quests", id, fields)
            val bonus = if (steps.length() > 0) groupBonus(q) else 0
            put("ledger", jobj("id" to "quest.$id", "at" to now, "amount" to questXp(q) + bonus, "kind" to "quest", "ref" to id,
                "note" to if (bonus > 0) "${q.str("title")} (+$bonus group bonus)" else q.str("title")))
        } else {
            patch("quests", id, mapOf("done" to false, "doneAt" to null))
            del("ledger", "quest.$id")
            del("sessions", "slot.$id")
        }
        changed()
    }

    /** The window a quest was planned for: its time slot, else its linked calendar event (ms). */
    fun questSlot(q: JSONObject): Pair<Long, Long>? {
        val sc = q.optJSONObject("scheduled")
        val et = q.optJSONObject("eventTime")
        val dueDate = q.optJSONObject("due")?.str("date").orEmpty()
        val (date, start, end) = when {
            sc != null && sc.str("date").isNotEmpty() -> Triple(sc.str("date"), sc.optInt("start"), sc.optInt("start") + sc.optInt("duration", 60))
            et != null && dueDate.isNotEmpty() -> {
                val a = et.optInt("start"); val b = et.optInt("end")
                Triple(dueDate, a, if (b > a) b else b + 24 * 60)
            }
            else -> return null
        }
        val base = LocalDate.parse(date).atStartOfDay(ZoneId.systemDefault())
        return base.plusMinutes(start.toLong()).toInstant().toEpochMilli() to base.plusMinutes(end.toLong()).toInstant().toEpochMilli()
    }

    /**
     * Ticking off a quest with a time slot counts the slot as time spent (quest, goal, stats):
     * only the part already passed, minus time timers already tracked inside it.
     */
    private fun creditSlot(q: JSONObject, now: Long) {
        val (start, slotEnd) = questSlot(q) ?: return
        val end = min(slotEnd, now)
        if (end <= start) return
        val id = q.str("id")
        var covered = 0L
        for (s in all("sessions")) if (s.str("questId") == id && s.str("id") != "slot.$id")
            covered += max(0L, min(s.optLong("end"), end) - max(s.optLong("start"), start))
        val ms = end - start - covered
        if (ms < 60_000) return
        put("sessions", jobj("id" to "slot.$id", "questId" to id, "stepId" to null, "kind" to "slot", "start" to start, "end" to end,
            "durationMs" to ms, "date" to dateKeyOf(start), "topic" to q.str("topic").ifEmpty { null }))
    }

    // ---- steps (a quest with steps is a "group") ----------------------------

    fun steps(q: JSONObject): List<JSONObject> = q.optJSONArray("steps")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) } } ?: emptyList()

    fun addStep(questId: String, title: String) {
        val q = getQuest(questId) ?: return
        val t = title.trim()
        if (t.isEmpty()) return
        val arr = JSONArray(steps(q).map { it.copy() } + jobj("id" to uid(), "title" to t, "done" to false))
        val f = mutableMapOf<String, Any?>("steps" to arr)
        if (q.bool("done")) { f["done"] = false; f["doneAt"] = null; del("ledger", "quest.$questId") }
        patch("quests", questId, f)
        changed()
    }

    fun toggleStep(questId: String, stepId: String) {
        val q = getQuest(questId) ?: return
        val now = System.currentTimeMillis()
        val list = steps(q).map { it.copy() }
        val st = list.find { it.str("id") == stepId } ?: return
        st.put("done", !st.bool("done"))
        if (st.bool("done")) put("ledger", jobj("id" to "step.$questId.$stepId", "at" to now, "amount" to STEP_XP, "kind" to "step", "ref" to questId, "note" to st.str("title")))
        else del("ledger", "step.$questId.$stepId")
        val allDone = list.isNotEmpty() && list.all { it.bool("done") }
        if (allDone && !q.bool("done")) {
            patch("quests", questId, mapOf("steps" to JSONArray(list)))
            changed()
            setDone(questId, true)
            return
        }
        if (!st.bool("done") && q.bool("done")) {
            patch("quests", questId, mapOf("steps" to JSONArray(list), "done" to false, "doneAt" to null))
            del("ledger", "quest.$questId")
        } else patch("quests", questId, mapOf("steps" to JSONArray(list)))
        changed()
    }

    fun deleteStep(questId: String, stepId: String) {
        val q = getQuest(questId) ?: return
        val now = System.currentTimeMillis()
        for (t in timers) if (t.questId == questId && t.stepId == stepId) {
            if (t.startedAt != null) { credit(t, now); t.startedAt = now } // keeps running for the quest as a whole
            t.stepId = null
        }
        patch("quests", questId, mapOf("steps" to JSONArray(steps(q).filter { it.str("id") != stepId })))
        changed()
    }

    /** Link one step to a long-term goal (null = unlink). */
    fun setStepGoal(questId: String, stepId: String, goalId: String?) {
        val q = getQuest(questId) ?: return
        val arr = JSONArray(steps(q).map { st -> st.copy().also { if (it.str("id") == stepId) it.put("goalId", goalId ?: JSONObject.NULL) } })
        patch("quests", questId, mapOf("steps" to arr))
        changed()
    }

    fun stepTimeMs(questId: String, stepId: String, now: Long = System.currentTimeMillis()): Long {
        var ms = derived().stepMs["$questId/$stepId"] ?: 0
        for (t in timers) if (t.questId == questId && t.stepId == stepId && t.startedAt != null) ms += liveSegment(t, now)
        return ms
    }

    fun isStepRunning(questId: String, stepId: String) = timers.any { it.questId == questId && it.stepId == stepId && it.startedAt != null }

    /** Play/pause the Pomodoro of one step (resumes a paused one, otherwise starts a new one). */
    fun toggleStepPomodoro(questId: String, stepId: String, minutes: Int): Timer {
        val mine = timers.filter { it.questId == questId && it.stepId == stepId }
        mine.find { it.startedAt != null }?.let { pauseTimer(it.id); return it }
        mine.find { it.kind == "pomodoro" && !it.finished && it.elapsedMs < it.durationMs }?.let { startTimer(it.id); return it }
        return startPomodoro(questId, minutes, stepId)
    }

    // ---- goals (long-term; quests and single steps link to them) -------------

    fun goals() = all("goals").sortedWith(compareBy<JSONObject>({ it.bool("done") }, { it.optLong("createdAt") }))
    fun getGoal(id: String?) = if (id.isNullOrEmpty()) null else get("goals", id)

    fun addGoal(title: String): JSONObject? {
        val t = title.trim()
        if (t.isEmpty()) return null
        val g = put("goals", jobj("id" to uid(), "title" to t, "notes" to "", "icon" to "target", "targetDate" to null,
            "done" to false, "doneAt" to null, "createdAt" to System.currentTimeMillis()))
        changed()
        return g
    }

    fun updateGoal(id: String, fields: Map<String, Any?>) { if (patch("goals", id, fields) != null) changed() }

    /** Linked quests/steps keep their goalId; it simply no longer resolves. XP stays. */
    fun deleteGoal(id: String) { del("goals", id); changed() }

    fun setGoalDone(id: String, done: Boolean) {
        val g = getGoal(id) ?: return
        if (g.bool("done") == done) return
        val now = System.currentTimeMillis()
        patch("goals", id, mapOf("done" to done, "doneAt" to if (done) now else null))
        if (done) put("ledger", jobj("id" to "goal.$id", "at" to now, "amount" to GOAL_XP, "kind" to "goal", "ref" to id, "note" to g.str("title")))
        else del("ledger", "goal.$id")
        changed()
    }

    data class GoalItems(val quests: List<JSONObject>, val steps: List<Pair<JSONObject, JSONObject>>)
    data class GoalProgress(val done: Int, val total: Int, val frac: Float, val ms: Long)

    /** Quests linked as a whole, plus single steps linked from quests that are not themselves linked. */
    fun goalItems(goalId: String): GoalItems {
        val qs = mutableListOf<JSONObject>()
        val sts = mutableListOf<Pair<JSONObject, JSONObject>>()
        for (q in quests) {
            if (q.str("goalId") == goalId) { qs += q; continue }
            for (st in steps(q)) if (st.str("goalId") == goalId) sts += q to st
        }
        return GoalItems(qs.sortedWith(compareBy<JSONObject>({ it.bool("done") }, { it.optLong("createdAt") })), sts)
    }

    /** An open quest with steps counts by its finished share. */
    fun goalProgress(goalId: String, now: Long = System.currentTimeMillis()): GoalProgress {
        val items = goalItems(goalId)
        var done = 0; var share = 0f; var ms = 0L
        for (q in items.quests) {
            val st = steps(q)
            if (q.bool("done")) done++
            share += if (q.bool("done")) 1f else if (st.isNotEmpty()) st.count { it.bool("done") }.toFloat() / st.size else 0f
            ms += questTimeMs(q, now)
        }
        for ((q, st) in items.steps) {
            if (st.bool("done")) { done++; share += 1f }
            ms += stepTimeMs(q.str("id"), st.str("id"), now)
        }
        val total = items.quests.size + items.steps.size
        return GoalProgress(done, total, if (total > 0) share / total else 0f, ms)
    }

    fun deleteQuest(id: String) {
        val now = System.currentTimeMillis()
        for (t in timers) if (t.questId == id) { if (t.startedAt != null) credit(t, now); t.questId = null; t.stepId = null }
        del("quests", id)
        changed()
    }

    fun clearCompleted() {
        for (q in quests.filter { it.bool("done") }) {
            for (t in timers) if (t.questId == q.str("id")) { t.questId = null; t.stepId = null }
            del("quests", q.str("id"))
        }
        changed()
    }

    fun questTimeMs(q: JSONObject, now: Long = System.currentTimeMillis()): Long {
        var ms = derived().questMs[q.str("id")] ?: 0
        for (t in timers) if (t.questId == q.str("id") && t.startedAt != null) ms += liveSegment(t, now)
        return ms
    }

    fun isQuestRunning(id: String) = timers.any { it.questId == id && it.startedAt != null }

    /** Scheduled quests in the next 24 h that still need a reminder alarm. */
    fun upcomingScheduled(now: Long = System.currentTimeMillis()): List<Pair<JSONObject, Long>> {
        val zone = ZoneId.systemDefault()
        return openQuests().mapNotNull { q ->
            val s = q.optJSONObject("scheduled") ?: return@mapNotNull null
            val start = LocalDate.parse(s.str("date")).atStartOfDay(zone).toInstant().toEpochMilli() + s.optLong("start") * 60_000
            if (start in now..(now + DAY_MS)) q to start else null
        }
    }

    // ---- topics & stats (same rules as extension/store.js) -------------------

    fun topics(): List<String> {
        val seen = mutableMapOf<String, Long>()
        for (q in quests) q.str("topic").takeIf { it.isNotEmpty() }?.let { seen[it] = maxOf(seen[it] ?: 0, q.optLong("updatedAt")) }
        for (s in all("sessions")) s.str("topic").takeIf { it.isNotEmpty() }?.let { seen[it] = maxOf(seen[it] ?: 0, s.optLong("end")) }
        return seen.entries.sortedByDescending { it.value }.map { it.key }
    }

    data class DayStat(val date: String, val focusMs: Long, val done: Int)
    data class Stats(val focusMs: Long, val xp: Int, val questsDone: Int, val pomodoros: Int,
                     val byTopic: List<Pair<String, Long>>, val byGoal: List<Pair<String, Long>>, val topQuests: List<Pair<String, Long>>,
                     val daily: List<DayStat>, val streak: Int, val bestStreak: Int)

    fun stats(days: Int = 7): Stats {
        val today = LocalDate.now()
        val from = if (days > 0) dateKey(today.minusDays((days - 1).toLong())) else ""
        fun inRange(k: String) = from.isEmpty() || k >= from
        val byTopic = mutableMapOf<String, Long>()
        val byQuest = mutableMapOf<String, Long>()
        val byGoal = mutableMapOf<String, Long>()
        var focus = 0L
        for (s in all("sessions")) {
            if (s.str("kind") == "break" || !inRange(s.str("date"))) continue
            val ms = s.optLong("durationMs")
            focus += ms
            val qid = s.str("questId")
            val q = if (qid.isNotEmpty()) colls.getValue("quests")[qid] else null
            val topic = s.str("topic").ifEmpty { if (q != null && !q.bool("deleted")) q.str("topic") else "" }.ifEmpty { "No topic" }
            byTopic[topic] = (byTopic[topic] ?: 0) + ms
            if (qid.isNotEmpty()) byQuest[qid] = (byQuest[qid] ?: 0) + ms
            if (q != null && !q.bool("deleted")) {
                val sid = s.str("stepId")
                val gid = q.str("goalId").ifEmpty { steps(q).find { it.str("id") == sid && sid.isNotEmpty() }?.str("goalId") ?: "" }
                if (getGoal(gid) != null) byGoal[gid] = (byGoal[gid] ?: 0) + ms
            }
        }
        var xp = 0; var done = 0; var pomos = 0
        for (l in all("ledger")) {
            if (!inRange(dateKeyOf(l.optLong("at")))) continue
            val a = l.optInt("amount"); if (a > 0) xp += a
            when (l.str("kind")) { "quest" -> done++; "pomodoro" -> pomos++ }
        }
        val d = derived()
        val daily = (6 downTo 0).map { i -> val k = dateKey(today.minusDays(i.toLong())); DayStat(k, d.focusByDay[k] ?: 0, d.doneByDay[k] ?: 0) }
        var best = 0; var run = 0; var prev: LocalDate? = null
        for (k in d.activeDays.sorted()) {
            val cur = LocalDate.parse(k)
            run = if (prev != null && prev.plusDays(1) == cur) run + 1 else 1
            best = maxOf(best, run); prev = cur
        }
        val title = { id: String -> colls.getValue("quests")[id]?.takeIf { !it.bool("deleted") }?.str("title") ?: "(deleted quest)" }
        return Stats(focus, xp, done, pomos, byTopic.entries.sortedByDescending { it.value }.map { it.key to it.value },
            byGoal.entries.sortedByDescending { it.value }.map { (getGoal(it.key)?.str("title") ?: "(deleted goal)") to it.value },
            byQuest.entries.sortedByDescending { it.value }.take(5).map { title(it.key) to it.value }, daily, streak(), best)
    }

    // ---- habits -------------------------------------------------------------

    fun habits() = all("habits").filter { !it.bool("archived") }.sortedBy { it.optLong("order", it.optLong("createdAt")) }

    fun addHabit(title: String, icon: String = "star", xp: Int = 10, target: Int = 7): JSONObject? {
        val t = title.trim()
        if (t.isEmpty()) return null
        val h = put("habits", jobj("id" to uid(), "title" to t, "icon" to icon, "xp" to max(1, xp), "target" to min(7, max(1, target)),
            "createdAt" to System.currentTimeMillis(), "archived" to false))
        changed()
        return h
    }

    fun updateHabit(id: String, fields: Map<String, Any?>) { if (patch("habits", id, fields) != null) changed() }
    fun deleteHabit(id: String) { del("habits", id); changed() }
    fun isChecked(habitId: String, key: String = dateKey()) = derived().checkins.contains("$habitId.$key")

    fun habitStreak(habitId: String): Int {
        var d = LocalDate.now()
        if (!isChecked(habitId, dateKey(d))) d = d.minusDays(1)
        var n = 0
        while (isChecked(habitId, dateKey(d))) { n++; d = d.minusDays(1) }
        return n
    }

    fun habitWeekCount(habitId: String, day: LocalDate = LocalDate.now()): Int {
        val start = day.minusDays((day.dayOfWeek.value - 1).toLong())
        return (0..6).count { isChecked(habitId, dateKey(start.plusDays(it.toLong()))) }
    }

    fun toggleCheckin(habitId: String, key: String = dateKey()) {
        val h = get("habits", habitId) ?: return
        val id = "$habitId.$key"
        if (isChecked(habitId, key)) {
            del("checkins", id)
            del("ledger", "habit.$id")
        } else {
            put("checkins", jobj("id" to id, "habitId" to habitId, "date" to key))
            cache = null
            var d = LocalDate.parse(key)
            var n = 0
            while (derived().checkins.contains("$habitId.${dateKey(d)}")) { n++; d = d.minusDays(1) }
            val at = if (key == dateKey()) System.currentTimeMillis()
                     else LocalDate.parse(key).atTime(12, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            put("ledger", jobj("id" to "habit.$id", "at" to at, "amount" to habitXp(h.optInt("xp", 10), n), "kind" to "habit",
                "ref" to habitId, "note" to h.str("title")))
        }
        changed()
    }

    // ---- rewards --------------------------------------------------------------

    fun rewards() = all("rewards").filter { it.isNull("redeemedAt") || !it.has("redeemedAt") }.sortedBy { it.optInt("cost") }

    fun addReward(title: String, cost: Int, icon: String = "gift", repeatable: Boolean = true): JSONObject? {
        val t = title.trim()
        if (t.isEmpty() || cost <= 0) return null
        val r = put("rewards", jobj("id" to uid(), "title" to t, "cost" to cost, "icon" to icon, "repeatable" to repeatable,
            "createdAt" to System.currentTimeMillis()))
        changed()
        return r
    }

    fun updateReward(id: String, fields: Map<String, Any?>) { if (patch("rewards", id, fields) != null) changed() }
    fun deleteReward(id: String) { del("rewards", id); changed() }

    fun buy(rewardId: String): Boolean {
        val r = get("rewards", rewardId) ?: return false
        if (balance < r.optInt("cost")) return false
        val now = System.currentTimeMillis()
        put("ledger", jobj("id" to "buy.${uid()}", "at" to now, "amount" to -r.optInt("cost"), "kind" to "purchase",
            "ref" to rewardId, "note" to r.str("title")))
        if (!r.optBoolean("repeatable", true)) patch("rewards", rewardId, mapOf("redeemedAt" to now))
        changed()
        return true
    }

    fun purchases(limit: Int = 20) = all("ledger").filter { it.str("kind") == "purchase" }.sortedByDescending { it.optLong("at") }.take(limit)

    fun refund(ledgerId: String) {
        val l = get("ledger", ledgerId) ?: return
        if (l.str("kind") != "purchase") return
        del("ledger", ledgerId)
        val r = colls.getValue("rewards")[l.str("ref")]
        if (r != null && !r.bool("deleted") && r.has("redeemedAt") && !r.isNull("redeemedAt")) put("rewards", r.copy().put("redeemedAt", JSONObject.NULL))
        changed()
    }

    // ---- timers ----------------------------------------------------------------

    fun runningTimers() = timers.filter { it.startedAt != null }
    fun getTimer(id: String) = timers.find { it.id == id }

    private fun liveSegment(t: Timer, now: Long): Long {
        val s = t.startedAt ?: return 0
        var seg = max(0, now - s)
        if (t.mode == "countdown") seg = min(seg, max(0, t.durationMs - t.elapsedMs))
        return seg
    }

    fun timerElapsed(t: Timer, now: Long = System.currentTimeMillis()) = t.elapsedMs + liveSegment(t, now)
    fun timerRemaining(t: Timer, now: Long = System.currentTimeMillis()) = max(0, t.durationMs - timerElapsed(t, now))
    /** Wall-clock time a running countdown ends (for alarms / chronometer notifications). */
    fun timerEndsAt(t: Timer): Long? = t.startedAt?.let { if (t.mode == "countdown") it + (t.durationMs - t.elapsedMs) else null }

    private fun credit(t: Timer, now: Long) {
        val seg = liveSegment(t, now)
        t.elapsedMs += seg
        t.startedAt = null
        if (seg < 1000) return
        val topic = t.questId?.let { getQuest(it)?.str("topic") }?.ifEmpty { null }
        put("sessions", jobj("id" to uid(), "questId" to t.questId, "stepId" to t.stepId, "kind" to t.kind, "start" to now - seg, "end" to now,
            "durationMs" to seg, "date" to dateKeyOf(now - seg), "topic" to topic))
    }

    fun addTimer(mode: String, kind: String, durationMs: Long, questId: String?, label: String? = null, stepId: String? = null): Timer {
        val q = questId?.let { getQuest(it) }
        val t = Timer(uid(), label ?: timerLabel(questId, stepId) ?: if (mode == "stopwatch") "Stopwatch" else "Timer", mode, kind, durationMs,
            questId, startedAt = System.currentTimeMillis(), stepId = if (q != null) stepId else null)
        timers.add(0, t)
        changed()
        return t
    }

    fun startTimer(id: String) {
        val t = getTimer(id) ?: return
        if (t.startedAt != null) return
        if (t.finished || (t.mode == "countdown" && t.elapsedMs >= t.durationMs)) { t.elapsedMs = 0; t.finished = false }
        t.startedAt = System.currentTimeMillis()
        changed()
    }

    fun pauseTimer(id: String) {
        val t = getTimer(id) ?: return
        if (t.startedAt == null) return
        credit(t, System.currentTimeMillis())
        changed()
    }

    fun toggleTimer(id: String) { if (getTimer(id)?.startedAt != null) pauseTimer(id) else startTimer(id) }

    fun resetTimer(id: String) {
        val t = getTimer(id) ?: return
        if (t.startedAt != null) credit(t, System.currentTimeMillis())
        t.elapsedMs = 0
        t.finished = false
        changed()
    }

    fun removeTimer(id: String) {
        val t = getTimer(id) ?: return
        if (t.startedAt != null) credit(t, System.currentTimeMillis())
        timers.remove(t)
        changed()
    }

    fun linkTimer(id: String, questId: String?) {
        val t = getTimer(id) ?: return
        if (t.startedAt != null) { credit(t, System.currentTimeMillis()); t.startedAt = System.currentTimeMillis() }
        t.questId = questId
        t.stepId = null
        val q = questId?.let { getQuest(it) }
        if (q != null && (t.kind == "stopwatch" || t.kind == "custom")) t.label = q.str("title")
        changed()
    }

    fun toggleQuestTimer(questId: String) {
        timers.find { it.questId == questId && it.startedAt != null }?.let { pauseTimer(it.id); return }
        val existing = timers.find { it.questId == questId && it.stepId == null && it.mode == "stopwatch" }
        if (existing != null) startTimer(existing.id) else addTimer("stopwatch", "stopwatch", 0, questId)
    }

    /** "Quest" or "Quest › Step". */
    fun timerLabel(questId: String?, stepId: String? = null): String? {
        val q = questId?.let { getQuest(it) } ?: return null
        val st = stepId?.let { sid -> steps(q).find { it.str("id") == sid } }
        return if (st != null) "${q.str("title")} › ${st.str("title")}" else q.str("title")
    }

    fun startPomodoro(questId: String?, minutes: Int, stepId: String? = null) =
        addTimer("countdown", "pomodoro", minutes * 60_000L, questId, timerLabel(questId, stepId) ?: "Focus", stepId)

    data class FocusBlock(val id: String, val title: String, val questId: String?, val start: Long, val end: Long, val live: Boolean)

    /**
     * Pomodoro time on one day, for the calendar: finished or paused segments (synced
     * sessions) plus running Pomodoros, drawn from their start to their planned end.
     */
    fun focusBlocks(key: String = dateKey()): List<FocusBlock> {
        val out = mutableListOf<FocusBlock>()
        for (s in all("sessions")) {
            if (s.str("kind") != "pomodoro" || s.str("date") != key) continue
            val qid = s.str("questId").ifEmpty { null }
            out += FocusBlock(s.str("id"), timerLabel(qid, s.str("stepId").ifEmpty { null }) ?: "Focus", qid,
                s.optLong("start"), s.optLong("end"), false)
        }
        for (t in timers) {
            val st = t.startedAt ?: continue
            if (t.kind != "pomodoro" || dateKeyOf(st) != key) continue
            out += FocusBlock(t.id, t.label, t.questId, st, st + max(0, t.durationMs - t.elapsedMs), true)
        }
        return out.sortedBy { it.start }
    }

    fun startBreak(minutes: Int) = addTimer("countdown", "break", minutes * 60_000L, null, "Break")

    /** Finish countdowns whose time is up. Returns them (for notifications). */
    fun tick(now: Long = System.currentTimeMillis()): List<Timer> {
        val finished = mutableListOf<Timer>()
        for (t in timers) {
            if (t.mode != "countdown" || t.startedAt == null) continue
            if (timerElapsed(t, now) >= t.durationMs) {
                credit(t, now)
                t.finished = true
                if (t.kind == "pomodoro") put("ledger", jobj("id" to "pomo.${t.id}.$now", "at" to now, "amount" to POMODORO_XP,
                    "kind" to "pomodoro", "ref" to t.questId, "note" to t.label))
                finished += t
            }
        }
        if (finished.isNotEmpty()) changed()
        return finished
    }
}

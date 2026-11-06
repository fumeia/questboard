package com.questboard.app.sys

import com.questboard.app.data.Store
import com.questboard.app.data.jobj
import com.questboard.app.data.str
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Every event of the phone calendar named "Lernplan" (lectures and tutorials) becomes a calendar quest: shown on its event in
 * quest colours, NOT in the matrix, and linked to the course goal by its title, so a goal's numbers count the sessions you
 * should attend. Tick it (tap the event) once you went. Runs when the app opens; the desktop only shows these quests.
 */
object Lernplan {
    const val CALENDAR = "Lernplan"
    const val SOURCE = "lernplan"
    private const val XP = 20                 // per attended session (an exercise sheet is 40)
    private const val PAST_DAYS = 120L        // the semester so far
    private const val AHEAD_DAYS = 200L       // up to the exams

    /** Event title word -> word the goal title must contain (hardcoded for now). */
    private val RULES = listOf(
        "astrophysi" to "astro",                       // "Astrophysics" / "Astrophysik" -> "5.5 in Astro"
        "quantenmechanik" to "qm",                     // -> "5.5 in QM 1"
        "festkörperphysik" to "festkörperphysik",      // -> "5.0 in Festkörperphysik"
    )

    fun goalFor(title: String, goals: List<JSONObject>): String? {
        val t = title.lowercase()
        val want = RULES.firstOrNull { t.contains(it.first) }?.second ?: return null
        val word = Regex("(?<![\\p{L}])" + Regex.escape(want))
        return goals.filter { !it.optBoolean("done") && !it.optBoolean("deleted") && word.containsMatchIn(it.str("title").lowercase()) }
            .maxByOrNull { it.optLong("createdAt") }?.str("id")
    }

    private fun idOf(key: String) = "cal." + MessageDigest.getInstance("SHA-1").digest(key.toByteArray())
        .joinToString("") { "%02x".format(it) }.take(20)

    /** Returns the number of quests created, changed or removed, or -1 when there is no Lernplan calendar / no permission. */
    fun sync(repo: CalendarRepo, store: Store): Int {
        if (!repo.hasPermission()) return -1
        val cals = repo.calendars().filter { it.name.trim().equals(CALENDAR, ignoreCase = true) }.map { it.id }.toSet()
        if (cals.isEmpty()) return -1
        val zone = ZoneId.systemDefault()
        val from = LocalDate.now().minusDays(PAST_DAYS); val to = LocalDate.now().plusDays(AHEAD_DAYS)
        val events = repo.eventsBetween(from.atStartOfDay(zone).toInstant().toEpochMilli(), to.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli(), cals)
        val goals = store.goals()
        val wanted = events.map { e ->
            val start = Instant.ofEpochMilli(e.begin).atZone(zone)
            val date = start.toLocalDate().toString()
            val sMin = start.hour * 60 + start.minute
            val goal = goalFor(e.title, goals)
            jobj("id" to idOf((e.uid.ifEmpty { "a${e.id}" }) + "|" + date), "title" to e.title, "quadrant" to "q2", "xp" to XP,
                "due" to jobj("date" to date), "eventTime" to if (e.allDay) null else jobj("start" to sMin, "end" to sMin + ((e.end - e.begin) / 60000).toInt()),
                "gcal" to jobj("source" to "", "uid" to e.uid, "rid" to "", "android" to e.id),
                "source" to SOURCE, "inMatrix" to false, "goalId" to goal, "goalAuto" to goal)
        }
        return store.syncCalendarQuests(SOURCE, wanted, from.toString(), to.toString())
    }
}

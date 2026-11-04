package com.questboard.app.sys

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.CalendarContract
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.questboard.app.MainActivity
import com.questboard.app.QuestboardApp
import com.questboard.app.R
import com.questboard.app.data.Timer
import com.questboard.app.data.str
import java.time.LocalDate
import java.time.ZoneId
import java.util.TimeZone

// ------------------------------------------------------------- notifications

class Notifier(private val ctx: Context) {
    private val nm = ctx.getSystemService(NotificationManager::class.java)

    init {
        nm.createNotificationChannel(NotificationChannel(CH_TIMER, "Running timer", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_ALERT, "Timers & reminders", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_MISC, "Updates", NotificationManager.IMPORTANCE_DEFAULT))
    }

    private fun can() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openApp(tab: String) = PendingIntent.getActivity(ctx, tab.hashCode(),
        Intent(ctx, MainActivity::class.java).putExtra("tab", tab).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    /** Ongoing notification with a system-drawn countdown/stopwatch — no app process needed to tick. */
    fun showRunning(t: Timer?, endsAt: Long?, startedEquivalent: Long?) {
        if (!can()) return
        if (t == null) { nm.cancel(ID_RUNNING); return }
        val b = NotificationCompat.Builder(ctx, CH_TIMER)
            .setSmallIcon(R.drawable.qb_stopwatch)
            .setContentTitle(t.label)
            .setContentText(when (t.kind) { "pomodoro" -> "Focus session"; "break" -> "Break"; "stopwatch" -> "Stopwatch"; else -> "Countdown" })
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setContentIntent(openApp("timers"))
            .setUsesChronometer(true)
        if (endsAt != null) { b.setWhen(endsAt); b.setChronometerCountDown(true) } else b.setWhen(startedEquivalent ?: System.currentTimeMillis())
        nm.notify(ID_RUNNING, b.build())
    }

    fun alert(id: Int, title: String, body: String, tab: String = "timers") {
        if (!can()) return
        nm.notify(id, NotificationCompat.Builder(ctx, CH_ALERT).setSmallIcon(R.drawable.qb_sparkle)
            .setContentTitle(title).setContentText(body).setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setContentIntent(openApp(tab)).build())
    }

    fun updateAvailable(name: String, notes: String) {
        if (!can()) return
        nm.notify(ID_UPDATE, NotificationCompat.Builder(ctx, CH_MISC).setSmallIcon(R.drawable.qb_sparkle)
            .setContentTitle("Questboard $name available").setContentText(notes.ifEmpty { "Tap to install" })
            .setAutoCancel(true).setContentIntent(openApp("settings")).build())
    }

    companion object {
        const val CH_TIMER = "timer"
        const val CH_ALERT = "alert"
        const val CH_MISC = "misc"
        const val ID_RUNNING = 1
        const val ID_UPDATE = 2
    }
}

// ------------------------------------------------------------------- alarms

/** Exact alarms for countdown ends and scheduled-quest reminders. */
class Alarms(private val ctx: Context) {
    private val am = ctx.getSystemService(AlarmManager::class.java)

    private fun pi(action: String, code: Int, extra: String? = null) = PendingIntent.getBroadcast(ctx, code,
        Intent(ctx, AlarmReceiver::class.java).setAction(action).putExtra("id", extra),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun setAt(at: Long, p: PendingIntent) {
        if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p)
    }

    /** Re-plan everything from the store (cheap; called after each change). */
    fun refresh(app: QuestboardApp) {
        val s = app.store
        val running = s.runningTimers()
        val next = running.mapNotNull { s.timerEndsAt(it) }.minOrNull()
        val timerPi = pi(ACTION_TIMER, 1)
        if (next != null) setAt(next, timerPi) else am.cancel(timerPi)

        val t = running.firstOrNull { it.mode == "countdown" } ?: running.firstOrNull()
        app.notifier.showRunning(t, t?.let { s.timerEndsAt(it) }, t?.let { System.currentTimeMillis() - s.timerElapsed(it) })

        if (app.settings.reminders) {
            for ((q, at) in s.upcomingScheduled()) setAt(at, pi(ACTION_REMIND, q.str("id").hashCode(), q.str("id")))
        }
    }

    companion object {
        const val ACTION_TIMER = "com.questboard.TIMER"
        const val ACTION_REMIND = "com.questboard.REMIND"
    }
}

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as QuestboardApp
        when (intent.action) {
            Alarms.ACTION_TIMER -> {
                for (t in app.store.tick()) {
                    val (title, body) = when (t.kind) {
                        "pomodoro" -> "Pomodoro complete · +10 XP" to "Nice work on “${t.label}”. Time for a break."
                        "break" -> "Break over" to "Back to your quests."
                        else -> "Timer finished" to t.label
                    }
                    app.notifier.alert(t.id.hashCode(), title, body)
                }
                app.alarms.refresh(app)
            }
            Alarms.ACTION_REMIND -> {
                val q = intent.getStringExtra("id")?.let { app.store.getQuest(it) } ?: return
                if (q.optBoolean("done")) return
                app.notifier.alert(q.str("id").hashCode(), "Starting now: ${q.str("title")}",
                    "Scheduled quest · ${q.optJSONObject("scheduled")?.optInt("duration", 60) ?: 60} min", "matrix")
            }
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> app.alarms.refresh(app)
        }
    }
}

// ----------------------------------------------------------------- calendar

data class CalEvent(
    val id: Long, val calendarId: Long, val title: String, val begin: Long, val end: Long, val allDay: Boolean,
    val color: Int, val location: String, val description: String, val recurring: Boolean,
)

data class CalInfo(val id: Long, val name: String, val account: String, val color: Int, val writable: Boolean)

/** Reads/writes the phone's calendars (Google syncs them). */
class CalendarRepo(private val ctx: Context) {
    fun hasPermission() = ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED &&
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED

    fun calendars(): List<CalInfo> {
        if (!hasPermission()) return emptyList()
        val out = mutableListOf<CalInfo>()
        ctx.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, arrayOf(
            CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.CALENDAR_COLOR, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.VISIBLE,
        ), null, null, null)?.use { c ->
            while (c.moveToNext()) {
                if (c.getInt(5) == 0) continue
                out += CalInfo(c.getLong(0), c.getString(1) ?: "Calendar", c.getString(2) ?: "", c.getInt(3),
                    c.getInt(4) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR)
            }
        }
        return out
    }

    fun eventsOn(day: LocalDate): List<CalEvent> {
        if (!hasPermission()) return emptyList()
        val zone = ZoneId.systemDefault()
        val begin = day.atStartOfDay(zone).toInstant().toEpochMilli()
        val end = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, begin); ContentUris.appendId(it, end)
        }.build()
        val out = mutableListOf<CalEvent>()
        ctx.contentResolver.query(uri, arrayOf(
            CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.CALENDAR_ID, CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.DISPLAY_COLOR, CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.DESCRIPTION, CalendarContract.Instances.RRULE, CalendarContract.Instances.VISIBLE,
        ), null, null, CalendarContract.Instances.BEGIN)?.use { c ->
            while (c.moveToNext()) {
                if (c.getInt(10) == 0) continue
                var b = c.getLong(3)
                var e = c.getLong(4)
                val allDay = c.getInt(5) == 1
                if (allDay) { // all-day instances are stored in UTC
                    val d = java.time.Instant.ofEpochMilli(b).atZone(ZoneId.of("UTC")).toLocalDate()
                    b = d.atStartOfDay(zone).toInstant().toEpochMilli(); e = b + 86_400_000
                }
                out += CalEvent(c.getLong(0), c.getLong(1), c.getString(2) ?: "(no title)", b, e, allDay, c.getInt(6),
                    c.getString(7) ?: "", c.getString(8) ?: "", !c.getString(9).isNullOrEmpty())
            }
        }
        return out
    }

    private fun values(calId: Long?, title: String, begin: Long, end: Long, allDay: Boolean, location: String, desc: String) =
        ContentValues().apply {
            calId?.let { put(CalendarContract.Events.CALENDAR_ID, it) }
            put(CalendarContract.Events.TITLE, title)
            put(CalendarContract.Events.EVENT_LOCATION, location)
            put(CalendarContract.Events.DESCRIPTION, desc)
            put(CalendarContract.Events.ALL_DAY, if (allDay) 1 else 0)
            if (allDay) {
                val zone = ZoneId.systemDefault()
                val d = java.time.Instant.ofEpochMilli(begin).atZone(zone).toLocalDate()
                val utc = d.atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli()
                put(CalendarContract.Events.DTSTART, utc)
                put(CalendarContract.Events.DTEND, utc + 86_400_000)
                put(CalendarContract.Events.EVENT_TIMEZONE, "UTC")
            } else {
                put(CalendarContract.Events.DTSTART, begin)
                put(CalendarContract.Events.DTEND, end)
                put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
            }
        }

    fun create(calId: Long, title: String, begin: Long, end: Long, allDay: Boolean, location: String = "", desc: String = ""): Long? =
        ctx.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values(calId, title, begin, end, allDay, location, desc))
            ?.lastPathSegment?.toLongOrNull()

    /**
     * Edits an event. Recurring series store DURATION instead of DTEND, so for
     * those only title/location/notes change here (times: open the Calendar app).
     */
    fun update(eventId: Long, title: String, begin: Long, end: Long, allDay: Boolean, location: String, desc: String, recurring: Boolean): Boolean {
        val v = if (recurring) ContentValues().apply {
            put(CalendarContract.Events.TITLE, title)
            put(CalendarContract.Events.EVENT_LOCATION, location)
            put(CalendarContract.Events.DESCRIPTION, desc)
        } else values(null, title, begin, end, allDay, location, desc)
        return ctx.contentResolver.update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId), v, null, null) > 0
    }

    fun openInCalendarApp(eventId: Long) {
        ctx.startActivity(Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun delete(eventId: Long) =
        ctx.contentResolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId), null, null) > 0
}

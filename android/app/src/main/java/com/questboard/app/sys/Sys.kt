package com.questboard.app.sys

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.Service
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.CalendarContract
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.questboard.app.MainActivity
import com.questboard.app.QuestboardApp
import com.questboard.app.R
import com.questboard.app.data.Timer
import com.questboard.app.data.str
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.TimeZone

// ------------------------------------------------------------- notifications

class Notifier(private val ctx: Context) {
    private val nm = ctx.getSystemService(NotificationManager::class.java)

    init {
        // The old low-importance channel got hidden/collapsed on some phones; the live one is default + silent.
        nm.deleteNotificationChannel(CH_TIMER_OLD)
        nm.createNotificationChannel(NotificationChannel(CH_TIMER, "Running timer", NotificationManager.IMPORTANCE_DEFAULT).apply {
            setSound(null, null); enableVibration(false); setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(CH_ALERT, "Timers & reminders", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_MISC, "Updates", NotificationManager.IMPORTANCE_DEFAULT))
    }

    private fun can() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openApp(tab: String) = PendingIntent.getActivity(ctx, tab.hashCode(),
        Intent(ctx, MainActivity::class.java).putExtra("tab", tab).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    /**
     * Live timer notification: quest (› step) as title, "12 of 25 min · 13 min left", a progress
     * bar and a system-drawn countdown that keeps ticking between our refreshes.
     */
    fun runningNotification(app: QuestboardApp, t: Timer, now: Long = System.currentTimeMillis()): Notification {
        val s = app.store
        val elapsed = s.timerElapsed(t, now)
        val kind = when (t.kind) { "pomodoro" -> "Pomodoro"; "break" -> "Break"; "stopwatch" -> "Stopwatch"; else -> "Countdown" }
        fun action(code: String, act: String) = PendingIntent.getBroadcast(ctx, t.id.hashCode() * 31 + code.hashCode(),
            Intent(ctx, AlarmReceiver::class.java).setAction(act).putExtra("id", t.id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(ctx, CH_TIMER)
            .setSmallIcon(R.drawable.qb_stopwatch)
            .setContentTitle(t.label)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(openApp("timers"))
            .setUsesChronometer(true).setShowWhen(true)
            .addAction(0, "Pause", action("pause", Alarms.ACTION_PAUSE))
            .addAction(0, "+5 min", action("extend", Alarms.ACTION_EXTEND))
            .addAction(0, "Stop", action("stop", Alarms.ACTION_STOP))
        if (t.mode == "countdown" && t.durationMs > 0) {
            val left = s.timerRemaining(t, now)
            val passedMin = elapsed / 60_000
            val leftMin = (left + 59_999) / 60_000
            val ends = Instant.ofEpochMilli(now + left).atZone(ZoneId.systemDefault()).toLocalTime()
            b.setContentText("$kind · $passedMin of ${t.durationMs / 60_000} min · $leftMin min left")
                .setSubText("ends %02d:%02d".format(ends.hour, ends.minute))
                .setProgress(1000, (1000 * elapsed / t.durationMs).toInt().coerceIn(0, 1000), false)
                .setWhen(now + left).setChronometerCountDown(true)
        } else {
            b.setContentText("$kind · ${elapsed / 60_000} min").setWhen(now - elapsed)
        }
        return b.build()
    }

    /** Fallback when the foreground service can't be started: same notification, posted directly. */
    fun showRunning(app: QuestboardApp, t: Timer) {
        if (can()) nm.notify(ID_RUNNING, runningNotification(app, t))
    }

    fun cancelRunning() = nm.cancel(ID_RUNNING)

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
        const val CH_TIMER = "timer_live"
        const val CH_TIMER_OLD = "timer"
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
        val svc = TimerService.instance
        when {
            svc != null -> svc.refreshNow()
            t != null -> try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, TimerService::class.java))
            } catch (e: Exception) { // e.g. started from the background on Android 12+
                app.log.warn("timer", "live notification service not started: $e")
                app.notifier.showRunning(app, t)
            }
            else -> app.notifier.cancelRunning()
        }

        if (app.settings.reminders) {
            for ((q, at) in s.upcomingScheduled()) setAt(at, pi(ACTION_REMIND, q.str("id").hashCode(), q.str("id")))
        }
    }

    companion object {
        const val ACTION_TIMER = "com.questboard.TIMER"
        const val ACTION_REMIND = "com.questboard.REMIND"
        const val ACTION_PAUSE = "com.questboard.PAUSE"
        const val ACTION_EXTEND = "com.questboard.EXTEND"
        const val ACTION_STOP = "com.questboard.STOP"
    }
}

/**
 * Foreground service that only exists while a timer runs: keeps its notification
 * visible (OEM skins hide plain low-priority ones) and refreshes the text every 15 s.
 */
class TimerService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val loop = object : Runnable {
        override fun run() { if (update()) handler.postDelayed(this, 15_000) }
    }

    override fun onCreate() { super.onCreate(); instance = this }
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        refreshNow(started = true)
        return START_NOT_STICKY
    }

    fun refreshNow(started: Boolean = false) {
        handler.removeCallbacks(loop)
        if (update(started)) handler.postDelayed(loop, 15_000)
    }

    /** true while a timer runs (keep refreshing); otherwise removes the notification and stops. */
    private fun update(started: Boolean = false): Boolean {
        val app = application as QuestboardApp
        val running = app.store.runningTimers()
        val t = running.firstOrNull { it.mode == "countdown" } ?: running.firstOrNull()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        if (t == null) {
            // a start request must always be answered with startForeground, even if the timer just stopped
            if (started) runCatching {
                ServiceCompat.startForeground(this, Notifier.ID_RUNNING,
                    NotificationCompat.Builder(this, Notifier.CH_TIMER).setSmallIcon(R.drawable.qb_stopwatch).setContentTitle("Timer").build(), type)
            }
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            app.notifier.cancelRunning()
            stopSelf()
            return false
        }
        return try {
            ServiceCompat.startForeground(this, Notifier.ID_RUNNING, app.notifier.runningNotification(app, t), type)
            true
        } catch (e: Exception) {
            app.log.warn("timer", "foreground notification failed: $e")
            app.notifier.showRunning(app, t)
            stopSelf()
            false
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(loop)
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        var instance: TimerService? = null
            private set
    }
}

/**
 * Opt-in: a finished Pomodoro is written to your calendar as "Focus · <quest>". The event covers the
 * run time before it finished; if you paused in between, the event also spans that pause.
 */
fun writeFocusEvent(app: QuestboardApp, t: Timer) {
    if (t.kind != "pomodoro" || !app.settings.focusToCalendar) return
    val end = System.currentTimeMillis()
    val start = end - t.durationMs
    val cals = runCatching { app.calendar.calendars() }.getOrDefault(emptyList()).filter { it.writable }
    val cid = app.settings.calendarId.takeIf { id -> cals.any { it.id == id } } ?: cals.firstOrNull()?.id ?: return
    runCatching { app.calendar.create(cid, "Focus · ${t.label}", start, end, false, "", "Pomodoro from Questboard") }
        .onFailure { app.log.exception("focus", it) }
}

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as QuestboardApp
        when (intent.action) {
            Alarms.ACTION_TIMER -> {
                for (t in app.store.tick()) {
                    writeFocusEvent(app, t)
                    val (title, body) = when (t.kind) {
                        "pomodoro" -> "Pomodoro complete · +10 XP" to "Nice work on “${t.label}”. Time for a break."
                        "break" -> "Break over" to "Back to your quests."
                        else -> "Timer finished" to t.label
                    }
                    app.notifier.alert(t.id.hashCode(), title, body)
                }
                app.alarms.refresh(app)
            }
            Alarms.ACTION_PAUSE -> intent.getStringExtra("id")?.let { app.store.toggleTimer(it) } // → onLocalChange → refresh
            Alarms.ACTION_EXTEND -> intent.getStringExtra("id")?.let { app.store.extendTimer(it, 5 * 60_000L) }
            Alarms.ACTION_STOP -> intent.getStringExtra("id")?.let { app.store.removeTimer(it) }
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
    val uid: String = "",  // iCalendar UID: the same event on the desktop (GNOME) side
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
        val zone = ZoneId.systemDefault()
        return eventsBetween(day.atStartOfDay(zone).toInstant().toEpochMilli(), day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli())
    }

    /** Event occurrences overlapping begin..end (ms), optionally only from some calendars. */
    fun eventsBetween(begin: Long, end: Long, calendarIds: Set<Long>? = null): List<CalEvent> {
        if (!hasPermission()) return emptyList()
        val zone = ZoneId.systemDefault()
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, begin); ContentUris.appendId(it, end)
        }.build()
        val out = mutableListOf<CalEvent>()
        ctx.contentResolver.query(uri, arrayOf(
            CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.CALENDAR_ID, CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.DISPLAY_COLOR, CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.DESCRIPTION, CalendarContract.Instances.RRULE, CalendarContract.Instances.VISIBLE,
            CalendarContract.Instances.UID_2445,
        ), null, null, CalendarContract.Instances.BEGIN)?.use { c ->
            while (c.moveToNext()) {
                if (c.getInt(10) == 0) continue
                if (calendarIds != null && c.getLong(1) !in calendarIds) continue
                var b = c.getLong(3)
                var e = c.getLong(4)
                val allDay = c.getInt(5) == 1
                if (allDay) { // all-day instances are stored in UTC
                    val d = java.time.Instant.ofEpochMilli(b).atZone(ZoneId.of("UTC")).toLocalDate()
                    b = d.atStartOfDay(zone).toInstant().toEpochMilli(); e = b + 86_400_000
                }
                out += CalEvent(c.getLong(0), c.getLong(1), c.getString(2) ?: "(no title)", b, e, allDay, c.getInt(6),
                    c.getString(7) ?: "", c.getString(8) ?: "", !c.getString(9).isNullOrEmpty(), c.getString(11) ?: "")
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

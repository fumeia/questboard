package com.questboard.app.sys

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import com.questboard.app.MainActivity
import com.questboard.app.QuestboardApp
import com.questboard.app.R
import com.questboard.app.data.dueInDays
import com.questboard.app.data.levelInfo
import com.questboard.app.data.str
import com.questboard.app.ui.fmtSpent
import com.questboard.app.ui.rowTitle
import com.questboard.app.ui.rpgReviews

/**
 * Home-screen widget: a dark card (the app's colours) with centred text, readable on any wallpaper and in light or dark mode.
 *   [level ring] 1h 34m focus      (green ✓ once the daily target is reached)
 *   Focus · 18:42                   (only while a timer runs; counts by itself)
 *   Next: QM Übungsblatt 7 · tomorrow
 *   3 reviews due in the Physics RPG
 * Redrawn whenever the data changes (also after a background sync), and every 30 minutes for the date.
 */
class TodayWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val app = context.applicationContext as? QuestboardApp ?: return
        runCatching { val v = render(app); for (id in ids) manager.updateAppWidget(id, v) }
            .onFailure { app.log.exception("widget", it) }
    }

    companion object {
        private val handler = Handler(Looper.getMainLooper())
        private var pending: Runnable? = null

        /** Redraw every placed widget, at most once per second (a sync can change many records in a row). */
        fun refresh(app: QuestboardApp) {
            pending?.let { handler.removeCallbacks(it) }
            pending = Runnable {
                pending = null
                runCatching {
                    val m = AppWidgetManager.getInstance(app)
                    val ids = m.getAppWidgetIds(ComponentName(app, TodayWidget::class.java))
                    if (ids.isNotEmpty()) { val v = render(app); for (id in ids) m.updateAppWidget(id, v) }
                }.onFailure { app.log.exception("widget", it) }
            }.also { handler.postDelayed(it, 1000) }
        }

        private fun render(app: QuestboardApp): RemoteViews {
            val s = app.store
            val v = RemoteViews(app.packageName, R.layout.widget_today)
            val dark = true  // the card is always dark (without it, the light text vanished on a light launcher in dark mode)
            val info = levelInfo(s.xp)
            v.setImageViewBitmap(R.id.w_ring, ring(app, info.level, info.frac, dark))

            val hit = s.dailyHit()
            val focus = fmtSpent(s.focusOn()).ifEmpty { "0m" }
            v.setTextViewText(R.id.w_focus, if (hit) "$focus focus ✓" else "$focus focus")
            v.setTextColor(R.id.w_focus, app.getColor(if (hit) R.color.widget_hit else R.color.widget_text))

            // a running timer counts by itself (Chronometer), so the widget needs no update every second
            val t = s.runningTimers().firstOrNull()
            if (t != null) {
                val countdown = t.mode == "countdown"
                val ms = if (countdown) s.timerRemaining(t) else s.timerElapsed(t)
                v.setViewVisibility(R.id.w_timer_row, View.VISIBLE)
                v.setTextViewText(R.id.w_timer_label, when (t.kind) { "break" -> "Break ·"; "pomodoro" -> "Focus ·"; else -> "${t.label} ·" })
                v.setChronometer(R.id.w_timer, SystemClock.elapsedRealtime() + if (countdown) ms else -ms, null, true)
                v.setChronometerCountDown(R.id.w_timer, countdown)
            } else v.setViewVisibility(R.id.w_timer_row, View.GONE)

            // the most urgent open quest: soonest due (within 3 days), else the first in Do first, else in Schedule
            val open = s.openQuests()
            val dated = open.mapNotNull { q -> dueInDays(q)?.let { q to it } }.minByOrNull { it.second }?.takeIf { it.second <= 3 }
            val next = dated?.first ?: open.firstOrNull { it.str("quadrant") == "q1" } ?: open.firstOrNull { it.str("quadrant") == "q2" }
            if (next != null) {
                val dd = dated?.second
                val whenTxt = when { dd == null -> ""; dd < 0 -> " · ${-dd}d late"; dd == 0L -> " · today"; dd == 1L -> " · tomorrow"; else -> " · in ${dd}d" }
                v.setTextViewText(R.id.w_next, "Next: ${rowTitle(next)}$whenTxt")
            } else v.setTextViewText(R.id.w_next, "Nothing urgent. Good time for the Physics RPG.")

            // reviews due in the game (the "respawns due" quests; the course quests carry the same number)
            val respawnQuests = s.quests.filter { it.str("kind") == "respawn" && !it.optBoolean("done") }
            val reviews = if (respawnQuests.isNotEmpty()) respawnQuests.sumOf { rpgReviews(it) }
                else s.quests.filter { it.str("source") == "physics-rpg" }.sumOf { rpgReviews(it) }
            if (reviews > 0) {
                v.setViewVisibility(R.id.w_reviews, View.VISIBLE)
                v.setTextViewText(R.id.w_reviews, "$reviews review${if (reviews == 1) "" else "s"} due in the Physics RPG")
            } else v.setViewVisibility(R.id.w_reviews, View.GONE)

            val open0 = Intent(app, MainActivity::class.java).putExtra("tab", "matrix").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            v.setOnClickPendingIntent(R.id.w_root, PendingIntent.getActivity(app, 4711, open0, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            return v
        }

        /** The level ring as a bitmap (RemoteViews cannot draw): the number in a circle, gold arc = way to the next level. */
        private fun ring(ctx: Context, level: Int, frac: Float, dark: Boolean): Bitmap {
            val d = ctx.resources.displayMetrics.density
            val size = (34 * d).toInt()
            val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val c = Canvas(bmp)
            val stroke = 3f * d
            val r = RectF(stroke / 2, stroke / 2, size - stroke / 2, size - stroke / 2)
            val gold = if (dark) Color.rgb(246, 211, 45) else Color.rgb(176, 122, 0)
            val p = Paint(Paint.ANTI_ALIAS_FLAG)
            p.style = Paint.Style.FILL; p.color = Color.argb(if (dark) 36 else 46, 246, 211, 45)
            c.drawOval(r, p)
            p.style = Paint.Style.STROKE; p.strokeWidth = stroke
            p.color = if (dark) Color.argb(48, 255, 255, 255) else Color.argb(40, 0, 0, 0)
            c.drawOval(r, p)
            if (frac > 0f) { p.color = gold; p.strokeCap = Paint.Cap.ROUND; c.drawArc(r, -90f, 360f * frac.coerceIn(0f, 1f), false, p) }
            p.style = Paint.Style.FILL; p.color = gold; p.textAlign = Paint.Align.CENTER
            p.typeface = Typeface.DEFAULT_BOLD; p.textSize = (if (level >= 10) 13 else 15) * d
            c.drawText("$level", size / 2f, size / 2f - (p.descent() + p.ascent()) / 2, p)
            return bmp
        }
    }
}

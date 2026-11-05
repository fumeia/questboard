@file:OptIn(ExperimentalLayoutApi::class)

package com.questboard.app.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.questboard.app.QuestboardApp
import com.questboard.app.data.dateKey
import com.questboard.app.data.jobj
import com.questboard.app.data.str
import com.questboard.app.sys.CalEvent
import com.questboard.app.sys.CalInfo
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

private const val HOUR_DP = 56
private const val GUTTER_DP = 46

private data class Block(val key: String, val title: String, val start: Int, val end: Int, val color: Color,
                         val event: CalEvent? = null, val questId: String? = null, val done: Boolean = false) {
    var col = 0
    var ncols = 1
}

private fun layout(items: List<Block>): List<Block> {
    val sorted = items.sortedWith(compareBy({ it.start }, { -it.end }))
    var cluster = mutableListOf<Block>()
    var colEnds = mutableListOf<Int>()
    var clusterEnd = Int.MIN_VALUE
    fun flush() { cluster.forEach { it.ncols = colEnds.size }; cluster = mutableListOf(); colEnds = mutableListOf(); clusterEnd = Int.MIN_VALUE }
    for (b in sorted) {
        if (cluster.isNotEmpty() && b.start >= clusterEnd) flush()
        var c = colEnds.indexOfFirst { it <= b.start }
        if (c < 0) { c = colEnds.size; colEnds.add(b.end) } else colEnds[c] = b.end
        b.col = c; cluster.add(b); clusterEnd = maxOf(clusterEnd, b.end)
    }
    flush()
    return sorted
}

@Composable
fun CalendarScreen(app: QuestboardApp, v: Int, permVersion: Int) {
    val ctx = LocalContext.current
    var day by remember { mutableStateOf(LocalDate.now()) }
    var reload by remember { mutableStateOf(0) }
    var editEvent by remember { mutableStateOf<CalEvent?>(null) }
    var newAt by remember { mutableStateOf<Int?>(null) }
    var openQuest by remember { mutableStateOf<String?>(null) }
    val repo = app.calendar
    val hasPerm = remember(permVersion) { repo.hasPermission() }
    val events = remember(day, reload, permVersion, v) { runCatching { repo.eventsOn(day) }.getOrDefault(emptyList()) }
    val cals = remember(permVersion, reload) { runCatching { repo.calendars() }.getOrDefault(emptyList()) }
    val zone = ZoneId.systemDefault()
    val dayStart = day.atStartOfDay(zone).toInstant().toEpochMilli()
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    LaunchedEffect(day) {
        val h = if (day == LocalDate.now()) maxOf(0, LocalTime.now().hour - 1) else app.settings.dayStartHour
        scroll.scrollTo(with(density) { (h * HOUR_DP).dp.roundToPx() })
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconBtn("chevron-left", { day = day.minusDays(1) }, C.muted, 18.dp)
            Text("${day.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.getDefault())}, ${day.dayOfMonth}. " +
                day.month.getDisplayName(TextStyle.SHORT, Locale.getDefault()), fontWeight = FontWeight.Bold, fontSize = 16.sp,
                modifier = Modifier.weight(1f).clickable { day = LocalDate.now() })
            IconBtn("chevron-right", { day = day.plusDays(1) }, C.muted, 18.dp)
            IconBtn("plus", { newAt = if (day == LocalDate.now()) ((LocalTime.now().hour + 1) * 60).coerceAtMost(23 * 60) else app.settings.dayStartHour * 60 })
        }
        // week strip
        val ws = day.minusDays((day.dayOfWeek.value - 1).toLong())
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            for (i in 0..6) {
                val d = ws.plusDays(i.toLong())
                val sel = d == day
                Column(Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).background(if (sel) C.accent.copy(alpha = 0.5f) else Color.Transparent)
                    .clickable { day = d }.padding(vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Muted(d.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault()).take(2), size = 11)
                    Text("${d.dayOfMonth}", fontWeight = FontWeight.Bold, fontSize = 14.sp,
                        color = if (d == LocalDate.now() && !sel) C.red else C.text)
                }
            }
        }
        if (!hasPerm) {
            Column(Modifier.fillMaxWidth().padding(12.dp)) {
                Muted("Allow calendar access to see and edit your Google Calendar events.", size = 13)
                TextButton(onClick = {
                    ctx.startActivity(Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
                }) { Text("Open app permissions") }
            }
        }
        // all-day + deadlines
        val allDay = events.filter { it.allDay }
        val due = remember(v, day) { app.store.dueOn(dateKey(day)) }
        if (allDay.isNotEmpty() || due.isNotEmpty()) {
            FlowRow(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (e in allDay) Pill(e.title, Color(e.color).copy(alpha = 0.5f)) { editEvent = e }
                for (q in due) Pill("Due: ${q.str("title")}", C.quad(q.str("quadrant")).copy(alpha = 0.35f)) { openQuest = q.str("id") }
            }
        }
        // timeline
        val blocks = remember(events, v, day) {
            val list = mutableListOf<Block>()
            for (e in events.filter { !it.allDay }) {
                val s = ((maxOf(e.begin, dayStart) - dayStart) / 60000).toInt()
                val en = ((minOf(e.end, dayStart + 86_400_000) - dayStart) / 60000).toInt()
                list += Block("e${e.id}-${e.begin}", e.title, s, maxOf(s + 15, en), Color(e.color), event = e)
            }
            for (q in app.store.scheduledOn(dateKey(day))) {
                val sc = q.optJSONObject("scheduled")!!
                val s = sc.optInt("start")
                list += Block("q${q.str("id")}", q.str("title"), s, s + maxOf(15, sc.optInt("duration", 60)), C.quad(q.str("quadrant")),
                    questId = q.str("id"), done = q.optBoolean("done"))
            }
            layout(list)
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll)) {
            val area = maxWidth - GUTTER_DP.dp
            Box(Modifier.fillMaxWidth().height((24 * HOUR_DP).dp).pointerInput(day) {
                detectTapGestures { off ->
                    if (off.x > GUTTER_DP.dp.toPx()) newAt = ((off.y / (HOUR_DP / 2).dp.toPx()).toInt() * 30).coerceIn(0, 23 * 60 + 30)
                }
            }) {
                for (h in 0..23) {
                    Box(Modifier.offset(y = (h * HOUR_DP).dp).fillMaxWidth().height(1.dp).padding(start = (GUTTER_DP - 4).dp).background(C.line))
                    Text("%02d:00".format(h), fontSize = 10.sp, color = C.muted, modifier = Modifier.offset(y = (h * HOUR_DP - 6).coerceAtLeast(0).dp).width((GUTTER_DP - 6).dp))
                }
                for (b in blocks) {
                    val w = area / b.ncols
                    Column(Modifier.offset(x = GUTTER_DP.dp + w * b.col, y = (b.start * HOUR_DP / 60f).dp)
                        .size(w - 3.dp, ((b.end - b.start) * HOUR_DP / 60f - 2).coerceAtLeast(20f).dp)
                        .clip(RoundedCornerShape(6.dp)).background(b.color.copy(alpha = if (b.done) 0.2f else 0.55f))
                        .clickable { if (b.questId != null) openQuest = b.questId else editEvent = b.event }
                        .padding(horizontal = 6.dp, vertical = 2.dp)) {
                        Text(b.title, fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            color = if (b.done) C.muted else C.text)
                        if (b.end - b.start >= 40) Text("${fmtMin(b.start)} – ${fmtMin(b.end)}", fontSize = 10.sp, color = C.muted)
                    }
                }
                if (day == LocalDate.now()) {
                    val n = LocalTime.now()
                    Box(Modifier.offset(x = (GUTTER_DP - 6).dp, y = ((n.hour * 60 + n.minute) * HOUR_DP / 60f).dp).fillMaxWidth().height(2.dp).background(C.red))
                }
            }
        }
    }
    newAt?.let { m -> NewAtDialog(app, cals, day, m, onDone = { newAt = null }, onSaved = { reload++ }) }
    editEvent?.let { e -> EventDialog(app, cals, e, day, e.begin, e.end, onDone = { editEvent = null }, onSaved = { reload++ }) }
    openQuest?.let { id -> QuestSheet(app, id, v, System.currentTimeMillis()) { openQuest = null } }
}

@Composable
private fun NewAtDialog(app: QuestboardApp, cals: List<CalInfo>, day: LocalDate, minute: Int, onDone: () -> Unit, onSaved: () -> Unit) {
    var mode by remember { mutableStateOf("quest") }
    var title by remember { mutableStateOf("") }
    var quad by remember { mutableStateOf("q2") }
    if (mode == "event") {
        val start = day.atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli() + minute * 60_000L
        EventDialog(app, cals, null, day, start, start + 3_600_000, onDone, onSaved, initialTitle = title)
        return
    }
    AlertDialog(
        onDismissRequest = onDone, containerColor = C.surface,
        title = { Text("${day.dayOfMonth}.${day.monthValue}. · ${fmtMin(minute)}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Pill("Quest", C.accent) {}
                    Pill("Event", C.card) { mode = "event" }
                }
                OutlinedTextField(title, { title = it }, singleLine = true, placeholder = { Text("Quest for this slot") })
                QuadrantChips(quad) { quad = it }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                app.store.addQuest(title, quad, jobj("date" to dateKey(day), "start" to minute, "duration" to 60))
                onDone()
            }) { Text("Add quest") }
        },
        dismissButton = { TextButton(onClick = onDone) { Text("Cancel") } },
    )
}

@Composable
private fun EventDialog(app: QuestboardApp, cals: List<CalInfo>, e: CalEvent?, day0: LocalDate, begin0: Long, end0: Long,
                        onDone: () -> Unit, onSaved: () -> Unit, initialTitle: String = "") {
    val zone = ZoneId.systemDefault()
    val writable = cals.filter { it.writable }
    var title by remember { mutableStateOf(e?.title ?: initialTitle) }
    var day by remember { mutableStateOf(day0) }
    fun minsOf(ms: Long) = java.time.Instant.ofEpochMilli(ms).atZone(zone).toLocalTime().let { it.hour * 60 + it.minute }
    var start by remember { mutableStateOf(fmtMin(minsOf(begin0))) }
    var end by remember { mutableStateOf(fmtMin(minsOf(end0))) }
    var allDay by remember { mutableStateOf(e?.allDay ?: false) }
    var location by remember { mutableStateOf(e?.location ?: "") }
    var notes by remember { mutableStateOf(e?.description ?: "") }
    var calId by remember { mutableStateOf(e?.calendarId ?: writable.find { it.id == app.settings.calendarId }?.id ?: writable.firstOrNull()?.id) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    val recurring = e?.recurring == true

    AlertDialog(
        onDismissRequest = onDone, containerColor = C.surface,
        title = { Text(if (e == null) "New event" else "Edit event") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(title, { title = it }, singleLine = true, placeholder = { Text("Title") })
                if (!recurring) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconBtn("chevron-left", { day = day.minusDays(1) }, C.muted, 16.dp)
                        Text("${day.dayOfMonth}.${day.monthValue}.${day.year}", modifier = Modifier.weight(1f), fontWeight = FontWeight.Bold)
                        IconBtn("chevron-right", { day = day.plusDays(1) }, C.muted, 16.dp)
                        Pill("All day", if (allDay) C.accent else C.card) { allDay = !allDay }
                    }
                    if (!allDay) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(start, { start = it }, singleLine = true, modifier = Modifier.weight(1f), label = { Text("Start") })
                        OutlinedTextField(end, { end = it }, singleLine = true, modifier = Modifier.weight(1f), label = { Text("End") })
                    }
                } else Muted("Recurring event: only title, place and notes can be changed here.", size = 12)
                OutlinedTextField(location, { location = it }, singleLine = true, placeholder = { Text("Location") })
                OutlinedTextField(notes, { notes = it }, placeholder = { Text("Notes") }, minLines = 2)
                if (e == null) {
                    if (writable.isEmpty()) Muted("No writable calendar found (check calendar permission).", size = 12)
                    else FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (c in writable) Pill(c.name, if (c.id == calId) Color(c.color).copy(alpha = 0.7f) else C.card) { calId = c.id }
                    }
                }
                if (e != null) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (confirmDelete) Pill(if (recurring) "Delete whole series" else "Really delete", C.red) {
                        runCatching { app.calendar.delete(e.id) }.onFailure { app.log.exception("calendar", it) }
                        onSaved(); onDone()
                    } else Pill("Delete", Color.Transparent, C.red) { confirmDelete = true }
                    Pill("To quest", C.card) {
                        val m = minsOf(e.begin)
                        app.store.addQuest(e.title, "q2", if (e.allDay) null else jobj("date" to dateKey(day), "start" to m,
                            "duration" to ((e.end - e.begin) / 60000).toInt().coerceAtLeast(15)))
                        onDone()
                    }
                    if (recurring) Pill("Open in Calendar", C.card) { app.calendar.openInCalendarApp(e.id) }
                }
                error?.let { Text(it, color = C.red, fontSize = 12.sp) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val s = parseHm(start)
                val en = parseHm(end)
                if (!allDay && !recurring && (s == null || en == null)) { error = "Times look like 14:30"; return@TextButton }
                if (title.isBlank()) { error = "Give it a title"; return@TextButton }
                val base = day.atStartOfDay(zone).toInstant().toEpochMilli()
                val b = if (allDay) base else base + (s ?: 0) * 60_000L
                val en2 = if (allDay) base + 86_400_000 else base + ((en ?: 0).let { if (it <= (s ?: 0)) it + 1440 else it }) * 60_000L
                try {
                    if (e == null) {
                        val cid = calId ?: run { error = "Pick a calendar"; return@TextButton }
                        app.calendar.create(cid, title.trim(), b, en2, allDay, location, notes)
                        app.settings.calendarId = cid
                        app.log.info("calendar", "event created")
                    } else {
                        app.calendar.update(e.id, title.trim(), b, en2, allDay, location, notes, recurring)
                        app.log.info("calendar", "event updated")
                    }
                    onSaved(); onDone()
                } catch (ex: Exception) {
                    app.log.exception("calendar", ex)
                    error = ex.message
                }
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDone) { Text("Cancel") } },
    )
}

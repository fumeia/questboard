@file:OptIn(ExperimentalLayoutApi::class)

package com.questboard.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import org.json.JSONArray
import org.json.JSONObject
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.questboard.app.BuildConfig
import com.questboard.app.QuestboardApp
import com.questboard.app.data.Timer
import com.questboard.app.data.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ------------------------------------------------------------------- timers

private data class Preset(val label: String, val kind: String, val min: Int)

private fun loadPresets(json: String): List<Preset> = runCatching {
    val a = JSONArray(json)
    (0 until a.length()).map { a.getJSONObject(it) }.map { Preset(it.optString("label"), it.optString("kind", "pomodoro"), it.optInt("min", 25)) }
}.getOrDefault(emptyList())

private fun savePresets(app: QuestboardApp, list: List<Preset>) {
    app.settings.timerPresets = JSONArray(list.map { JSONObject().put("label", it.label).put("kind", it.kind).put("min", it.min) }).toString()
}

private val KINDS = listOf("pomodoro" to "Focus", "break" to "Break", "custom" to "Countdown", "stopwatch" to "Stopwatch")
private fun kindColor(kind: String) = when (kind) { "pomodoro" -> C.red; "break" -> C.accent; "stopwatch" -> C.green; else -> C.gold }

/** Start any timer the same way: Focus (Pomodoro, +10 XP), Break, Countdown or Stopwatch, optional label and quest. */
private fun startKind(app: QuestboardApp, kind: String, min: Int, label: String?, questId: String?) {
    val s = app.store
    val l = label?.trim()?.ifEmpty { null }
    when (kind) {
        "pomodoro" -> if (l == null) s.startPomodoro(questId, min) else s.addTimer("countdown", "pomodoro", min * 60_000L, questId, l)
        "break" -> s.addTimer("countdown", "break", min * 60_000L, null, l ?: "Break")
        "stopwatch" -> s.addTimer("stopwatch", "stopwatch", 0, questId, l)
        else -> s.addTimer("countdown", "custom", min * 60_000L, questId, l)
    }
}

@Composable
fun TimersScreen(app: QuestboardApp, v: Int, now: Long) {
    val s = app.store
    val st = app.settings
    var kind by remember { mutableStateOf("pomodoro") }
    fun defaultMin(k: String) = when (k) { "pomodoro" -> st.pomodoroMin; "break" -> st.breakMin; else -> st.countdownMin }
    var minutes by remember { mutableStateOf(defaultMin("pomodoro")) }
    var label by remember { mutableStateOf("") }
    var link by remember { mutableStateOf<String?>(null) }
    var pickerFor by remember { mutableStateOf<String?>(null) }
    var presets by remember { mutableStateOf(loadPresets(st.timerPresets)) }
    var editPresets by remember { mutableStateOf(false) }
    var autoBreak by remember { mutableStateOf(st.autoBreak) }
    val timers = remember(v) { s.timers.toList() }

    fun setMin(m: Int) {
        val c = m.coerceIn(1, 600)
        minutes = c
        when (kind) { "pomodoro" -> st.pomodoroMin = c; "break" -> { st.breakMin = c; if (st.autoBreak) s.autoBreakMin = c }; "custom" -> st.countdownMin = c }
    }

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // ---- new timer
        item {
            Column(Modifier.padding(top = 10.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.card).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((k, name) in KINDS) Pill(name, if (k == kind) kindColor(k).copy(alpha = 0.55f) else C.surface) {
                        kind = k; minutes = defaultMin(k)
                    }
                }
                if (kind != "stopwatch") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Pill("−5", C.surface) { setMin(minutes - 5) }
                        Pill("−1", C.surface) { setMin(minutes - 1) }
                        Text("$minutes min", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, fontFamily = FontFamily.Monospace,
                            modifier = Modifier.weight(1f), textAlign = TextAlign.Center)
                        Pill("+1", C.surface) { setMin(minutes + 1) }
                        Pill("+5", C.surface) { setMin(minutes + 5) }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (m in listOf(5, 10, 15, 25, 30, 45, 50, 60, 90)) Pill("$m", if (m == minutes) C.accent.copy(alpha = 0.45f) else C.surface) { setMin(m) }
                    }
                }
                OutlinedTextField(label, { label = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text(if (kind == "break") "Break" else "Label (optional, else the quest's name)") })
                if (kind != "break") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Muted("Counts toward ", size = 13)
                        Pill(link?.let { s.getQuest(it)?.str("title") } ?: "no quest", C.surface) { pickerFor = if (pickerFor == "new") null else "new" }
                        if (link != null) IconBtn("close", { link = null }, C.muted, 14.dp)
                    }
                    if (pickerFor == "new") QuestPicker(app, link) { link = it; pickerFor = null }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f).clip(RoundedCornerShape(50)).background(kindColor(kind).copy(alpha = 0.6f))
                        .clickable { startKind(app, kind, minutes, label, if (kind == "break") null else link); label = "" }
                        .padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
                        Text("Start ${KINDS.first { it.first == kind }.second.lowercase()}" + if (kind != "stopwatch") " · $minutes min" else "",
                            fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    }
                    Pill("Save as preset", C.surface) {
                        val name = label.trim().ifEmpty { KINDS.first { it.first == kind }.second }
                        presets = presets + Preset(name, kind, if (kind == "stopwatch") 0 else minutes); savePresets(app, presets)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Break after each Focus", fontSize = 14.sp)
                        Muted("Starts a ${st.breakMin} min break by itself when a Focus timer ends", size = 12)
                    }
                    Switch(autoBreak, {
                        autoBreak = it; st.autoBreak = it; s.autoBreakMin = if (it) st.breakMin else 0
                    })
                }
            }
        }
        // ---- presets: one tap starts (with the quest chosen above)
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Presets", fontWeight = FontWeight.Bold, fontSize = 14.sp, modifier = Modifier.weight(1f))
                if (presets.isNotEmpty()) TextButton(onClick = { editPresets = !editPresets }) { Text(if (editPresets) "Done" else "Edit") }
            }
            if (presets.isEmpty()) Muted("Set up a timer above and tap “Save as preset”.", size = 12)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                presets.forEachIndexed { i, p ->
                    val text = p.label + if (p.kind != "stopwatch") " · ${p.min}m" else ""
                    if (editPresets) Pill("✕  $text", C.red.copy(alpha = 0.3f)) { presets = presets.filterIndexed { j, _ -> j != i }; savePresets(app, presets) }
                    else Pill(text, kindColor(p.kind).copy(alpha = 0.35f)) { startKind(app, p.kind, p.min, p.label, if (p.kind == "break") null else link) }
                }
            }
        }
        // ---- running and paused timers
        if (timers.isEmpty()) item { Muted("No timers yet. Start one above, or press play on any quest.", Modifier.padding(top = 8.dp), 14) }
        items(timers, key = { it.id }) { t -> TimerCard(app, t, now, pickerFor == t.id, { pickerFor = if (pickerFor == t.id) null else t.id }) { pickerFor = null } }
    }
}

@Composable
private fun TimerCard(app: QuestboardApp, t: Timer, now: Long, picking: Boolean, onPick: () -> Unit, onPicked: () -> Unit) {
    val s = app.store
    val running = t.startedAt != null
    val countdown = t.mode == "countdown"
    var renaming by remember(t.id) { mutableStateOf(false) }
    var name by remember(t.id) { mutableStateOf(t.label) }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.card)
        .border(1.dp, if (running) C.green.copy(alpha = 0.5f) else if (t.finished) C.gold.copy(alpha = 0.5f) else C.line, RoundedCornerShape(12.dp))
        .padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Dot(kindColor(t.kind)); HSpace(6.dp)
            Muted(listOf(KINDS.firstOrNull { it.first == t.kind }?.second ?: "Countdown", if (t.finished) "done" else if (!running) "paused" else "")
                .filter { it.isNotEmpty() }.joinToString(" · "), size = 12)
            HSpace(8.dp)
            if (renaming) {
                OutlinedTextField(name, { name = it }, singleLine = true, modifier = Modifier.weight(1f))
                IconBtn("check", { s.renameTimer(t.id, name); renaming = false }, C.green, 16.dp)
            } else {
                Text(t.label, fontSize = 13.sp, maxLines = 1, modifier = Modifier.weight(1f).clickable { name = t.label; renaming = true })
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(fmtTimer(if (countdown) s.timerRemaining(t, now) else s.timerElapsed(t, now)), fontSize = 34.sp,
                fontWeight = FontWeight.ExtraBold, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
            Box(Modifier.size(52.dp).clip(CircleShape).background(if (running) C.green.copy(alpha = 0.3f) else C.surface).clickable { s.toggleTimer(t.id) },
                contentAlignment = Alignment.Center) { QbIcon(if (running) "pause" else "play", if (running) C.green else C.text, 22.dp) }
            IconBtn("reset", { s.resetTimer(t.id) }, C.muted, 16.dp)
            IconBtn("close", { s.removeTimer(t.id) }, C.muted, 16.dp)
        }
        if (countdown && t.durationMs > 0) Bar(s.timerElapsed(t, now).toFloat() / t.durationMs, kindColor(t.kind), Modifier.fillMaxWidth(), 4.dp)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (countdown && !t.finished) {
                Pill("−5 min", C.surface) { s.shortenTimer(t.id, 5 * 60_000L) }
                Pill("+5 min", C.surface) { s.extendTimer(t.id, 5 * 60_000L) }
                Pill("+15 min", C.surface) { s.extendTimer(t.id, 15 * 60_000L) }
            }
            if (t.kind != "break") Pill(t.questId?.let { "↳ " + (s.timerLabel(it, t.stepId) ?: "quest") } ?: "Link a quest", C.surface, onClick = onPick)
        }
        if (t.finished && t.kind == "pomodoro") Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            QbIcon("sparkle", C.gold, 14.dp); Muted("+10 XP earned", size = 12)
            Pill("Take a ${app.settings.breakMin}m break", C.accent.copy(alpha = 0.5f)) { s.removeTimer(t.id); s.startBreak(app.settings.breakMin) }
            Pill("Again", C.surface) { s.startTimer(t.id) }
        }
        if (picking) QuestPicker(app, t.questId) { s.linkTimer(t.id, it); onPicked() }
    }
}

/** Open quests to link, with a search box (lists can be long once Notion sheets are in). */
@Composable
private fun QuestPicker(app: QuestboardApp, current: String?, onPick: (String?) -> Unit) {
    var q by remember { mutableStateOf("") }
    val all = remember { app.store.openQuests() }
    val shown = all.filter { q.isBlank() || it.str("title").contains(q.trim(), ignoreCase = true) }.take(12)
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0x40000000)).padding(4.dp)) {
        OutlinedTextField(q, { q = it }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("Search quests") })
        Text("No quest", fontSize = 13.sp, color = if (current == null) C.accent else C.text,
            modifier = Modifier.fillMaxWidth().clickable { onPick(null) }.padding(8.dp))
        for (x in shown) Row(Modifier.fillMaxWidth().clickable { onPick(x.str("id")) }.padding(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Dot(C.quad(x.str("quadrant"))); HSpace(8.dp)
            Text(x.str("title"), fontSize = 13.sp, color = if (x.str("id") == current) C.accent else C.text, maxLines = 1)
        }
        if (all.size > shown.size && q.isBlank()) Muted("${all.size - shown.size} more: type to search", Modifier.padding(8.dp), 12)
    }
}

// ----------------------------------------------------------------- settings

@Composable
fun SettingsScreen(app: QuestboardApp, onBack: () -> Unit) {
    val st = app.settings
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(st.serverUrl) }
    var token by remember { mutableStateOf(st.token) }
    var name by remember { mutableStateOf(st.deviceName) }
    var test by remember { mutableStateOf<String?>(null) }
    var syncOn by remember { mutableStateOf(st.syncEnabled) }
    var remote by remember { mutableStateOf(st.remoteLogs) }
    var auto by remember { mutableStateOf(st.autoUpdate) }
    var remind by remember { mutableStateOf(st.reminders) }
    var focusCal by remember { mutableStateOf(st.focusToCalendar) }
    var pomo by remember { mutableStateOf(st.pomodoroMin.toString()) }
    var brk by remember { mutableStateOf(st.breakMin.toString()) }
    var logs by remember { mutableStateOf(app.log.recent.takeLast(80)) }
    val sync by app.sync.status.collectAsState()
    val upd by app.updater.state.collectAsState()
    val save = {
        st.serverUrl = url; st.token = token; st.deviceName = name
        pomo.toIntOrNull()?.takeIf { it in 1..180 }?.let { st.pomodoroMin = it }
        brk.toIntOrNull()?.takeIf { it in 1..60 }?.let { st.breakMin = it; if (st.autoBreak) app.store.autoBreakMin = it }
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
                TextButton(onClick = { save(); onBack() }) { Text("‹ Back") }
                Text("Settings & debug", fontWeight = FontWeight.Bold, fontSize = 18.sp)
            }
        }
        item { SectionTitle("Server") }
        item { OutlinedTextField(url, { url = it }, singleLine = true, label = { Text("Server URL, e.g. http://192.168.1.20:8787") }, modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(token, { token = it }, singleLine = true, label = { Text("Token (QB_TOKEN)") },
            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Device name") }, modifier = Modifier.fillMaxWidth()) }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Pill("Save & test", C.accent) {
                    save(); test = "Testing…"
                    scope.launch {
                        test = try {
                            val j = withContext(Dispatchers.IO) { app.api.json("GET", "/api/devices") }
                            app.sync.syncNow("manual")
                            "Connected — ${j.getJSONArray("devices").length()} device(s) on the server"
                        } catch (e: Exception) {
                            if ((e as? com.questboard.app.net.Api.HttpError)?.code == 401) "Server reachable, but the token is wrong" else "Failed: ${e.message}"
                        }
                    }
                }
                Pill("Sync now", C.card) { scope.launch { app.sync.syncNow("manual") } }
            }
            test?.let { Muted(it, size = 13) }
            Muted("Sync: ${sync.state}${sync.error?.let { " — $it" } ?: ""} · ${app.store.dirtyCount()} unsent change(s)", size = 12)
        }
        item { ToggleRow("Sync enabled", syncOn) { syncOn = it; st.syncEnabled = it } }
        item { SectionTitle("Timers & reminders") }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(pomo, { pomo = it.filter(Char::isDigit) }, singleLine = true, label = { Text("Pomodoro min") }, modifier = Modifier.weight(1f))
                OutlinedTextField(brk, { brk = it.filter(Char::isDigit) }, singleLine = true, label = { Text("Break min") }, modifier = Modifier.weight(1f))
            }
        }
        item { ToggleRow("Remind me when a scheduled quest starts", remind) { remind = it; st.reminders = it } }
        item { ToggleRow("Add finished Pomodoros to Google Calendar", focusCal) { focusCal = it; st.focusToCalendar = it } }
        item { SectionTitle("Updates") }
        item {
            Muted("Installed: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", size = 13)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Pill("Check", C.card) { scope.launch { app.updater.check(manual = true) } }
                if (upd.available != null) Pill(if (upd.busy) "Installing…" else "Install ${upd.available!!.optString("name")}", C.green.copy(alpha = 0.5f)) {
                    scope.launch { app.updater.check(manual = true, install = true) }
                }
            }
            upd.message?.let { Muted(it, size = 12) }
        }
        item { ToggleRow("Check for updates automatically", auto) { auto = it; st.autoUpdate = it } }
        item { SectionTitle("Debug") }
        item { ToggleRow("Send logs to the server", remote) { remote = it; st.remoteLogs = it } }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Pill("Refresh log", C.card) { logs = app.log.recent.takeLast(80) }
                Pill("Send logs now", C.card) { scope.launch(Dispatchers.IO) { app.log.flush(app.api) } }
            }
            Muted("Device id: ${app.store.deviceId}", size = 11)
        }
        items(logs.reversed()) { e ->
            Text("${java.time.Instant.ofEpochMilli(e.ts).atZone(java.time.ZoneId.systemDefault()).toLocalTime().withNano(0)} " +
                "${e.level.uppercase()} [${e.tag}] ${e.msg}", fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                color = when (e.level) { "error" -> C.red; "warn" -> C.orange; else -> C.muted })
        }
    }
}

@Composable
private fun ToggleRow(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Switch(value, onChange)
    }
}

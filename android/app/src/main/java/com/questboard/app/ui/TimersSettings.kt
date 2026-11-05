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

@Composable
fun TimersScreen(app: QuestboardApp, v: Int, now: Long) {
    val s = app.store
    var link by remember { mutableStateOf<String?>(null) }
    var pickerFor by remember { mutableStateOf<String?>(null) }
    var custom by remember { mutableStateOf("") }
    val timers = remember(v) { s.timers.toList() }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Pill("Pomodoro ${app.settings.pomodoroMin}m", C.red.copy(alpha = 0.5f)) { s.startPomodoro(link, app.settings.pomodoroMin) }
                Pill("Break ${app.settings.breakMin}m", C.accent.copy(alpha = 0.4f)) { s.startBreak(app.settings.breakMin) }
                Pill("Stopwatch", C.card) { s.addTimer("stopwatch", "stopwatch", 0, link) }
                OutlinedTextField(custom, { custom = it.filter { c -> c.isDigit() } }, singleLine = true, modifier = Modifier.size(86.dp, 56.dp),
                    placeholder = { Text("min") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                Pill("Start", C.card) { custom.toIntOrNull()?.takeIf { it > 0 }?.let { s.addTimer("countdown", "custom", it * 60_000L, link); custom = "" } }
            }
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Muted("New timers count toward ", size = 13)
                Pill(link?.let { s.getQuest(it)?.str("title") } ?: "no quest", C.card) { pickerFor = if (pickerFor == "new") null else "new" }
            }
            if (pickerFor == "new") QuestPicker(app, link) { link = it; pickerFor = null }
        }
        if (timers.isEmpty()) item { Muted("No timers yet. Start a Pomodoro, or press play on any quest.", Modifier.padding(top = 16.dp), 14) }
        items(timers, key = { it.id }) { t -> TimerCard(app, t, now, pickerFor == t.id, { pickerFor = if (pickerFor == t.id) null else t.id }) { pickerFor = null } }
    }
}

@Composable
private fun TimerCard(app: QuestboardApp, t: Timer, now: Long, picking: Boolean, onPick: () -> Unit, onPicked: () -> Unit) {
    val s = app.store
    val running = t.startedAt != null
    val countdown = t.mode == "countdown"
    val kindColor = when (t.kind) { "pomodoro" -> C.red; "break" -> C.accent; else -> C.green }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.card)
        .border(1.dp, if (running) C.green.copy(alpha = 0.5f) else if (t.finished) C.gold.copy(alpha = 0.5f) else C.line, RoundedCornerShape(12.dp))
        .padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(fmtTimer(if (countdown) s.timerRemaining(t, now) else s.timerElapsed(t, now)), fontSize = 30.sp,
                fontWeight = FontWeight.ExtraBold, fontFamily = FontFamily.Monospace)
            HSpace(12.dp)
            Column(Modifier.weight(1f)) {
                Muted(listOf(when (t.kind) { "pomodoro" -> "Pomodoro"; "break" -> "Break"; "stopwatch" -> "Stopwatch"; else -> "Countdown" },
                    if (t.finished) "done" else "").filter { it.isNotEmpty() }.joinToString(" · "), size = 12)
                if (t.kind != "break") Text(t.questId?.let { s.timerLabel(it, t.stepId) } ?: "Link quest…", fontSize = 13.sp,
                    color = if (t.questId != null) C.text else C.muted, modifier = Modifier.clickable(onClick = onPick), maxLines = 2)
            }
            Box(Modifier.size(46.dp).clip(CircleShape).background(if (running) C.green.copy(alpha = 0.3f) else C.surface).clickable { s.toggleTimer(t.id) },
                contentAlignment = Alignment.Center) { QbIcon(if (running) "pause" else "play", if (running) C.green else C.text, 20.dp) }
            IconBtn("reset", { s.resetTimer(t.id) }, C.muted, 16.dp)
            IconBtn("close", { s.removeTimer(t.id) }, C.muted, 16.dp)
        }
        if (countdown && t.durationMs > 0) Bar(s.timerElapsed(t, now).toFloat() / t.durationMs, kindColor, Modifier.fillMaxWidth(), 4.dp)
        if (t.finished && t.kind == "pomodoro") Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            QbIcon("sparkle", C.gold, 14.dp); Muted("+10 XP earned", size = 12)
            Pill("Take a ${app.settings.breakMin}m break", C.accent.copy(alpha = 0.5f)) { s.removeTimer(t.id); s.startBreak(app.settings.breakMin) }
            Pill("Again", C.surface) { s.startTimer(t.id) }
        }
        if (picking) QuestPicker(app, t.questId) { s.linkTimer(t.id, it); onPicked() }
    }
}

@Composable
private fun QuestPicker(app: QuestboardApp, current: String?, onPick: (String?) -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0x40000000)).padding(4.dp)) {
        Text("No quest", fontSize = 13.sp, color = if (current == null) C.accent else C.text,
            modifier = Modifier.fillMaxWidth().clickable { onPick(null) }.padding(8.dp))
        for (q in app.store.openQuests()) Row(Modifier.fillMaxWidth().clickable { onPick(q.str("id")) }.padding(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Dot(C.quad(q.str("quadrant"))); HSpace(8.dp)
            Text(q.str("title"), fontSize = 13.sp, color = if (q.str("id") == current) C.accent else C.text, maxLines = 1)
        }
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
        brk.toIntOrNull()?.takeIf { it in 1..60 }?.let { st.breakMin = it }
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

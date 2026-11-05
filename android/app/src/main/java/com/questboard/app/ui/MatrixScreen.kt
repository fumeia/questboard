@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package com.questboard.app.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.questboard.app.QuestboardApp
import com.questboard.app.data.QUADRANTS
import com.questboard.app.data.dateKey
import com.questboard.app.data.jobj
import com.questboard.app.data.questXp
import com.questboard.app.data.str
import java.time.LocalDate

@Composable
fun MatrixScreen(app: QuestboardApp, v: Int, now: Long) {
    val s = app.store
    var open by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HabitStrip(app, v)
        for (row in listOf(listOf(QUADRANTS[0], QUADRANTS[1]), listOf(QUADRANTS[2], QUADRANTS[3]))) {
            Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (quad in row) {
                    val quests = remember(v) { s.visibleQuests(quad.id) }
                    val col = C.quad(quad.id)
                    Column(Modifier.weight(1f).fillMaxSize().clip(RoundedCornerShape(12.dp)).background(col.copy(alpha = 0.08f))
                        .border(1.dp, col.copy(alpha = 0.35f), RoundedCornerShape(12.dp)).padding(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(quad.title, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = C.text)
                                Muted("${quad.subtitle} · ${quad.xp} XP", size = 10)
                            }
                            Box(Modifier.size(30.dp).clip(CircleShape).background(col.copy(alpha = 0.3f)).clickable { adding = quad.id },
                                contentAlignment = Alignment.Center) { QbIcon("plus", C.text, 14.dp) }
                        }
                        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                            if (quests.isEmpty()) item { Muted(if (quad.id == "q4") "Nothing to drop" else "No quests yet", Modifier.padding(top = 8.dp)) }
                            items(quests, key = { it.str("id") }) { q ->
                                QuestRow(q, fmtSpent(s.questTimeMs(q, now)), s.isQuestRunning(q.str("id")),
                                    onOpen = { open = q.str("id") }, onCheck = { s.setDone(q.str("id"), !q.optBoolean("done")) },
                                    onPlay = { s.toggleQuestTimer(q.str("id")) })
                            }
                        }
                    }
                }
            }
        }
    }
    adding?.let { quad -> AddQuestDialog(app, quad) { adding = null } }
    open?.let { id -> QuestSheet(app, id, v, now) { open = null } }
}

@Composable
fun HabitStrip(app: QuestboardApp, v: Int) {
    val habits = remember(v) { app.store.habits() }
    if (habits.isEmpty()) return
    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        item { Muted("Today", size = 11) }
        items(habits, key = { it.str("id") }) { h ->
            val done = app.store.isChecked(h.str("id"))
            val streak = app.store.habitStreak(h.str("id"))
            Row(Modifier.clip(RoundedCornerShape(50)).background(if (done) C.green.copy(alpha = 0.35f) else C.card)
                .border(1.dp, if (done) C.green else C.line, RoundedCornerShape(50))
                .clickable { app.store.toggleCheckin(h.str("id")) }.padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically) {
                QbIcon(h.str("icon", "star"), C.text, 16.dp)
                if (streak > 1) { HSpace(3.dp); Text("$streak", color = C.orange, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
            }
        }
    }
}

@Composable
fun AddQuestDialog(app: QuestboardApp, quadrant: String, onDone: () -> Unit) {
    var title by remember { mutableStateOf("") }
    var quad by remember { mutableStateOf(quadrant) }
    var due by remember { mutableStateOf<String?>(null) }
    val submit = { if (app.store.addQuest(title, quad, due = due?.let { jobj("date" to it) }) != null) onDone() }
    AlertDialog(
        onDismissRequest = onDone, containerColor = C.surface,
        title = { Text("New quest") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(title, { title = it }, singleLine = true, placeholder = { Text("What needs doing?") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { submit() }))
                QuadrantChips(quad) { quad = it }
                DueChips(due) { due = it }
            }
        },
        confirmButton = { TextButton(onClick = submit) { Text("Add") } },
        dismissButton = { TextButton(onClick = onDone) { Text("Cancel") } },
    )
}

@Composable
fun QuadrantChips(selected: String, onPick: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (q in QUADRANTS) Pill(q.short, if (q.id == selected) C.quad(q.id) else C.quad(q.id).copy(alpha = 0.2f)) { onPick(q.id) }
    }
}

@Composable
fun DueChips(selected: String?, onPick: (String?) -> Unit) {
    val today = LocalDate.now()
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Muted("Due", size = 12)
        for ((label, d) in listOf("Today" to 0L, "Tomorrow" to 1L, "+1 week" to 7L)) {
            val key = dateKey(today.plusDays(d))
            Pill(label, if (selected == key) C.accent else C.card) { onPick(if (selected == key) null else key) }
        }
        if (selected != null && selected !in (listOf(0L, 1L, 7L).map { dateKey(today.plusDays(it)) })) Pill(selected, C.accent) { onPick(null) }
    }
}

/** Bottom sheet with everything you can do to one quest. */
@Composable
fun QuestSheet(app: QuestboardApp, id: String, v: Int, now: Long, onClose: () -> Unit) {
    val s = app.store
    val q = remember(v) { s.getQuest(id) }
    if (q == null) { LaunchedEffect(id) { onClose() }; return }
    val ctx = LocalContext.current
    var title by remember(id) { mutableStateOf(q.str("title")) }
    var notes by remember(id) { mutableStateOf(q.str("notes")) }
    var time by remember(id) { mutableStateOf(q.optJSONObject("scheduled")?.let { fmtMin(it.optInt("start")) } ?: "") }
    var confirmDelete by remember { mutableStateOf(false) }
    val saveText = {
        if (title.trim().isNotEmpty() && title != q.str("title")) s.updateQuest(id, mapOf("title" to title.trim()))
        if (notes != q.str("notes")) s.updateQuest(id, mapOf("notes" to notes))
    }
    ModalBottomSheet(onDismissRequest = { saveText(); onClose() }, containerColor = C.surface) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).navigationBarsPadding().padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Check(q.optBoolean("done")) { s.setDone(id, !q.optBoolean("done")) }
                HSpace(10.dp)
                OutlinedTextField(title, { title = it }, singleLine = true, modifier = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { saveText() }))
            }
            OutlinedTextField(notes, { notes = it }, placeholder = { Text("Notes") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            StepsEditor(app, q)
            Row(verticalAlignment = Alignment.CenterVertically) {
                QbIcon("sparkle", C.gold, 14.dp); HSpace(4.dp); Muted("${questXp(q)} XP", size = 13)
                HSpace(14.dp); QbIcon("stopwatch", C.muted, 14.dp); HSpace(4.dp)
                Muted(fmtSpent(s.questTimeMs(q, now)).ifEmpty { "no time yet" }, size = 13)
                Spacer(Modifier.weight(1f))
                if (q.str("link").isNotEmpty()) Pill("Open in Notion", C.card) {
                    ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(q.str("link"))))
                }
            }
            QuadrantChips(q.str("quadrant")) { s.updateQuest(id, mapOf("quadrant" to it)) }
            TopicChips(app, q)
            DueChips(q.optJSONObject("due")?.str("date")?.ifEmpty { null }) { d -> s.updateQuest(id, mapOf("due" to d?.let { jobj("date" to it) })) }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Muted("Schedule today at", size = 12)
                OutlinedTextField(time, { time = it }, singleLine = true, placeholder = { Text("14:30") }, modifier = Modifier.size(110.dp, 56.dp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = {
                        parseHm(time)?.let { m -> s.updateQuest(id, mapOf("scheduled" to jobj("date" to dateKey(), "start" to m, "duration" to 60))) }
                    }))
                if (q.optJSONObject("scheduled") != null) Pill("Clear", C.card) { time = ""; s.updateQuest(id, mapOf("scheduled" to null)) }
            }
            if (!q.optBoolean("done")) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val running = s.isQuestRunning(id)
                Pill(if (running) "Pause timer" else "Start stopwatch", if (running) C.green.copy(alpha = 0.4f) else C.card) { s.toggleQuestTimer(id) }
                Pill("${app.settings.pomodoroMin}m focus", C.red.copy(alpha = 0.35f)) { s.startPomodoro(id, app.settings.pomodoroMin) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                if (confirmDelete) Pill("Really delete", C.red) { s.deleteQuest(id); onClose() }
                else Pill("Delete", Color.Transparent, C.red) { confirmDelete = true }
                TextButton(onClick = { saveText(); onClose() }) { Text("Done") }
            }
            Spacer(Modifier.height(4.dp))
        }
    }
}

/** Topic / course (for stats). Notion quests get their module automatically. */
@Composable
fun TopicChips(app: QuestboardApp, q: org.json.JSONObject) {
    val id = q.str("id")
    val current = q.str("topic")
    var newTopic by remember(id) { mutableStateOf("") }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Muted("Topic", size = 12)
        for (t in app.store.topics().take(6))
            Pill(t, if (t == current) C.accent else C.card) { app.store.updateQuest(id, mapOf("topic" to if (t == current) null else t)) }
    }
    OutlinedTextField(newTopic, { newTopic = it }, singleLine = true, placeholder = { Text("New topic / course") },
        modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { if (newTopic.isNotBlank()) app.store.updateQuest(id, mapOf("topic" to newTopic.trim())); newTopic = "" }))
}

/** Steps of a group: tick each (10 XP); all done = quest XP + 50 % bonus. */
@Composable
fun StepsEditor(app: QuestboardApp, q: org.json.JSONObject) {
    val s = app.store
    val id = q.str("id")
    val steps = s.steps(q)
    var newStep by remember(id) { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Muted(if (steps.isEmpty()) "Steps — split it up (each step 10 XP, finishing all: +${com.questboard.app.data.groupBonus(q)} bonus)"
              else "Steps ${steps.count { it.optBoolean("done") }}/${steps.size} · finishing all: +${com.questboard.app.data.groupBonus(q)} bonus", size = 12)
        for (st in steps) Row(verticalAlignment = Alignment.CenterVertically) {
            Check(st.optBoolean("done")) { s.toggleStep(id, st.str("id")) }
            HSpace(8.dp)
            Text(st.str("title"), fontSize = 14.sp, color = if (st.optBoolean("done")) C.muted else C.text, modifier = Modifier.weight(1f))
            IconBtn("close", { s.deleteStep(id, st.str("id")) }, C.muted, 14.dp)
        }
        OutlinedTextField(newStep, { newStep = it }, singleLine = true, placeholder = { Text("Add a step, e.g. Exercise 1") },
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { s.addStep(id, newStep); newStep = "" }))
    }
}

fun parseHm(text: String): Int? {
    val m = Regex("^(\\d{1,2})(?::?(\\d{2}))?$").find(text.trim()) ?: return null
    val h = m.groupValues[1].toInt()
    val min = m.groupValues[2].ifEmpty { "0" }.toInt()
    return if (h in 0..23 && min in 0..59) h * 60 + min else null
}

package com.questboard.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.questboard.app.QuestboardApp
import com.questboard.app.data.GOAL_XP
import com.questboard.app.data.str
import org.json.JSONObject

/** One long-term goal on the Progress screen: progress, time, linked quests and steps. */
@Composable
fun GoalCard(app: QuestboardApp, g: JSONObject, now: Long, open: Boolean, onToggle: () -> Unit, onOpenQuest: (String) -> Unit) {
    val s = app.store
    val id = g.str("id")
    val done = g.optBoolean("done")
    val p = s.goalProgress(id, now)
    var title by remember(id) { mutableStateOf(g.str("title")) }
    var newQuest by remember(id) { mutableStateOf("") }
    var confirmDelete by remember(id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.card)
        .border(1.dp, if (done) C.gold.copy(alpha = 0.5f) else C.line, RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth().clickable(onClick = onToggle), verticalAlignment = Alignment.CenterVertically) {
            Check(done) { s.setGoalDone(id, !done) }
            HSpace(10.dp)
            Column(Modifier.weight(1f)) {
                Text(g.str("title"), fontSize = 15.sp, fontWeight = FontWeight.Bold, color = if (done) C.muted else C.text)
                val spent = fmtSpent(p.ms)
                Muted(listOfNotNull(if (p.total > 0) "${p.done}/${p.total} done" else "nothing linked yet", spent.ifEmpty { null },
                    if (done) "reached · +$GOAL_XP XP" else null).joinToString(" · "), size = 12)
            }
            Text("${(p.frac * 100).toInt()} %", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = if (p.frac >= 1f) C.green else C.muted)
        }
        Bar(p.frac, if (done) C.gold else C.green, Modifier.fillMaxWidth())
        if (!open) return@Column
        val items = s.goalItems(id)
        for (q in items.quests) Row(verticalAlignment = Alignment.CenterVertically) {
            Check(q.optBoolean("done")) { s.setDone(q.str("id"), !q.optBoolean("done")) }
            HSpace(8.dp)
            Dot(C.quad(q.str("quadrant")))
            HSpace(6.dp)
            val st = s.steps(q)
            Text(q.str("title") + if (st.isNotEmpty()) "  ${st.count { it.optBoolean("done") }}/${st.size}" else "", fontSize = 14.sp,
                color = if (q.optBoolean("done")) C.muted else C.text, modifier = Modifier.weight(1f).clickable { onOpenQuest(q.str("id")) })
            Muted(fmtSpent(s.questTimeMs(q, now)), size = 11)
        }
        for ((q, st) in items.steps) Row(verticalAlignment = Alignment.CenterVertically) {
            Check(st.optBoolean("done")) { s.toggleStep(q.str("id"), st.str("id")) }
            HSpace(8.dp)
            Column(Modifier.weight(1f).clickable { onOpenQuest(q.str("id")) }) {
                Text(st.str("title"), fontSize = 14.sp, color = if (st.optBoolean("done")) C.muted else C.text)
                Muted("step of ${q.str("title")}", size = 11)
            }
            Muted(fmtSpent(s.stepTimeMs(q.str("id"), st.str("id"), now)), size = 11)
        }
        if (!done) OutlinedTextField(newQuest, { newQuest = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Add a quest for this goal") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { s.addQuest(newQuest, "q2", goalId = id); newQuest = "" }))
        OutlinedTextField(title, { title = it }, singleLine = true, modifier = Modifier.fillMaxWidth(), label = { Text("Goal title") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (title.isNotBlank()) s.updateGoal(id, mapOf("title" to title.trim())) }))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Muted("Link more from a quest's details (whole quest or single steps).", Modifier.weight(1f), 11)
            Spacer(Modifier.padding(4.dp))
            if (confirmDelete) Pill("Really delete", C.red) { s.deleteGoal(id) }
            else Pill("Delete", Color.Transparent, C.red) { confirmDelete = true }
        }
    }
}

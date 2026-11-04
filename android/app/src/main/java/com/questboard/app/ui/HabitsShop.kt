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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.questboard.app.QuestboardApp
import com.questboard.app.data.PICKABLE_ICONS
import com.questboard.app.data.dateKey
import com.questboard.app.data.dateKeyOf
import com.questboard.app.data.habitXp
import com.questboard.app.data.str
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale

@Composable
fun IconPicker(selected: String, onPick: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (name in PICKABLE_ICONS) {
            Box(Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)).background(if (name == selected) C.accent else C.card)
                .clickable { onPick(name) }, contentAlignment = Alignment.Center) { QbIcon(name, C.text, 18.dp) }
        }
    }
}

// ------------------------------------------------------------------ habits

@Composable
fun HabitsScreen(app: QuestboardApp, v: Int) {
    val s = app.store
    val habits = remember(v) { s.habits() }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var adding by remember { mutableStateOf(false) }
    val today = LocalDate.now()
    val weekStart = today.minusDays((today.dayOfWeek.value - 1).toLong())
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Habits", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    Muted("A 3-day streak gives +20 % XP, a 7-day streak +50 %.")
                }
                Pill("New habit", C.accent) { adding = true }
            }
        }
        if (habits.isEmpty()) item { Muted("No habits yet. Add one you want to do every day — reading, water, workout…", Modifier.padding(top = 20.dp), 14) }
        items(habits, key = { it.str("id") }) { h ->
            val id = h.str("id")
            val done = s.isChecked(id)
            val streak = s.habitStreak(id)
            val target = h.optInt("target", 7)
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.card).padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(44.dp).clip(CircleShape).background(if (done) C.green else C.surface)
                        .border(2.dp, if (done) C.green else C.line, CircleShape).clickable { s.toggleCheckin(id) },
                        contentAlignment = Alignment.Center) { QbIcon(h.str("icon", "star"), C.text, 22.dp) }
                    HSpace(10.dp)
                    Column(Modifier.weight(1f).clickable { editing = h }) {
                        Text(h.str("title"), fontWeight = FontWeight.Bold, fontSize = 15.sp)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            QbIcon("flame", if (streak > 0) C.orange else C.muted, 13.dp); HSpace(2.dp)
                            Muted("${streak}d", size = 12); HSpace(10.dp)
                            Muted("${s.habitWeekCount(id)}/$target this week", size = 12); HSpace(10.dp)
                            QbIcon("sparkle", C.gold, 12.dp); HSpace(2.dp)
                            Muted("${habitXp(h.optInt("xp", 10), if (done) streak else streak + 1)} XP", size = 12)
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (i in 0..6) {
                        val d = weekStart.plusDays(i.toLong())
                        val key = dateKey(d)
                        val checked = s.isChecked(id, key)
                        val future = d.isAfter(today)
                        Box(Modifier.weight(1f).height(34.dp).clip(RoundedCornerShape(8.dp))
                            .background(if (checked) C.green.copy(alpha = 0.75f) else if (future) Color.Transparent else C.surface)
                            .border(if (d == today) 1.dp else 0.dp, if (d == today) C.text else Color.Transparent, RoundedCornerShape(8.dp))
                            .let { if (!future) it.clickable { s.toggleCheckin(id, key) } else it },
                            contentAlignment = Alignment.Center) {
                            Text(d.dayOfWeek.getDisplayName(TextStyle.NARROW, Locale.getDefault()), fontSize = 12.sp,
                                color = if (future) C.muted else C.text, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
    if (adding) HabitDialog(app, null) { adding = false }
    editing?.let { h -> HabitDialog(app, h) { editing = null } }
}

@Composable
private fun HabitDialog(app: QuestboardApp, h: JSONObject?, onDone: () -> Unit) {
    var title by remember { mutableStateOf(h?.str("title") ?: "") }
    var icon by remember { mutableStateOf(h?.str("icon", "star") ?: "star") }
    var xp by remember { mutableStateOf(h?.optInt("xp", 10) ?: 10) }
    var target by remember { mutableStateOf(h?.optInt("target", 7) ?: 7) }
    var confirm by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDone, containerColor = C.surface,
        title = { Text(if (h == null) "New habit" else "Edit habit") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(title, { title = it }, singleLine = true, placeholder = { Text("Read 20 pages") })
                IconPicker(icon) { icon = it }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (t in listOf(7, 5, 3, 1)) Pill(if (t == 7) "Daily" else if (t == 1) "Weekly" else "$t× / week", if (target == t) C.accent else C.card) { target = t }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (x in listOf(5, 10, 20, 30, 50)) Pill("$x XP", if (xp == x) C.gold.copy(alpha = 0.6f) else C.card) { xp = x }
                }
                if (h != null) {
                    if (confirm) Pill("Really delete (history stays)", C.red) { app.store.deleteHabit(h.str("id")); onDone() }
                    else Pill("Delete habit", Color.Transparent, C.red) { confirm = true }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (h == null) app.store.addHabit(title, icon, xp, target)
                else app.store.updateHabit(h.str("id"), mapOf("title" to title.trim().ifEmpty { h.str("title") }, "icon" to icon, "xp" to xp, "target" to target))
                onDone()
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDone) { Text("Cancel") } },
    )
}

// -------------------------------------------------------------------- shop

@Composable
fun ShopScreen(app: QuestboardApp, v: Int) {
    val s = app.store
    val rewards = remember(v) { s.rewards() }
    val history = remember(v) { s.purchases(15) }
    val balance = s.balance
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var adding by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<String?>(null) }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        QbIcon("coin", C.gold, 24.dp); HSpace(6.dp)
                        Text("$balance coins", color = C.gold, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                    }
                    Muted("Coins = XP earned minus what you spent. Your level never goes down.")
                }
                Pill("New reward", C.accent) { adding = true }
            }
        }
        items(rewards, key = { it.str("id") }) { r ->
            val cost = r.optInt("cost")
            val ok = balance >= cost
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.card).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(42.dp).clip(RoundedCornerShape(10.dp)).background(C.gold.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
                    QbIcon(r.str("icon", "gift"), C.gold, 22.dp)
                }
                HSpace(10.dp)
                Column(Modifier.weight(1f).clickable { editing = r }) {
                    Text(r.str("title"), fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        QbIcon("coin", C.gold, 12.dp); HSpace(3.dp)
                        Text("$cost", color = C.gold, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        if (!ok) { HSpace(8.dp); Muted("${cost - balance} to go", size = 12) }
                        if (!r.optBoolean("repeatable", true)) { HSpace(8.dp); Muted("one-time", size = 12) }
                    }
                    if (!ok) Bar(balance.toFloat() / cost, C.gold, Modifier.fillMaxWidth().padding(top = 4.dp), 4.dp)
                }
                HSpace(8.dp)
                if (confirm == r.str("id")) {
                    Pill("Confirm", Color(0xFFE5A50A)) {
                        confirm = null
                        if (s.buy(r.str("id"))) app.notifier.alert(r.str("id").hashCode(), "Reward redeemed", "Enjoy: ${r.str("title")}", "shop")
                    }
                } else Pill("Redeem", if (ok) Color(0xCCE5A50A) else C.surface, if (ok) C.text else C.muted) { if (ok) confirm = r.str("id") }
            }
        }
        if (history.isNotEmpty()) {
            item { SectionTitle("Recently redeemed") }
            items(history, key = { it.str("id") }) { l ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Muted(LocalDate.parse(dateKeyOf(l.optLong("at"))).let { "${it.dayOfMonth}.${it.monthValue}." }, size = 12)
                    HSpace(10.dp)
                    Text(l.str("note"), fontSize = 13.sp, modifier = Modifier.weight(1f))
                    QbIcon("coin", C.muted, 12.dp); HSpace(2.dp); Muted("${-l.optInt("amount")}", size = 12)
                    if (System.currentTimeMillis() - l.optLong("at") < 86_400_000) IconBtn("undo", { s.refund(l.str("id")) }, C.muted, 16.dp)
                }
            }
        }
    }
    if (adding) RewardDialog(app, null) { adding = false }
    editing?.let { r -> RewardDialog(app, r) { editing = null } }
}

@Composable
private fun RewardDialog(app: QuestboardApp, r: JSONObject?, onDone: () -> Unit) {
    var title by remember { mutableStateOf(r?.str("title") ?: "") }
    var cost by remember { mutableStateOf(r?.optInt("cost")?.toString() ?: "") }
    var icon by remember { mutableStateOf(r?.str("icon", "gift") ?: "gift") }
    var repeat by remember { mutableStateOf(r?.optBoolean("repeatable", true) ?: true) }
    var confirm by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDone, containerColor = C.surface,
        title = { Text(if (r == null) "New reward" else "Edit reward") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(title, { title = it }, singleLine = true, placeholder = { Text("New headphones") })
                OutlinedTextField(cost, { cost = it.filter(Char::isDigit) }, singleLine = true, placeholder = { Text("Cost in coins") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions())
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Pill("Repeatable", if (repeat) C.accent else C.card) { repeat = true }
                    Pill("One-time", if (!repeat) C.accent else C.card) { repeat = false }
                }
                IconPicker(icon) { icon = it }
                if (r != null) {
                    if (confirm) Pill("Really delete", C.red) { app.store.deleteReward(r.str("id")); onDone() }
                    else Pill("Delete reward", Color.Transparent, C.red) { confirm = true }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val c = cost.toIntOrNull() ?: 0
                if (r == null) { if (app.store.addReward(title, c, icon, repeat) != null) onDone() }
                else { app.store.updateReward(r.str("id"), mapOf("title" to title.trim().ifEmpty { r.str("title") },
                    "cost" to (if (c > 0) c else r.optInt("cost")), "icon" to icon, "repeatable" to repeat)); onDone() }
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDone) { Text("Cancel") } },
    )
}

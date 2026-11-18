package com.questboard.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.IntrinsicSize
import com.questboard.app.data.dateKey
import com.questboard.app.data.Store
import androidx.compose.ui.graphics.Color
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.questboard.app.QuestboardApp
import com.questboard.app.data.NO_GOAL
import com.questboard.app.data.GOAL_XP
import com.questboard.app.data.str
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale

private fun dur(ms: Long): String {
    val m = (ms + 30_000) / 60_000
    return if (m >= 60) "${m / 60}h %02dm".format(m % 60) else "${m}m"
}

/** Progress tab: long-term goals (progress + time) on top, then stats for the picked range. */
@Composable
fun ProgressScreen(app: QuestboardApp, v: Int, now: Long) {
    val s = app.store
    val goals = remember(v) { s.goals() }
    val review = remember(v) { s.weekReview(now) }
    var newGoal by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(setOf<String>()) }
    var openQuest by remember { mutableStateOf<String?>(null) }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Text("This week", fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.padding(top = 10.dp))
            Row(Modifier.padding(top = 6.dp).height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((icon, value, caption) in listOf(
                    Triple("stopwatch", dur(review.focusThis), "focus · was ${dur(review.focusPrev)}"),
                    Triple("check", "${review.questsThis}", "quests · was ${review.questsPrev}"),
                    Triple("star", "${review.goalsReached}", "goals reached"),
                    Triple("flame", "${review.streak}d", "streak"),
                )) Column(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(10.dp)).background(C.card).padding(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) { QbIcon(icon, C.muted, 13.dp); HSpace(4.dp)
                        Text(value, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, maxLines = 1, softWrap = false) }
                    Muted(caption, size = 10)
                }
            }
            Text("Goals", fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.padding(top = 14.dp))
            OutlinedTextField(newGoal, { newGoal = it }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                placeholder = { Text("New long-term goal, e.g. Pass the semester") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { s.addGoal(newGoal)?.let { expanded = expanded + it.str("id") }; newGoal = "" }))
        }
        if (goals.isEmpty()) item {
            Muted("No goals yet. Add one, then link quests — or single steps — to it from a quest's details. Reaching a goal: +$GOAL_XP XP.", size = 13)
        }
        items(goals, key = { it.str("id") }) { g ->
            val gid = g.str("id")
            GoalCard(app, g, now, gid in expanded, { expanded = if (gid in expanded) expanded - gid else expanded + gid }) { openQuest = it }
        }
        item { StatsBlock(app, v) }
        item { Box(Modifier.height(12.dp)) }
    }
    openQuest?.let { id -> QuestSheet(app, id, v, now) { openQuest = null } }
}

// ----------------------------------------------------------------- stats

/** Goal colours: a goal keeps its colour (its place among all goals ever made); time without a goal is grey. */
private val GOAL_COLORS = listOf(Color(0xFF3584E4), Color(0xFFFFA348), Color(0xFF2EC27E), Color(0xFFC061CB), Color(0xFFF8E45C),
    Color(0xFF33C7DE), Color(0xFFE5534B), Color(0xFFDC8ADD), Color(0xFF8FF0A4), Color(0xFFCDAB8F))
private val NO_GOAL_COLOR = Color(0x66FFFFFF)

private fun goalColor(order: List<String>, gid: String): Color =
    if (gid.isEmpty()) NO_GOAL_COLOR else GOAL_COLORS[order.indexOf(gid).coerceAtLeast(0) % GOAL_COLORS.size]

private fun dayLabel(key: String): String {
    val d = LocalDate.parse(key)
    return "${d.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())} ${d.dayOfMonth}.${d.monthValue}."
}

/** Stats: range (week / 30 days / all time), totals, a chart (bars by goal per day, or the heatmap for all time), time per goal. */
@Composable
private fun StatsBlock(app: QuestboardApp, v: Int) {
    val s = app.store
    var range by remember { mutableIntStateOf(7) }
    var picked by remember(range) { mutableStateOf<String?>(null) }
    val st = remember(v, range) { s.stats(range) }
    val order = remember(v) { s.goalOrder() }
    val title = { gid: String -> if (gid.isEmpty()) NO_GOAL else s.getGoal(gid)?.str("title") ?: "(deleted goal)" }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 10.dp)) {
            Text("Stats", fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.weight(1f))
            for ((d, t) in listOf(7 to "Week", 30 to "30 days", 0 to "All time")) { Pill(t, if (range == d) C.accent else C.card) { range = d }; HSpace(4.dp) }
        }
        // totals for the range
        val perDay = remember(v, range) { s.focusPerDay() }
        val days = if (range > 0) range else perDay.keys.filter { (perDay[it] ?: 0) > 0 }.minOrNull()
            ?.let { (java.time.temporal.ChronoUnit.DAYS.between(LocalDate.parse(it), LocalDate.now()) + 1).toInt() } ?: 1
        // equal tiles: caption with its icon on top, the number below on one line (long times no longer wrap)
        Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((icon, value, caption) in listOf(
                Triple("stopwatch", dur(st.focusMs), "focus"), Triple("sun", dur(st.focusMs / days.coerceAtLeast(1)), "avg per day"),
                Triple("sparkle", "${st.xp}", "XP"), Triple("check", "${st.questsDone}", "quests done"),
            )) Column(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(10.dp)).background(C.card).padding(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) { QbIcon(icon, C.muted, 12.dp); HSpace(3.dp); Muted(caption, size = 10) }
                Text(value, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, maxLines = 1, softWrap = false, modifier = Modifier.padding(top = 2.dp))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            QbIcon("flame", C.orange, 15.dp); HSpace(4.dp)
            Text("${st.streak}-day streak", fontWeight = FontWeight.Bold); HSpace(8.dp)
            Muted("best ${st.bestStreak} days · ${st.pomodoros} Pomodoros", size = 12)
        }
        // chart
        if (range > 0) {
            val bars = remember(v, range) { s.dailyByGoal(range) }
            SectionTitle(if (range == 7) "Focus per day, by goal" else "Focus per day, last 30 days, by goal")
            GoalBars(bars, order, range == 7, picked) { picked = if (picked == it) null else it }
            picked?.let { k -> bars.find { it.date == k } }?.let { d ->
                Muted("${dayLabel(d.date)}: ${dur(d.total)}" + if (d.parts.isNotEmpty()) " — " + d.parts.joinToString(", ") { "${title(it.first)} ${dur(it.second)}" } else "", size = 12)
            } ?: Muted("Tap a day for its details.", size = 11)
        } else {
            SectionTitle("Every day you studied")
            Heatmap(perDay, picked) { picked = if (picked == it) null else it }
            picked?.let { Muted("${dayLabel(it)}: ${dur(perDay[it] ?: 0)}", size = 12) }
            val studied = perDay.filter { it.value > 0 }.keys.sorted()
            var best = 0; var run = 0; var prev: LocalDate? = null
            for (k in studied) { val c = LocalDate.parse(k); run = if (prev != null && prev.plusDays(1) == c) run + 1 else 1; best = maxOf(best, run); prev = c }
            Muted("${studied.size} days with focus time · longest run $best days · ${dur(perDay.values.sum())} in total", size = 12)
        }
        // time per goal, same colours as the bars
        SectionTitle("Time per goal")
        if (st.goalTime.isEmpty()) Muted("No focus time yet. Link quests to goals and start a timer.", size = 13)
        val gTotal = st.goalTime.sumOf { it.second }.coerceAtLeast(1)
        for ((gid, ms) in st.goalTime) Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Dot(goalColor(order, gid), 10.dp); HSpace(6.dp)
                Text(title(gid), fontWeight = FontWeight.Bold, fontSize = 14.sp, modifier = Modifier.weight(1f), color = if (gid.isEmpty()) C.muted else C.text, maxLines = 1)
                Muted("${dur(ms)} · ${100 * ms / gTotal} %", size = 12)
            }
            Bar(ms.toFloat() / gTotal, goalColor(order, gid), Modifier.fillMaxWidth().padding(top = 3.dp), 5.dp)
        }
        if (st.topQuests.isNotEmpty()) {
            SectionTitle("Most time spent on")
            for ((t, ms) in st.topQuests) Row { Text(t, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1); Muted(dur(ms), size = 12) }
        }
    }
}

/** One bar per day, stacked by goal (the goal colours), tap a bar for the day's breakdown. */
@Composable
private fun GoalBars(bars: List<Store.DayGoals>, order: List<String>, week: Boolean, picked: String?, onPick: (String) -> Unit) {
    val max = bars.maxOfOrNull { it.total }?.coerceAtLeast(1) ?: 1
    Row(Modifier.fillMaxWidth().height(if (week) 160.dp else 134.dp).clip(RoundedCornerShape(10.dp)).background(C.card).padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(if (week) 6.dp else 2.dp), verticalAlignment = Alignment.Bottom) {
        bars.forEachIndexed { i, d ->
            Column(Modifier.weight(1f).fillMaxHeight().clickable { onPick(d.date) }, horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Bottom) {
                // its own line above the bar, tall enough for the text (it used to spill into the bar)
                if (week) Box(Modifier.height(16.dp), contentAlignment = Alignment.BottomCenter) {
                    if (d.total > 0) Text(dur(d.total), fontSize = 9.sp, lineHeight = 11.sp, color = C.muted, maxLines = 1, softWrap = false,
                        modifier = Modifier.wrapContentWidth(Alignment.CenterHorizontally, unbounded = true).padding(bottom = 2.dp))
                }
                Column(Modifier.fillMaxWidth().height((90f * d.total / max).coerceAtLeast(if (d.total > 0) 3f else 1f).dp)
                    .clip(RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp))
                    .background(if (d.total == 0L) C.line else Color.Transparent)
                    .let { if (picked == d.date) it.border(1.dp, C.text, RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp)) else it }) {
                    // first goal at the bottom, like a stack
                    for ((gid, ms) in d.parts.reversed()) Box(Modifier.fillMaxWidth().weight(ms.toFloat().coerceAtLeast(1f)).background(goalColor(order, gid)))
                }
                // fixed-height label line: every bar stands on the same baseline; day numbers may be wider than a thin bar
                val date = LocalDate.parse(d.date)
                Box(Modifier.height(if (week) 20.dp else 16.dp).padding(top = 3.dp), contentAlignment = Alignment.TopCenter) {
                    Text(if (week) date.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault()).take(2)
                         else if (i % 5 == 4 || i == bars.lastIndex) "${date.dayOfMonth}" else "",
                        fontSize = if (week) 11.sp else 9.sp, lineHeight = if (week) 13.sp else 11.sp, color = C.muted, maxLines = 1, softWrap = false,
                        modifier = Modifier.wrapContentWidth(Alignment.CenterHorizontally, unbounded = true))
                }
            }
        }
    }
}

/** Anki-style year calendar: one column per week, one square per day, darker green = more focus time. Scrolls back to the first day. */
@Composable
private fun Heatmap(perDay: Map<String, Long>, picked: String?, onPick: (String) -> Unit) {
    val today = LocalDate.now()
    val first = perDay.filter { it.value > 0 }.keys.minOrNull()?.let { LocalDate.parse(it) } ?: today
    val start = minOf(first, today.minusWeeks(16)).let { it.minusDays((it.dayOfWeek.value - 1).toLong()) }  // a Monday
    val weeks = (java.time.temporal.ChronoUnit.DAYS.between(start, today) / 7 + 1).toInt()
    val cell = 13.dp
    val scroll = rememberScrollState()
    LaunchedEffect(weeks) { scroll.scrollTo(scroll.maxValue) }
    fun level(ms: Long): Float { val m = ms / 60_000; return when { m <= 0 -> 0f; m < 30 -> 0.25f; m < 60 -> 0.45f; m < 120 -> 0.65f; m < 180 -> 0.85f; else -> 1f } }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.card).padding(8.dp)) {
        Row {
            Column(Modifier.padding(top = 14.dp)) {
                for (i in 0..6) Box(Modifier.size(22.dp, cell).padding(bottom = 2.dp)) {
                    if (i % 2 == 0) Muted(java.time.DayOfWeek.of(i + 1).getDisplayName(TextStyle.SHORT, Locale.getDefault()).take(2), size = 9)
                }
            }
            Column(Modifier.horizontalScroll(scroll)) {
                Row {  // month names above the week where a month starts
                    for (w in 0 until weeks) {
                        val monday = start.plusWeeks(w.toLong())
                        Box(Modifier.width(cell + 2.dp).height(14.dp)) {
                            if (w == 0 || monday.month != monday.minusWeeks(1).month)
                                Text(monday.month.getDisplayName(TextStyle.SHORT, Locale.getDefault()), fontSize = 9.sp, color = C.muted,
                                    softWrap = false, modifier = Modifier.wrapContentWidth(Alignment.Start, unbounded = true))
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    for (w in 0 until weeks) Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        for (dow in 0..6) {
                            val day = start.plusWeeks(w.toLong()).plusDays(dow.toLong())
                            val k = dateKey(day)
                            val l = level(perDay[k] ?: 0)
                            Box(Modifier.size(cell).clip(RoundedCornerShape(2.dp))
                                .background(if (day.isAfter(today)) Color.Transparent else if (l == 0f) C.line else C.green.copy(alpha = l))
                                .let { if (picked == k) it.border(1.dp, C.text, RoundedCornerShape(2.dp)) else it }
                                .clickable(enabled = !day.isAfter(today)) { onPick(k) })
                        }
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
            Muted("less", size = 10); HSpace(4.dp)
            for (l in listOf(0f, 0.25f, 0.45f, 0.65f, 0.85f, 1f)) { Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(if (l == 0f) C.line else C.green.copy(alpha = l))); HSpace(2.dp) }
            HSpace(2.dp); Muted("more  (under 30 min · 1 h · 2 h · 3 h · more)", size = 10)
        }
    }
}

package com.questboard.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.questboard.app.QuestboardApp
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale

private fun dur(ms: Long): String {
    val m = (ms + 30_000) / 60_000
    return if (m >= 60) "${m / 60}h %02dm".format(m % 60) else "${m}m"
}

@Composable
fun StatsScreen(app: QuestboardApp, v: Int, onBack: () -> Unit) {
    var range by remember { mutableIntStateOf(7) }
    val st = remember(v, range) { app.store.stats(range) }
    val total = st.byTopic.sumOf { it.second }.coerceAtLeast(1)
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 14.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                TextButton(onClick = onBack) { Text("‹ Back") }
                Text("Stats", fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.weight(1f))
                for ((d, t) in listOf(7 to "7d", 30 to "30d", 0 to "All")) { Pill(t, if (range == d) C.accent else C.card) { range = d }; HSpace(4.dp) }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((icon, value, caption) in listOf(
                    Triple("stopwatch", dur(st.focusMs), "focus"), Triple("sparkle", "${st.xp}", "XP"),
                    Triple("check", "${st.questsDone}", "quests"), Triple("target", "${st.pomodoros}", "pomodoros"),
                )) Column(Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(C.card).padding(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) { QbIcon(icon, C.muted, 13.dp); HSpace(4.dp)
                        Text(value, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp) }
                    Muted(caption, size = 11)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                QbIcon("flame", C.orange, 15.dp); HSpace(4.dp)
                Text("${st.streak}-day streak", fontWeight = FontWeight.Bold); HSpace(8.dp); Muted("best ${st.bestStreak} days", size = 12)
            }
        }
        item {
            SectionTitle("Focus, last 7 days")
            val max = st.daily.maxOf { it.focusMs }.coerceAtLeast(1)
            Row(Modifier.fillMaxWidth().height(130.dp).clip(RoundedCornerShape(10.dp)).background(C.card).padding(8.dp),
                horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.Bottom) {
                for (d in st.daily) Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f)) {
                    if (d.focusMs > 0) Muted(dur(d.focusMs), size = 9)
                    Box(Modifier.width(18.dp).height((80f * d.focusMs / max).coerceAtLeast(2f).dp)
                        .clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp)).background(C.accent))
                    Muted(LocalDate.parse(d.date).dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault()).take(2), size = 11)
                }
            }
        }
        item { SectionTitle("Time per topic") }
        if (st.byTopic.isEmpty()) item { Muted("No focus time yet. Give quests a topic and start a timer.", size = 13) }
        items(st.byTopic) { (topic, ms) ->
            Column {
                Row { Text(topic, fontWeight = FontWeight.Bold, fontSize = 14.sp, modifier = Modifier.weight(1f), color = if (topic == "No topic") C.muted else C.text)
                    Muted("${dur(ms)} · ${100 * ms / total} %", size = 12) }
                Bar(ms.toFloat() / total, C.accent, Modifier.fillMaxWidth().padding(top = 3.dp), 5.dp)
            }
        }
        if (st.topQuests.isNotEmpty()) {
            item { SectionTitle("Most time spent on") }
            items(st.topQuests) { (title, ms) -> Row { Text(title, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1); Muted(dur(ms), size = 12) } }
        }
    }
}

@Suppress("unused")
private val keep = Modifier.fillMaxHeight()

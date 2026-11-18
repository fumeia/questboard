package com.questboard.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.questboard.app.QuestboardApp
import com.questboard.app.data.Achievement
import com.questboard.app.data.DAILY_XP
import com.questboard.app.data.RANKS
import com.questboard.app.data.XP_SOURCES
import com.questboard.app.data.levelInfo
import com.questboard.app.data.rankName

/** Your rank, what the next one needs, the daily focus target, where XP comes from, achievements and the rank ladder. */
@Composable
fun LevelScreen(app: QuestboardApp, v: Int, now: Long, onBack: () -> Unit) {
    val s = app.store
    val info = remember(v) { levelInfo(s.xp) }
    val achs = remember(v) { s.achievements() }
    var target by remember { mutableIntStateOf(app.settings.dailyTargetMin) }
    val focus = s.focusOn(now = now)
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBack) { Text("‹ Back") }
                Text("Level & achievements", fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
            // rank card
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.gold.copy(alpha = 0.1f))
                .border(1.dp, C.gold.copy(alpha = 0.35f), RoundedCornerShape(14.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.clip(RoundedCornerShape(50)).background(C.gold).padding(horizontal = 12.dp, vertical = 6.dp)) {
                        Text("Lv ${info.level}", fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, color = C.ink)
                    }
                    HSpace(12.dp)
                    Column {
                        Text(rankName(info.level), fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                        Muted("${s.xp} XP in total · coins ${s.balance}", size = 12)
                    }
                }
                Bar(info.frac, C.gold, Modifier.fillMaxWidth(), 8.dp)
                Muted("${info.span - info.into} XP to Lv ${info.level + 1} · ${rankName(info.level + 1)}", size = 13)
                Muted("Your level only goes up. Coins are the XP you have not spent in the shop yet.", size = 12)
            }
        }
        // today: the daily focus target
        item {
            SectionTitle("Today")
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.card).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    QbIcon("sun", C.gold, 16.dp); HSpace(6.dp)
                    Text(if (target > 0) "Focus ${fmtSpent(focus).ifEmpty { "0m" }} of ${fmtSpent(target * 60_000L)}" +
                        (if (s.dailyHit()) " · reached, +$DAILY_XP XP" else "") else "Daily focus target off",
                        fontWeight = FontWeight.Bold, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    Pill("−30m", C.surface) { target = (target - 30).coerceAtLeast(0); app.settings.dailyTargetMin = target }
                    HSpace(6.dp)
                    Pill("+30m", C.surface) { target = (target + 30).coerceAtMost(720); app.settings.dailyTargetMin = target }
                }
                if (target > 0) Bar(focus.toFloat() / (target * 60_000L), C.green, Modifier.fillMaxWidth())
                Muted("Timers and Physics RPG study time count. Reaching it pays +$DAILY_XP XP once a day and keeps the streak. " +
                    "XP today: ${s.xpOn()}.", size = 12)
            }
        }
        // where XP comes from
        item {
            SectionTitle("How you earn XP")
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((icon, what, how) in XP_SOURCES) Row(verticalAlignment = Alignment.CenterVertically) {
                    QbIcon(icon, C.muted, 14.dp); HSpace(8.dp)
                    Text(what, fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.width(150.dp))
                    Muted(how, Modifier.weight(1f), 12)
                }
            }
        }
        // achievements, nearest first, then the ones you have
        item {
            SectionTitle("Achievements · ${achs.count { it.done }}/${achs.size}")
            val sorted = achs.filter { !it.done }.sortedByDescending { it.cur.toFloat() / it.target } + achs.filter { it.done }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (pair in sorted.chunked(2)) Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (a in pair) AchievementTile(a, Modifier.weight(1f).fillMaxHeight())
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
        // the ladder
        item {
            SectionTitle("Ranks")
            Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(bottom = 16.dp)) {
                for (lv in 1..maxOf(info.level + 2, RANKS.size)) {
                    val cur = lv == info.level
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(if (cur) C.gold.copy(alpha = 0.2f) else C.bg)
                        .padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Lv $lv", fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.width(52.dp))
                        Text(rankName(lv), fontSize = 13.sp, fontWeight = if (cur) FontWeight.Bold else FontWeight.Normal,
                            color = if (lv < info.level) C.muted else C.text, modifier = Modifier.weight(1f))
                        Muted("${50 * lv * (lv - 1)} XP", size = 12)
                    }
                }
            }
        }
    }
}

@Composable
private fun AchievementTile(a: Achievement, modifier: Modifier) {
    Row(modifier.clip(RoundedCornerShape(10.dp)).background(if (a.done) C.gold.copy(alpha = 0.12f) else C.card)
        .border(1.dp, if (a.done) C.gold.copy(alpha = 0.4f) else C.line, RoundedCornerShape(10.dp)).padding(8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(30.dp).clip(CircleShape).background(if (a.done) C.gold else C.surface), contentAlignment = Alignment.Center) {
            QbIcon(a.icon, if (a.done) C.ink else C.muted, 16.dp)
        }
        HSpace(8.dp)
        Column(Modifier.weight(1f)) {
            Text(a.title, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = if (a.done) C.text else C.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Muted(if (a.done) "${a.desc} · +${a.xp} XP" else "${a.desc} · ${a.cur}/${a.target}", size = 11)
            if (!a.done) Bar(a.cur.toFloat() / a.target, C.gold, Modifier.fillMaxWidth().padding(top = 3.dp), 3.dp)
        }
    }
}

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
import androidx.compose.ui.graphics.Color
import com.questboard.app.data.ACHIEVEMENTS
import com.questboard.app.data.FamilyProgress
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
    val fams = remember(v) { s.achievementFamilies() }
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
                    LevelRing(info.level, info.frac, 60.dp, 22)
                    HSpace(12.dp)
                    Column {
                        Text(rankName(info.level), fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                        Muted("${s.xp} XP in total · coins ${s.balance}", size = 12)
                    }
                }
                Muted(if (info.level >= RANKS.size) "${info.into} XP into Lv ${info.level} · the top of the ladder"
                    else "${info.into} / ${info.span} XP into Lv ${info.level} · ${info.span - info.into} to Lv ${info.level + 1} · ${rankName(info.level + 1)}", size = 13)
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
        // achievements: one tile per family, its tiers as dots, the next tier with its progress (nearest first)
        item {
            SectionTitle("Achievements · ${fams.sumOf { it.done }}/${ACHIEVEMENTS.size}")
            val sorted = fams.sortedWith(compareBy<FamilyProgress> { it.next == null }.thenByDescending { f -> f.next?.let { it.cur.toFloat() / it.target } ?: 0f })
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (pair in sorted.chunked(2)) Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (f in pair) FamilyTile(f, Modifier.weight(1f).fillMaxHeight())
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
        // the ladder
        item {
            SectionTitle("Ranks")
            Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(bottom = 16.dp)) {
                for (lv in 1..RANKS.size) {
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
private fun FamilyTile(f: FamilyProgress, modifier: Modifier) {
    val all = f.next == null
    Row(modifier.clip(RoundedCornerShape(10.dp)).background(if (all) C.gold.copy(alpha = 0.12f) else if (f.done > 0) C.gold.copy(alpha = 0.05f) else C.card)
        .border(1.dp, if (all) C.gold.copy(alpha = 0.45f) else if (f.done > 0) C.gold.copy(alpha = 0.25f) else C.line, RoundedCornerShape(10.dp)).padding(8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(30.dp).clip(CircleShape).background(if (all) C.gold else if (f.done > 0) C.gold.copy(alpha = 0.35f) else C.surface),
            contentAlignment = Alignment.Center) { QbIcon(f.fam.icon, if (all) C.ink else C.text, 16.dp) }
        HSpace(8.dp)
        Column(Modifier.weight(1f)) {
            Text(f.last?.title ?: f.fam.name, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = if (f.done > 0) C.text else C.muted,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(Modifier.padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                for (t in f.tiers) Box(Modifier.size(6.dp).clip(CircleShape).background(if (t.done) C.gold else Color(0x26FFFFFF)))
            }
            val n = f.next
            if (n != null) {
                Muted("Next: ${n.desc} · ${n.cur}/${n.target} · +${n.xp} XP", size = 11)
                Bar(n.cur.toFloat() / n.target, C.gold, Modifier.fillMaxWidth().padding(top = 3.dp), 3.dp)
            } else Muted("All ${f.tiers.size} tiers done", size = 11)
        }
    }
}

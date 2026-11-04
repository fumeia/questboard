package com.questboard.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.questboard.app.data.dueInDays
import com.questboard.app.data.str
import org.json.JSONObject

object C {
    val bg = Color(0xFF16161A)
    val surface = Color(0xFF1F1F25)
    val card = Color(0xFF26262E)
    val line = Color(0x1FFFFFFF)
    val text = Color(0xFFEEEEEE)
    val muted = Color(0x8CFFFFFF)
    val accent = Color(0xFF3584E4)
    val green = Color(0xFF2EC27E)
    val gold = Color(0xFFF8E45C)
    val orange = Color(0xFFFFA348)
    val red = Color(0xFFE5534B)
    fun quad(id: String) = when (id) {
        "q1" -> Color(0xFFE5534B); "q2" -> Color(0xFF3584E4); "q3" -> Color(0xFFE5A50A); else -> Color(0xFF9A9996)
    }
}

val QbColors = darkColorScheme(
    primary = C.accent, background = C.bg, surface = C.surface, surfaceVariant = C.card,
    onBackground = C.text, onSurface = C.text, secondary = C.green,
)

@Composable
fun QbTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = QbColors, content = content)

@Composable
fun QbIcon(name: String, tint: Color = C.text, size: Dp = 18.dp, modifier: Modifier = Modifier) {
    val res = QB_ICONS[name] ?: QB_ICONS.getValue("star")
    Icon(painterResource(res), contentDescription = name, tint = tint, modifier = modifier.size(size))
}

@Composable
fun IconBtn(name: String, onClick: () -> Unit, tint: Color = C.text, size: Dp = 20.dp) =
    IconButton(onClick = onClick, modifier = Modifier.size(40.dp)) { QbIcon(name, tint, size) }

@Composable
fun Muted(text: String, modifier: Modifier = Modifier, size: Int = 12) =
    Text(text, color = C.muted, fontSize = size.sp, modifier = modifier, maxLines = 2, overflow = TextOverflow.Ellipsis)

@Composable
fun Pill(text: String, bg: Color, fg: Color = C.text, onClick: (() -> Unit)? = null) {
    Box(Modifier.clip(RoundedCornerShape(50)).background(bg)
        .let { if (onClick != null) it.clickable(onClick = onClick) else it }
        .padding(horizontal = 10.dp, vertical = 5.dp)) {
        Text(text, color = fg, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun Bar(frac: Float, color: Color, modifier: Modifier = Modifier, height: Dp = 5.dp) {
    Box(modifier.height(height).clip(RoundedCornerShape(50)).background(Color(0x1FFFFFFF))) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(frac.coerceIn(0f, 1f)).clip(RoundedCornerShape(50)).background(color))
    }
}

@Composable
fun Check(done: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(24.dp).clip(RoundedCornerShape(7.dp))
            .background(if (done) C.green else Color.Transparent)
            .border(2.dp, if (done) C.green else Color(0x73FFFFFF), RoundedCornerShape(7.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { if (done) QbIcon("check", Color.White, 16.dp) }
}

@Composable
fun Dot(color: Color, size: Dp = 8.dp) = Box(Modifier.size(size).clip(CircleShape).background(color))

/** One quest line (used in matrix quadrants and the quest list). */
@Composable
fun QuestRow(q: JSONObject, timeLabel: String, running: Boolean, onOpen: () -> Unit, onCheck: () -> Unit, onPlay: () -> Unit,
             showDot: Boolean = false) {
    val done = q.optBoolean("done")
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onOpen).padding(vertical = 5.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Check(done, onCheck)
        if (showDot) Dot(C.quad(q.str("quadrant")))
        Text(q.str("title"), color = if (done) C.muted else C.text, fontSize = 14.sp, maxLines = 2,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (q.str("source") == "notion") QbIcon("book", C.muted, 12.dp)
        val dd = if (done) null else dueInDays(q)
        if (dd != null) {
            val (txt, col) = when {
                dd < 0 -> "${-dd}d late" to C.red
                dd == 0L -> "today" to C.red
                dd == 1L -> "tmrw" to C.orange
                dd <= 3 -> "${dd}d" to C.orange
                else -> "${dd}d" to C.muted
            }
            Text(txt, color = col, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
        if (timeLabel.isNotEmpty()) Muted(timeLabel, size = 11)
        if (!done) Box(Modifier.size(30.dp).clip(CircleShape).clickable(onClick = onPlay), contentAlignment = Alignment.Center) {
            QbIcon(if (running) "pause" else "play", if (running) C.green else C.muted, 16.dp)
        }
    }
}

@Composable
fun SectionTitle(text: String, color: Color = C.muted) =
    Text(text, color = color, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))

@Composable
fun HSpace(w: Dp) = Spacer(Modifier.width(w))

// ---- formatting ------------------------------------------------------------

fun fmtTimer(ms: Long): String {
    val total = (ms + 500) / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}

fun fmtSpent(ms: Long): String {
    val mins = ms / 60000
    if (mins <= 0) return if (ms >= 1000) "<1m" else ""
    val h = mins / 60
    return if (h > 0) "${h}h %02dm".format(mins % 60) else "${mins}m"
}

fun fmtMin(min: Int): String = "%02d:%02d".format((min / 60) % 24, min % 60)

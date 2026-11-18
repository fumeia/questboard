package com.questboard.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.WindowInsets
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.ui.text.style.TextOverflow
import com.questboard.app.data.DAILY_XP
import com.questboard.app.data.dateKey
import com.questboard.app.data.levelInfo
import com.questboard.app.data.rankName
import com.questboard.app.data.str
import com.questboard.app.ui.LevelScreen
import com.questboard.app.ui.LevelRing
import com.questboard.app.ui.UiBus
import com.questboard.app.ui.Bar
import com.questboard.app.ui.C
import com.questboard.app.ui.CalendarScreen
import com.questboard.app.ui.HSpace
import com.questboard.app.ui.HabitsScreen
import com.questboard.app.ui.IconBtn
import com.questboard.app.ui.MatrixScreen
import com.questboard.app.ui.Muted
import com.questboard.app.ui.QbIcon
import com.questboard.app.ui.QbTheme
import com.questboard.app.ui.SettingsScreen
import com.questboard.app.ui.ShopScreen
import com.questboard.app.ui.ProgressScreen
import com.questboard.app.sys.writeFocusEvent
import com.questboard.app.ui.TimersScreen
import com.questboard.app.ui.fmtSpent
import com.questboard.app.ui.fmtTimer
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val app get() = application as QuestboardApp
    private var tab = mutableStateOf("matrix")
    /** Bumped when calendar permission changes so the calendar re-queries. */
    val permVersion = mutableStateOf(0)

    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        permVersion.value++
        app.log.info("perm", "permissions: ${it.filterValues { v -> v }.keys.joinToString { k -> k.substringAfterLast('.') }}")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge() // draw behind the status bar; the header fills it (no grey strip)
        intent?.getStringExtra("tab")?.let { tab.value = it }
        handleSetupLink(intent)
        val perms = mutableListOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        permLauncher.launch(perms.toTypedArray())
        setContent { QbTheme { Root() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra("tab")?.let { tab.value = it }
        handleSetupLink(intent)
    }

    /** questboard://setup?url=…&token=… configures the server in one tap. */
    private fun handleSetupLink(i: Intent?) {
        val uri = i?.data ?: return
        if (uri.scheme != "questboard" || uri.host != "setup") return
        val url = uri.getQueryParameter("url").orEmpty()
        val token = uri.getQueryParameter("token").orEmpty()
        if (url.isEmpty() || token.isEmpty()) return
        app.settings.serverUrl = url
        app.settings.token = token
        app.settings.syncEnabled = true
        app.log.info("setup", "configured from setup link (${android.net.Uri.parse(url).host})")
        tab.value = "settings"
        lifecycleScope.launch { app.sync.syncNow("manual") }
    }

    /** Lernplan calendar events -> calendar quests linked to the course goals (see sys/Lernplan.kt). */
    private fun lernplan() {
        runCatching { com.questboard.app.sys.Lernplan.sync(app.calendar, app.store) }
            .onSuccess { if (it > 0) app.log.info("lernplan", "$it calendar quests updated") }
            .onFailure { app.log.exception("lernplan", it) }
    }

    /** Pay the daily target and achievements, and say so (every 30 s while open, and on resume). */
    private fun rewards() {
        val st = app.settings
        val r = runCatching {
            app.store.checkRewards(st.dailyTargetMin, st.achSeen?.split(',')?.filter { it.isNotEmpty() }?.toSet(), st.lastLevel)
        }.onFailure { app.log.exception("rewards", it) }.getOrNull() ?: return
        st.achSeen = r.seen.joinToString(","); st.lastLevel = r.level
        r.levelUp?.let { (_, to) -> app.notifier.alert(9101, "Level up · Lv $to", "You are now a ${rankName(to)}. Tap the level badge to see what comes next.", "level") }
        if (r.daily) app.notifier.alert(9102, "Daily focus target reached · +$DAILY_XP XP", "That counts for the streak too. Anything more today is a bonus.", "level")
        if (r.unlocked.isNotEmpty()) {
            // many at once (first run, or new tiers after an update): one summary instead of a pile of notifications
            if (r.first || r.unlocked.size > 3) app.notifier.alert(9103, "${r.unlocked.size} achievements for what you already did · +${r.unlocked.sumOf { it.xp }} XP",
                r.unlocked.joinToString(" · ") { it.title }, "level")
            else for (a in r.unlocked) app.notifier.alert(9200 + a.id.hashCode() % 500, "Achievement: ${a.title} · +${a.xp} XP", a.desc, "level")
        }
    }

    override fun onResume() {
        super.onResume()
        lifecycleScope.launch {
            app.store.tick()
            rewards()
            lernplan()
            app.alarms.refresh(app)
            app.sync.syncNow("open")
            lernplan()  // again: goals may only just have arrived from the server
            if (app.settings.autoUpdate) app.updater.check(manual = false)
        }
    }

    @Composable
    private fun Root() {
        val v by app.store.version.collectAsState()
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        val running = remember(v) { app.store.runningTimers().isNotEmpty() }
        LaunchedEffect(running) {
            while (running) {
                now = System.currentTimeMillis()
                app.store.tick(now).forEach { t ->
                    writeFocusEvent(app, t)
                    app.notifier.alert(t.id.hashCode(), if (t.kind == "pomodoro") "Pomodoro complete · +10 XP" else "Timer finished", t.label)
                }
                delay(1000)
            }
        }
        LaunchedEffect(Unit) { while (true) { delay(30_000); rewards() } }
        // "Deleted … · Undo" from any screen
        val snack = remember { SnackbarHostState() }
        val undo = UiBus.undo.value
        LaunchedEffect(undo) {
            if (undo == null) return@LaunchedEffect
            val res = snack.showSnackbar(undo.first, actionLabel = "Undo", withDismissAction = true, duration = SnackbarDuration.Short)
            if (res == SnackbarResult.ActionPerformed) undo.second()
            if (UiBus.undo.value === undo) UiBus.undo.value = null
        }
        Scaffold(
            containerColor = C.bg,
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            bottomBar = { if (tab.value != "settings") BottomNav() },
            snackbarHost = { SnackbarHost(snack) },
        ) { pad ->
            Column(Modifier.fillMaxSize().padding(pad)) {
                Header(v, now)
                Deadlines(v, now)
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (tab.value) {
                        "matrix" -> MatrixScreen(app, v, now)
                        "habits" -> HabitsScreen(app, v)
                        "calendar" -> CalendarScreen(app, v, permVersion.value, now)
                        "timers" -> TimersScreen(app, v, now)
                        "shop" -> ShopScreen(app, v)
                        "settings" -> SettingsScreen(app) { tab.value = "matrix" }
                        "progress", "stats" -> ProgressScreen(app, v, now)
                        "level" -> LevelScreen(app, v, now) { tab.value = "matrix" }
                    }
                }
            }
        }
    }

    @Composable
    private fun Header(v: Int, now: Long) {
        val s = app.store
        val info = remember(v) { levelInfo(s.xp) }
        val sync by app.sync.status.collectAsState()
        Row(Modifier.fillMaxWidth().background(C.surface).statusBarsPadding().padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically) {
          // Stats take what's left and scroll sideways on narrow phones; the timer chip,
          // sync and settings icons on the right always stay visible.
          Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            // the badge explains itself: a tap opens the Level screen (ranks, where XP comes from, achievements)
            Row(Modifier.clip(RoundedCornerShape(8.dp)).clickable { tab.value = "level" }, verticalAlignment = Alignment.CenterVertically) {
                // the level in a ring that fills toward the next level; the numbers are on the Level screen
                LevelRing(info.level, info.frac)
                HSpace(6.dp)
                Text(rankName(info.level), color = C.muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 110.dp))
            }
            HSpace(10.dp)
            Row(Modifier.clickable { tab.value = "shop" }, verticalAlignment = Alignment.CenterVertically) {
                QbIcon("coin", C.gold, 15.dp); HSpace(3.dp)
                Text("${s.balance}", color = C.gold, fontWeight = FontWeight.Bold, fontSize = 13.sp)
            }
            val streak = remember(v) { s.streak() }
            if (streak > 0) {
                HSpace(10.dp); QbIcon("flame", C.orange, 15.dp); HSpace(2.dp)
                Text("${streak}d", color = C.orange, fontWeight = FontWeight.Bold, fontSize = 13.sp)
            }
            // focus today, nothing else (target and details are on the Level screen); green once the daily target is reached
            val focus = fmtSpent(s.focusOn(now = now)).ifEmpty { "0m" }
            val hit = remember(v) { s.dailyHit() }
            HSpace(10.dp); QbIcon("stopwatch", if (hit) C.green else C.muted, 14.dp); HSpace(3.dp)
            Text(focus, color = if (hit) C.green else C.text, fontWeight = FontWeight.Bold, fontSize = 13.sp, maxLines = 1, softWrap = false)
            HSpace(6.dp)
          }
            val t = s.runningTimers().firstOrNull()
            if (t != null) {
                HSpace(4.dp)
                Box(Modifier.clip(RoundedCornerShape(50)).background(C.green.copy(alpha = 0.22f)).clickable { tab.value = "timers" }
                    .padding(horizontal = 8.dp, vertical = 3.dp)) {
                    Text(fmtTimer(if (t.mode == "countdown") s.timerRemaining(t, now) else s.timerElapsed(t, now)),
                        color = C.green, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                }
            }
            val off = !app.settings.syncEnabled || !app.settings.configured
            IconBtn(if (off || sync.state == "error") "cloud-off" else "cloud", { lifecycleScope.launch { app.sync.syncNow("manual") } },
                tint = when { off -> C.muted; sync.state == "error" -> C.red; sync.state == "syncing" -> C.accent; else -> C.text }, size = 18.dp)
            IconBtn("bug", { tab.value = "settings" }, tint = C.muted, size = 18.dp)
        }
    }

    /** Goals with a date (exams): days left, red when behind pace. A tap opens the goal on the Progress tab. */
    @Composable
    private fun Deadlines(v: Int, now: Long) {
        val s = app.store
        val today = dateKey()
        val goals = remember(v) { s.goals().filter { !it.optBoolean("done") && it.str("targetDate").isNotEmpty() && it.str("targetDate") >= today }
            .sortedBy { it.str("targetDate") } }
        if (goals.isEmpty()) return
        LazyRow(Modifier.fillMaxWidth().background(C.surface).padding(start = 10.dp, end = 10.dp, bottom = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            item { QbIcon("target", C.muted, 14.dp) }
            items(goals, key = { it.str("id") }) { g ->
                val pace = s.goalPace(g.str("id"), now)
                val days = pace?.daysLeft ?: 0L
                val bg = when { pace != null && !pace.onTrack -> C.red.copy(alpha = 0.4f); days <= 7 -> C.orange.copy(alpha = 0.3f); else -> C.card }
                Row(Modifier.clip(RoundedCornerShape(50)).background(bg).clickable { UiBus.openGoal.value = g.str("id"); tab.value = "progress" }
                    .padding(horizontal = 10.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(g.str("title"), fontSize = 12.sp, color = C.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 120.dp))
                    HSpace(6.dp)
                    Text(if (days == 0L) "today" else "${days}d", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = C.text)
                }
            }
        }
    }

    @Composable
    private fun BottomNav() {
        NavigationBar(containerColor = C.surface, tonalElevation = 0.dp) {
            for ((id, icon, label) in listOf(
                Triple("matrix", "grid", "Matrix"), Triple("habits", "repeat", "Habits"), Triple("calendar", "list", "Calendar"),
                Triple("timers", "stopwatch", "Timers"), Triple("shop", "shop", "Shop"), Triple("progress", "trophy", "Progress"),
            )) {
                NavigationBarItem(
                    selected = tab.value == id, onClick = { tab.value = id },
                    icon = { QbIcon(icon, if (tab.value == id) C.text else C.muted, 20.dp) },
                    label = { Text(label, fontSize = 11.sp) },
                    colors = NavigationBarItemDefaults.colors(indicatorColor = C.accent.copy(alpha = 0.35f),
                        selectedTextColor = C.text, unselectedTextColor = C.muted),
                )
            }
        }
    }
}

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
import com.questboard.app.data.levelInfo
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

    override fun onResume() {
        super.onResume()
        lifecycleScope.launch {
            app.store.tick()
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
        Scaffold(
            containerColor = C.bg,
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            bottomBar = { if (tab.value != "settings") BottomNav() },
        ) { pad ->
            Column(Modifier.fillMaxSize().padding(pad)) {
                Header(v, now)
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (tab.value) {
                        "matrix" -> MatrixScreen(app, v, now)
                        "habits" -> HabitsScreen(app, v)
                        "calendar" -> CalendarScreen(app, v, permVersion.value, now)
                        "timers" -> TimersScreen(app, v, now)
                        "shop" -> ShopScreen(app, v)
                        "settings" -> SettingsScreen(app) { tab.value = "matrix" }
                        "progress", "stats" -> ProgressScreen(app, v, now)
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
            Box(Modifier.clip(RoundedCornerShape(50)).background(C.accent).clickable { tab.value = "progress" }.padding(horizontal = 10.dp, vertical = 3.dp)) {
                Text("Lv ${info.level}", fontWeight = FontWeight.ExtraBold, fontSize = 13.sp, color = C.text)
            }
            HSpace(8.dp)
            Column(Modifier.width(76.dp)) {
                Bar(info.frac, C.gold)
                Muted("${info.into}/${info.span} XP", size = 10)
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
            HSpace(10.dp); QbIcon("check", C.muted, 14.dp); HSpace(2.dp); Muted("${s.completedOn()}", size = 13)
            val focus = fmtSpent(s.focusOn(now = now))
            if (focus.isNotEmpty()) { HSpace(8.dp); QbIcon("stopwatch", C.muted, 14.dp); HSpace(2.dp); Muted(focus, size = 13) }
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

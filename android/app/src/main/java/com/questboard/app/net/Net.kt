package com.questboard.app.net

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.questboard.app.BuildConfig
import com.questboard.app.QuestboardApp
import com.questboard.app.data.Store
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

// ------------------------------------------------------------------ settings

class Settings(context: Context) {
    private val p = context.getSharedPreferences("questboard", Context.MODE_PRIVATE)
    var serverUrl: String get() = p.getString("serverUrl", "")!!; set(v) = p.edit().putString("serverUrl", v.trim().trimEnd('/')).apply()
    var token: String get() = p.getString("token", "")!!; set(v) = p.edit().putString("token", v.trim()).apply()
    var deviceName: String get() = p.getString("deviceName", Build.MODEL)!!; set(v) = p.edit().putString("deviceName", v).apply()
    var syncEnabled: Boolean get() = p.getBoolean("sync", true); set(v) = p.edit().putBoolean("sync", v).apply()
    var remoteLogs: Boolean get() = p.getBoolean("remoteLogs", true); set(v) = p.edit().putBoolean("remoteLogs", v).apply()
    var autoUpdate: Boolean get() = p.getBoolean("autoUpdate", true); set(v) = p.edit().putBoolean("autoUpdate", v).apply()
    var pomodoroMin: Int get() = p.getInt("pomodoro", 25); set(v) = p.edit().putInt("pomodoro", v).apply()
    var breakMin: Int get() = p.getInt("break", 5); set(v) = p.edit().putInt("break", v).apply()
    var dayStartHour: Int get() = p.getInt("dayStart", 8); set(v) = p.edit().putInt("dayStart", v).apply()
    var reminders: Boolean get() = p.getBoolean("reminders", true); set(v) = p.edit().putBoolean("reminders", v).apply()
    var calendarId: Long get() = p.getLong("calendarId", -1); set(v) = p.edit().putLong("calendarId", v).apply()
    var focusToCalendar: Boolean get() = p.getBoolean("focusToCal", false); set(v) = p.edit().putBoolean("focusToCal", v).apply()
    val configured get() = serverUrl.isNotEmpty() && token.isNotEmpty()
}

// ----------------------------------------------------------------------- HTTP

class Api(private val settings: Settings) {
    class HttpError(val code: Int, msg: String) : Exception(msg)

    fun request(method: String, path: String, json: JSONObject? = null, timeoutMs: Int = 20_000): ByteArray {
        if (!settings.configured) throw IllegalStateException("server not configured")
        val c = URL(settings.serverUrl + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.setRequestProperty("Authorization", "Bearer ${settings.token}")
            if (json != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(json.toString().toByteArray()) }
            }
            val code = c.responseCode
            val body = (if (code in 200..299) c.inputStream else c.errorStream)?.use { it.readBytes() } ?: ByteArray(0)
            if (code !in 200..299) {
                val detail = runCatching { JSONObject(String(body)).optString("error") }.getOrDefault("")
                throw HttpError(code, "HTTP $code${if (detail.isNotEmpty()) ": $detail" else ""} ($path)")
            }
            return body
        } finally {
            c.disconnect()
        }
    }

    fun json(method: String, path: String, body: JSONObject? = null) = JSONObject(String(request(method, path, body)).ifEmpty { "{}" })
}

// --------------------------------------------------------------------- Logger

class Logger(context: Context, private val settings: Settings) {
    data class Entry(val ts: Long, val level: String, val tag: String, val msg: String, val ctx: String?)

    private val file = File(context.filesDir, "questboard.log")
    private val crashFile = File(context.filesDir, "last-crash.txt")
    private val ring = ArrayDeque<Entry>()
    private val remote = ArrayDeque<Entry>()
    var deviceId = ""

    val recent: List<Entry> @Synchronized get() = ring.toList()

    @Synchronized
    fun log(level: String, tag: String, msg: String, ctx: JSONObject? = null) {
        val e = Entry(System.currentTimeMillis(), level, tag, msg, ctx?.toString())
        ring.addLast(e); if (ring.size > 400) ring.removeFirst()
        android.util.Log.println(when (level) { "error" -> 6; "warn" -> 5; "debug" -> 3; else -> 4 }, "Questboard", "[$tag] $msg ${e.ctx ?: ""}")
        runCatching {
            if (file.length() > 1_000_000) file.renameTo(File(file.parentFile, "questboard.log.1"))
            file.appendText("${java.time.Instant.ofEpochMilli(e.ts)} ${level.uppercase()} [$tag] $msg ${e.ctx ?: ""}\n")
        }
        if (settings.remoteLogs && level != "debug") { remote.addLast(e); if (remote.size > 1000) remote.removeFirst() }
    }

    fun info(tag: String, msg: String, ctx: JSONObject? = null) = log("info", tag, msg, ctx)
    fun warn(tag: String, msg: String, ctx: JSONObject? = null) = log("warn", tag, msg, ctx)
    fun error(tag: String, msg: String, ctx: JSONObject? = null) = log("error", tag, msg, ctx)
    fun exception(tag: String, t: Throwable) = error(tag, "${t.javaClass.simpleName}: ${t.message}",
        JSONObject().put("stack", t.stackTraceToString().lines().take(12).joinToString("\n")))

    /** Crashes are written synchronously and shipped on the next start. */
    fun installCrashHandler() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { th, ex ->
            runCatching { crashFile.writeText("${System.currentTimeMillis()}\n${th.name}\n${ex.stackTraceToString()}") }
            prev?.uncaughtException(th, ex)
        }
        if (crashFile.exists()) {
            val text = crashFile.readText()
            crashFile.delete()
            error("crash", "app crashed last run", JSONObject().put("trace", text.take(6000)))
        }
    }

    fun flush(api: Api) {
        if (!settings.configured) return
        val batch = synchronized(this) { val b = remote.toList(); remote.clear(); b }
        if (batch.isEmpty()) return
        try {
            api.json("POST", "/api/logs", JSONObject().put("device", deviceId).put("platform", "android")
                .put("version", BuildConfig.VERSION_NAME).put("name", settings.deviceName)
                .put("entries", JSONArray(batch.map { JSONObject().put("ts", it.ts).put("level", it.level).put("tag", it.tag)
                    .put("msg", it.msg).put("ctx", it.ctx?.let { c -> runCatching { JSONObject(c) }.getOrNull() } ?: JSONObject.NULL) })))
        } catch (e: Exception) {
            synchronized(this) { batch.reversed().forEach { remote.addFirst(it) } }
        }
    }
}

// ----------------------------------------------------------------------- Sync

class SyncManager(private val app: QuestboardApp) {
    data class Status(val state: String = "idle", val at: Long = 0, val error: String? = null)

    private val mutex = Mutex()
    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status

    suspend fun syncNow(reason: String): Boolean = mutex.withLock {
        val s = app.settings
        if (!s.syncEnabled || !s.configured) { _status.value = Status("off"); return false }
        _status.value = _status.value.copy(state = "syncing")
        val t0 = System.currentTimeMillis()
        return try {
            var pushed = 0
            var merged = 0
            var rounds = 0
            var more = true
            while (more && rounds++ < 20) {
                val (changes, marks) = withContext(Dispatchers.Main) { app.store.collectDirty() }
                val body = JSONObject().put("device", app.store.deviceId).put("platform", "android")
                    .put("version", BuildConfig.VERSION_NAME).put("name", s.deviceName)
                    .put("since", app.store.cursor).put("changes", changes)
                val res = withContext(Dispatchers.IO) { app.api.json("POST", "/api/sync", body) }
                pushed += changes.length()
                merged += withContext(Dispatchers.Main) {
                    app.store.applyRemote(res.optJSONArray("changes") ?: JSONArray(), res.optLong("cursor"), marks)
                }
                more = res.optBoolean("more")
            }
            _status.value = Status("ok", System.currentTimeMillis())
            if (pushed > 0 || merged > 0 || reason == "manual")
                app.log.info("sync", "$reason: pushed $pushed, merged $merged in ${System.currentTimeMillis() - t0} ms")
            withContext(Dispatchers.IO) { app.log.flush(app.api) }
            true
        } catch (e: Exception) {
            _status.value = Status("error", error = e.message)
            app.log.warn("sync", "$reason failed: ${e.message}")
            false
        }
    }

    /** Debounced background push after local edits (survives the app being closed). */
    fun schedule(context: Context) {
        val req = OneTimeWorkRequestBuilder<SyncWorker>()
            .setInitialDelay(3, TimeUnit.SECONDS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("qb-sync-now", ExistingWorkPolicy.REPLACE, req)
    }

    fun schedulePeriodic(context: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("qb-sync", ExistingPeriodicWorkPolicy.KEEP, req)
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as QuestboardApp
        app.sync.syncNow("background")
        if (app.settings.autoUpdate) runCatching { app.updater.check(manual = false) }
        return Result.success()
    }
}

// -------------------------------------------------------------------- Updater

class Updater(private val app: QuestboardApp) {
    data class State(val message: String? = null, val available: JSONObject? = null, val busy: Boolean = false)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    private var lastCheck = 0L

    /** Checks the server for a newer APK. Downloads + opens the installer when [install] is true. */
    suspend fun check(manual: Boolean, install: Boolean = false): Unit = withContext(Dispatchers.IO) {
        if (!app.settings.configured) return@withContext
        if (!manual && System.currentTimeMillis() - lastCheck < 30 * 60_000) return@withContext
        lastCheck = System.currentTimeMillis()
        try {
            val rel = app.api.json("GET", "/api/releases/android/latest")
            if (rel.optInt("code") <= BuildConfig.VERSION_CODE) {
                _state.value = State(if (manual) "Up to date (${BuildConfig.VERSION_NAME})" else null)
                return@withContext
            }
            _state.value = State("Version ${rel.optString("name")} available", rel)
            if (!install) {
                app.notifier.updateAvailable(rel.optString("name"), rel.optString("notes"))
                return@withContext
            }
            _state.value = _state.value.copy(busy = true, message = "Downloading ${rel.optString("name")}…")
            val bytes = app.api.request("GET", "/api/releases/android/download", timeoutMs = 120_000)
            val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            if (sha != rel.optString("sha256")) throw IllegalStateException("checksum mismatch")
            app.log.info("update", "installing ${rel.optString("name")} (${bytes.size / 1024} KiB)")
            installApk(bytes)
            _state.value = State("Confirm the install prompt", rel)
        } catch (e: Exception) {
            if (e is Api.HttpError && e.code == 404) {
                _state.value = State(if (manual) "No release published yet" else null)
            } else {
                app.log.warn("update", "check failed: ${e.message}")
                _state.value = State("Update failed: ${e.message}")
            }
        }
    }

    private fun installApk(bytes: ByteArray) {
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("questboard.apk", 0, bytes.size.toLong()).use { it.write(bytes); session.fsync(it) }
            val intent = Intent(app, InstallReceiver::class.java)
            val pi = android.app.PendingIntent.getBroadcast(app, id, intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_MUTABLE)
            session.commit(pi.intentSender)
        }
    }
}

/** Receives PackageInstaller results; launches the confirmation UI when needed. */
class InstallReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as QuestboardApp
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(confirm)
            }
            PackageInstaller.STATUS_SUCCESS -> app.log.info("update", "installed")
            else -> app.log.warn("update", "install status $status: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
        }
    }
}

package com.questboard.app

import android.app.Application
import com.questboard.app.data.Store
import com.questboard.app.net.Api
import com.questboard.app.net.Logger
import com.questboard.app.net.Settings
import com.questboard.app.net.SyncManager
import com.questboard.app.net.Updater
import com.questboard.app.sys.Alarms
import com.questboard.app.sys.CalendarRepo
import com.questboard.app.sys.Notifier

/** Single place that owns all long-lived objects (no DI framework, keeps the APK small). */
class QuestboardApp : Application() {
    lateinit var settings: Settings
    lateinit var log: Logger
    lateinit var api: Api
    lateinit var store: Store
    lateinit var sync: SyncManager
    lateinit var updater: Updater
    lateinit var notifier: Notifier
    lateinit var alarms: Alarms
    lateinit var calendar: CalendarRepo

    override fun onCreate() {
        super.onCreate()
        val t0 = System.currentTimeMillis()
        settings = Settings(this)
        log = Logger(this, settings)
        log.installCrashHandler()
        api = Api(settings)
        store = Store(this) { level, msg -> log.log(level, "store", msg) }
        log.deviceId = store.deviceId
        notifier = Notifier(this)
        alarms = Alarms(this)
        calendar = CalendarRepo(this)
        sync = SyncManager(this)
        updater = Updater(this)
        store.onLocalChange = {
            alarms.refresh(this)
            sync.schedule(this)
        }
        sync.schedulePeriodic(this)
        alarms.refresh(this)
        log.info("lifecycle", "app start v${BuildConfig.VERSION_NAME} in ${System.currentTimeMillis() - t0} ms")
    }
}

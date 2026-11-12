package com.hci.one.adb;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

/** Runs forever: checks the ADB port every 30 s and turns network ADB back on when it closes. */
public class KeeperService extends Service {
    static final String ACTION_FIX = "com.hci.one.adb.FIX";
    static final String ACTION_STATE = "com.hci.one.adb.STATE";
    static final int NOTE_ID = 1;
    static final long LOOP_MS = 30000, FIX_GAP_MS = 20000, BACKOFF_MS = 5 * 60000;

    private HandlerThread thread;
    private Handler loop;
    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wake;
    private int failsInRow = 0;
    private long lastFixAt = 0;

    static void start(Context c) {
        Intent i = new Intent(c, KeeperService.class);
        try {
            // startForegroundService is API 26; the build targets the API 23 jar, so call it by name
            if (Build.VERSION.SDK_INT >= 26) Context.class.getMethod("startForegroundService", Intent.class).invoke(c, i);
            else c.startService(i);
        } catch (Exception ignored) { }
    }

    private final BroadcastReceiver netReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { if (loop != null) { loop.removeCallbacks(tick); loop.postDelayed(tick, 3000); } }
    };

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            runCheck(false);
            loop.removeCallbacks(this);
            loop.postDelayed(this, LOOP_MS);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        startForeground(NOTE_ID, note("Starting the watchdog", "Checking network ADB"));
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) { wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "hci-adb-keeper"); wifiLock.setReferenceCounted(false); wifiLock.acquire(); }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) { wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hci-adb-keeper:check"); wake.setReferenceCounted(false); }
        thread = new HandlerThread("adb-keeper");
        thread.start();
        loop = new Handler(thread.getLooper());
        IntentFilter f = new IntentFilter();
        f.addAction("android.net.conn.CONNECTIVITY_CHANGE");
        f.addAction("android.net.wifi.STATE_CHANGE");
        registerReceiver(netReceiver, f);
        scheduleRevive(this);
        Keeper.prefs(this).edit().putLong("onSince", System.currentTimeMillis()).apply();
        loop.post(tick);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_FIX.equals(intent.getAction()) && loop != null) {
            loop.post(new Runnable() { public void run() { runCheck(true); } });
        }
        return START_STICKY;
    }

    private void runCheck(boolean now) {
        if (wake != null) wake.acquire(60000);
        try {
            int port = Keeper.port(this);
            boolean fix = now || (System.currentTimeMillis() - lastFixAt > (failsInRow >= 3 ? BACKOFF_MS : FIX_GAP_MS));
            Keeper.Result r = Keeper.check(this, fix);
            if (fix && !r.listening) { lastFixAt = System.currentTimeMillis(); failsInRow++; }
            if (r.listening) failsInRow = 0;
            long t = System.currentTimeMillis();
            android.content.SharedPreferences.Editor e = Keeper.prefs(this).edit()
                .putLong("lastCheck", t).putString("lastText", r.text).putBoolean("listening", r.listening);
            if (r.fixed) e.putInt("fixes", Keeper.prefs(this).getInt("fixes", 0) + 1).putLong("lastFixAt", t);
            if (r.noRoot) e.putBoolean("noroot", true); else if (r.fixed) e.putBoolean("noroot", false);
            e.apply();
            String what = port == Keeper.CAMERA_PORT ? "camera port " + port : "port " + port;
            if (r.listening) {
                String a = Keeper.address();
                updateNote("Network ADB on " + what, a.isEmpty() ? "Not on a network" : "adb connect " + a + ":" + port);
            } else updateNote(r.noRoot ? "Network ADB needs root" : "Network ADB is off", r.text);
            sendBroadcast(new Intent(ACTION_STATE).setPackage(getPackageName()));
        } finally {
            if (wake != null && wake.isHeld()) wake.release();
        }
    }

    private Notification note(String title, String text) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Notification.Builder b = new Notification.Builder(this)
            .setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text)
            .setOngoing(true).setShowWhen(false).setContentIntent(pi).setPriority(Notification.PRIORITY_MIN);
        return b.build();
    }

    private void updateNote(String title, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTE_ID, note(title, text));
    }

    /** An alarm every 15 minutes brings the service back if anything ever kills it. */
    static void scheduleRevive(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = PendingIntent.getBroadcast(c, 0, new Intent(c, AlarmReceiver.class), Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_FIFTEEN_MINUTES, AlarmManager.INTERVAL_FIFTEEN_MINUTES, pi);
    }

    @Override public void onTaskRemoved(Intent rootIntent) { start(getApplicationContext()); }

    @Override public void onDestroy() {
        try { unregisterReceiver(netReceiver); } catch (Exception ignored) { }
        if (loop != null) loop.removeCallbacksAndMessages(null);
        if (thread != null) thread.quit();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}

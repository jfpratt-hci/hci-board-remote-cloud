package com.hci.one.adb;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** One status screen: is network ADB on, on which port, and how to reach this device.
 *  Board Remote opens it once after install with  --ei port 5555  or  --ei port 65037 (cameras). */
public class MainActivity extends Activity {
    static final int INK = 0xFF1E1C19, MUTED = 0xFF7A766F, LINE = 0xFFE4E0D8, BG = 0xFFF6F4F0;
    static final int GREEN_BG = 0xFFE3F1E6, AMBER_BG = 0xFFFBF0D9, RED_BG = 0xFFF8E1DE, BLUE_BG = 0xFFE2ECF7;

    private LinearLayout rows;
    private TextView state, detail;
    private LinearLayout card;

    private final BroadcastReceiver onState = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { refresh(); }
    };

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        takePort(getIntent());
        KeeperService.start(this);

        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.setBackgroundColor(BG);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(28), dp(24), dp(28), dp(24));
        sv.addView(col);

        TextView kicker = text("HCI ONE", 12, MUTED, true);
        if (Build.VERSION.SDK_INT >= 21) kicker.setLetterSpacing(0.12f);
        col.addView(kicker);
        col.addView(text("Network ADB", 26, INK, true));

        card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(20), dp(16), dp(20), dp(16));
        state = text("Checking", 20, INK, true);
        detail = text("", 14, INK, false);
        card.addView(state); card.addView(detail);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cp.setMargins(0, dp(16), 0, dp(16));
        col.addView(card, cp);

        rows = new LinearLayout(this);
        rows.setOrientation(LinearLayout.VERTICAL);
        col.addView(rows);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.addView(button("Check now", new View.OnClickListener() {
            public void onClick(View v) { startService(new Intent(MainActivity.this, KeeperService.class).setAction(KeeperService.ACTION_FIX)); state.setText("Checking"); }
        }), margins(0, 0, dp(12), 0));
        buttons.addView(button("Developer options", new View.OnClickListener() {
            public void onClick(View v) {
                try { startActivity(new Intent("android.settings.APPLICATION_DEVELOPMENT_SETTINGS")); }
                catch (Exception e) { try { startActivity(new Intent("android.settings.SETTINGS")); } catch (Exception ignored) { } }
            }
        }));
        col.addView(buttons, margins(0, dp(20), 0, 0));
        col.addView(text("The first time, tap Allow on this screen and tick Always allow.", 13, MUTED, false), margins(0, dp(16), 0, 0));
        setContentView(sv);
    }

    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); takePort(i); refresh(); }

    /** am start -n com.hci.one.adb/.MainActivity --ei port 65037 */
    private void takePort(Intent i) {
        if (i == null || !i.hasExtra("port")) return;
        int p = i.getIntExtra("port", 0);
        if (!Keeper.allowed(p)) return;
        Keeper.setPort(this, p);
        startService(new Intent(this, KeeperService.class).setAction(KeeperService.ACTION_FIX));
    }

    @Override protected void onResume() {
        super.onResume();
        registerReceiver(onState, new IntentFilter(KeeperService.ACTION_STATE));
        refresh();
    }

    @Override protected void onPause() {
        try { unregisterReceiver(onState); } catch (Exception ignored) { }
        super.onPause();
    }

    private void refresh() {
        SharedPreferences p = Keeper.prefs(this);
        final int port = p.getInt("port", Keeper.BOARD_PORT);
        long last = p.getLong("lastCheck", 0);
        boolean on = p.getBoolean("listening", false), noRoot = p.getBoolean("noroot", false);
        final String addr = Keeper.address();
        String portText = port == Keeper.CAMERA_PORT ? port + " (camera)" : String.valueOf(port);
        int bg;
        if (last == 0) { state.setText("Starting"); detail.setText("Checking network ADB"); bg = BLUE_BG; }
        else if (on) { state.setText("On and kept on"); detail.setText(addr.isEmpty() ? "Connect this device to the network to reach it over ADB." : "From a PC on the same network:  adb connect " + addr + ":" + port); bg = GREEN_BG; }
        else if (noRoot) { state.setText("Needs root access"); detail.setText(p.getString("lastText", "")); bg = AMBER_BG; }
        else { state.setText("Network ADB is off"); detail.setText(p.getString("lastText", "Turning on")); bg = RED_BG; }
        GradientDrawable g = new GradientDrawable();
        g.setColor(bg); g.setCornerRadius(dp(10));
        card.setBackground(g);

        rows.removeAllViews();
        row("Port", portText);
        row("Address", addr.isEmpty() ? "No network" : addr);
        row("Last check", last == 0 ? "Nothing yet" : ago(last));
        row("Repairs", p.getInt("fixes", 0) + " since this app started");
        row("Root keeper", noRoot ? "No root" : "Ready");
        row("Device", Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        row("Version", version());
    }

    private String version() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
    }

    private static String ago(long t) {
        long s = (System.currentTimeMillis() - t) / 1000;
        if (s < 10) return "just now";
        if (s < 60) return s + " seconds ago";
        if (s < 3600) return (s / 60) + " min ago";
        if (s < 86400) return (s / 3600) + " hr ago";
        return (s / 86400) + " days ago";
    }

    private void row(String label, String value) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setPadding(0, dp(10), 0, dp(10));
        TextView l = text(label, 14, MUTED, false);
        TextView v = text(value, 14, INK, false);
        v.setTypeface(Typeface.MONOSPACE);
        r.addView(l, new LinearLayout.LayoutParams(dp(130), LinearLayout.LayoutParams.WRAP_CONTENT));
        r.addView(v, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        rows.addView(r);
        View line = new View(this);
        line.setBackgroundColor(LINE);
        rows.addView(line, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1));
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); t.setTextColor(color);
        t.setTypeface(Typeface.create("sans-serif", bold ? Typeface.BOLD : Typeface.NORMAL));
        return t;
    }

    private Button button(String s, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(s); b.setAllCaps(false); b.setTextColor(Color.WHITE);
        GradientDrawable g = new GradientDrawable();
        g.setColor(INK); g.setCornerRadius(dp(8));
        b.setBackground(g); b.setPadding(dp(18), dp(10), dp(18), dp(10));
        b.setOnClickListener(l); b.setFocusable(true);
        return b;
    }

    private LinearLayout.LayoutParams margins(int l, int t, int r, int bt) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.setMargins(l, t, r, bt);
        return p;
    }

    private int dp(int v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics())); }
}

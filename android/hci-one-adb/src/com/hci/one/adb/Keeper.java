package com.hci.one.adb;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.Collections;

/** Keeps network ADB listening on one port.
 *  Boards and TVs use 5555. HCI ONE cameras only work on 65037.
 *  The port is chosen once and saved: Board Remote sets it when it installs the keeper
 *  (am start ... --ei port 65037); otherwise the keeper keeps whichever ADB port is
 *  already open, 5555 first, then 65037, then the port in persist.adb.tcp.port. */
final class Keeper {
    static final int BOARD_PORT = 5555, CAMERA_PORT = 65037;
    static final String PREFS = "keeper";

    static boolean allowed(int port) { return port == BOARD_PORT || port == CAMERA_PORT; }

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    /** The port this device keeps open. Decided once, then saved. */
    static int port(Context c) {
        SharedPreferences p = prefs(c);
        int saved = p.getInt("port", 0);
        if (allowed(saved)) return saved;
        int pick = BOARD_PORT;
        if (listening(BOARD_PORT)) pick = BOARD_PORT;
        else if (listening(CAMERA_PORT)) pick = CAMERA_PORT;
        else {
            int prop = parse(prop("persist.adb.tcp.port"));
            if (prop <= 0) prop = parse(prop("service.adb.tcp.port"));
            if (allowed(prop)) pick = prop;
        }
        p.edit().putInt("port", pick).apply();
        return pick;
    }

    static void setPort(Context c, int port) {
        if (!allowed(port)) return;
        prefs(c).edit().putInt("port", port).putLong("fixGapUntil", 0).apply();
    }

    static boolean isCamera(Context c) { return port(c) == CAMERA_PORT; }

    static int parse(String s) { try { return Integer.parseInt(s.trim()); } catch (Exception e) { return -1; } }

    static boolean listening(int port) {
        Socket s = new Socket();
        try { s.connect(new InetSocketAddress("127.0.0.1", port), 800); return true; }
        catch (Exception e) { return false; }
        finally { try { s.close(); } catch (Exception ignored) { } }
    }

    static String prop(String name) {
        String[] r = run(new String[] { "getprop", name }, null, 3000);
        return r[0] == null ? "" : r[0].trim();
    }

    /** First IPv4 address on a real interface, or "" when not on a network. */
    static String address() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    String h = a.getHostAddress();
                    if (h == null || h.indexOf(':') >= 0 || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    return h;
                }
            }
        } catch (Exception ignored) { }
        return "";
    }

    static final class Result {
        boolean listening, fixed, noRoot;
        String text = "";
    }

    /** Checks the port and, when it is closed, turns network ADB back on with root. */
    static Result check(Context c, boolean fix) {
        Result r = new Result();
        int port = port(c);
        r.listening = listening(port);
        if (r.listening) { r.text = "Listening on port " + port; return r; }
        if (!fix) { r.text = "Port " + port + " closed. Next fix attempt shortly."; return r; }
        String p = String.valueOf(port);
        String script = "settings put global adb_enabled 1\n"
            + "settings put global wifi_sleep_policy 2\n"
            + "setprop service.adb.tcp.port " + p + "\n"
            + "setprop persist.adb.tcp.port " + p + "\n"
            + "stop adbd\nsleep 1\nstart adbd\n"
            + "id\nexit\n";
        String[] out = run(new String[] { "su" }, script, 15000);
        String all = (out[0] == null ? "" : out[0]) + (out[1] == null ? "" : out[1]);
        if (out[0] == null || all.indexOf("uid=0") < 0) {
            r.noRoot = true;
            r.text = "No root access. Grant root to this app, or have the manufacturer set persist.adb.tcp.port=" + p + " in the image.";
            return r;
        }
        r.listening = waitForPort(port, 10000);
        if (!r.listening) {
            run(new String[] { "su", "-c", "setprop ctl.restart adbd" }, null, 8000);
            r.listening = waitForPort(port, 8000);
        }
        r.fixed = r.listening;
        r.text = r.listening ? "Turned back on and saved for every reboot" : "Root worked but adbd did not open port " + p + ". ";
        return r;
    }

    static boolean waitForPort(int port, long ms) {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (listening(port)) return true;
            try { Thread.sleep(500); } catch (InterruptedException e) { return false; }
        }
        return listening(port);
    }

    /** Runs a command, optionally writing a script to its stdin. Returns {stdout, stderr}; stdout is null if it could not start. */
    static String[] run(String[] cmd, String stdin, long ms) {
        Process pr = null;
        try {
            pr = Runtime.getRuntime().exec(cmd);
            if (stdin != null) { OutputStream os = pr.getOutputStream(); os.write(stdin.getBytes("UTF-8")); os.flush(); os.close(); }
            final StringBuilder out = new StringBuilder(), err = new StringBuilder();
            Thread a = pump(pr.getInputStream(), out), b = pump(pr.getErrorStream(), err);
            long end = System.currentTimeMillis() + ms;
            while (true) {
                try { pr.exitValue(); break; } catch (IllegalThreadStateException e) {
                    if (System.currentTimeMillis() > end) { pr.destroy(); break; }
                    Thread.sleep(100);
                }
            }
            a.join(1000); b.join(1000);
            return new String[] { out.toString(), err.toString() };
        } catch (Exception e) {
            if (pr != null) pr.destroy();
            return new String[] { null, String.valueOf(e.getMessage()) };
        }
    }

    private static Thread pump(final InputStream in, final StringBuilder sink) {
        Thread t = new Thread(new Runnable() {
            public void run() {
                byte[] buf = new byte[1024]; int n;
                try { while ((n = in.read(buf)) > 0) synchronized (sink) { sink.append(new String(buf, 0, n, "UTF-8")); } } catch (Exception ignored) { }
            }
        });
        t.setDaemon(true); t.start();
        return t;
    }

    private Keeper() { }
}

package com.hci.one.adb;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the keeper at boot, after an app update, and when someone unlocks the device. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) { KeeperService.start(c); }
}

package com.hci.one.adb;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The 15 minute alarm: makes sure the keeper is still running. */
public class AlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) { KeeperService.start(c); }
}

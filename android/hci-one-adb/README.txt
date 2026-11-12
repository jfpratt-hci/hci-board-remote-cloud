HCI ONE ADB (the keeper), version 1.1

Keeps network ADB on through reboots and drops. Boards and TVs: port 5555.
HCI ONE cameras: port 65037, the only port they work on.

WHICH PORT
Board Remote tells it on install:
    adb shell am start -n com.hci.one.adb/.MainActivity --ei port 65037
Only 5555 and 65037 are accepted. With nothing set, it keeps whichever is
already open (5555 first, then 65037), else persist.adb.tcp.port, else 5555.
The choice is saved on the device.

WHAT CHANGED FROM 1.0
1.0 always forced 5555, which knocks a camera off 65037. Board Remote 2.1.2
never installs 1.0 on a camera.

BUILD AND SIGN
Sign with the HCI ONE release keystore so it installs over 1.0 already on
boards (a different key fails with INSTALL_FAILED_UPDATE_INCOMPATIBLE):
    KS=/path/to/hci-release.jks KS_PASS=... ./build.sh
Then copy build/HCI_ONE_ADB_1.1.apk to board-remote/apks/HCI_ONE_ADB.apk.
Check the signer first:  apksigner verify --print-certs <apk>
It must read CN=HCI ONE, SHA-256 1dff8391...4212dc2 (the 1.0 key).

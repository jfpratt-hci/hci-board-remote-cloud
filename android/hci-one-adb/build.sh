#!/bin/bash
# Builds and signs HCI ONE ADB without Gradle.
# Needs: JDK, and the Ubuntu packages aapt dalvik-exchange zipalign apksigner android-sdk-platform-23
# Signing: set KS (keystore path) and KS_PASS, or a debug key is used.
set -euo pipefail
cd "$(dirname "$0")"
SDK_JAR=/usr/lib/android-sdk/platforms/android-23/android.jar
VERSION=$(grep -o 'versionName="[^"]*"' AndroidManifest.xml | cut -d'"' -f2)
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes"

echo "1/5 resources"
aapt package -f -m -J "$OUT/gen" -M AndroidManifest.xml -S res -I "$SDK_JAR"

echo "2/5 compile"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 \
  -bootclasspath "$SDK_JAR" -classpath "$SDK_JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')

echo "3/5 dex"
dalvik-exchange --dex --min-sdk-version=19 --output="$OUT/classes.dex" "$OUT/classes"

echo "4/5 package"
aapt package -f -M AndroidManifest.xml -S res -I "$SDK_JAR" -F "$OUT/unsigned.apk"
(cd "$OUT" && aapt add unsigned.apk classes.dex >/dev/null)
zipalign -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "5/5 sign"
APK="$OUT/HCI_ONE_ADB_${VERSION}.apk"
apksigner sign --ks "${KS:?set KS to the keystore}" --ks-pass "pass:${KS_PASS:?set KS_PASS}" --ks-key-alias hci --out "$APK" "$OUT/aligned.apk"
apksigner verify --print-certs "$APK" | head -3
echo "Built $APK"

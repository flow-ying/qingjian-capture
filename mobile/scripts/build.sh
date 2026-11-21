#!/usr/bin/env bash
# One-shot: JS tests + Kotlin unit tests + signed release APK → release/qingjian-mobile-<version>.apk (+ SHA-256).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
node --test tests/*.test.mjs
./gradlew testDebugUnitTest assembleRelease -q
VER="$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' app/build.gradle.kts | head -1)"
mkdir -p release
OUT="release/qingjian-mobile-$VER.apk"
cp app/build/outputs/apk/release/app-release.apk "$OUT"
"$ANDROID_HOME/build-tools/36.0.0/apksigner.bat" verify "$OUT"
sha256sum "$OUT" | tee "$OUT.sha256"

#!/usr/bin/env bash
# Build the release APK. Gradle's cache lives in .buildtools/gradle-home so it survives
# container restarts (the Claude container is recreated each session).
set -euo pipefail
cd "$(dirname "$0")/../android"
BT=$(d=$PWD; while [ "$d" != / ]; do [ -d "$d/.buildtools/jdk" ] && { echo "$d/.buildtools"; break; }; d=$(dirname "$d"); done)
export JAVA_HOME=${JAVA_HOME:-$BT/jdk} ANDROID_HOME=${ANDROID_HOME:-$BT/android-sdk}
export GRADLE_USER_HOME=${GRADLE_USER_HOME:-$BT/gradle-home}
./gradlew --no-daemon "${@:-assembleRelease}"
OUT=app/build/outputs/apk/release
if [ -f "$OUT/app-release.apk" ]; then
  CODE=$(grep -oE 'versionCode *= *[0-9]+' app/build.gradle.kts | grep -oE '[0-9]+')
  NAME=$(grep -oE 'versionName *= *"[^"]+"' app/build.gradle.kts | cut -d'"' -f2)
  printf '{"code": %s, "name": "%s"}\n' "$CODE" "$NAME" > "$OUT/version.json"
  ls -la "$OUT"
fi

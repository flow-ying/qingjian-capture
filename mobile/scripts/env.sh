# Source me after exporting your local Android toolchain paths (never commit machine-specific paths).
export JAVA_HOME="${JAVA_HOME:-/path/to/jdk-21}"
export ANDROID_HOME="${ANDROID_HOME:-/path/to/android-sdk}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
export PATH="$JAVA_HOME/bin:$PATH"

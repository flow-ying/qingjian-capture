# WebView bridge: methods called from JavaScript must survive R8.
-keepclassmembers class com.qingjian.mobile.** {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

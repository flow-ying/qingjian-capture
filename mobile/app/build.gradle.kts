import java.util.Properties

plugins {
    id("com.android.application")
}

// Signing identity lives outside the repo; set QJ_SIGNING_PROPS to a .properties file for release builds.
val signingProps = Properties().apply {
    val path = System.getenv("QJ_SIGNING_PROPS")
    if (!path.isNullOrBlank()) {
        val f = file(path)
        if (f.isFile) f.inputStream().use { load(it) }
    }
}

android {
    namespace = "com.qingjian.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.qingjian.mobile"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (signingProps.isNotEmpty()) {
            create("personal") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("personal")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        resources.excludes += setOf("META-INF/*.version", "META-INF/**/LICENSE*", "kotlin/**", "DebugProbesKt.bin")
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.work:work-runtime:2.11.2")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    testImplementation("junit:junit:4.13.2")
    // Real org.json for JVM unit tests (android.jar ships only stubs).
    testImplementation("org.json:json:20260814")
}

// Unit tests (incl. the opt-in LiveRelayTest) reuse the build machine's proxy; live runs are never cached.
tasks.withType<Test>().configureEach {
    for (k in listOf("https.proxyHost", "https.proxyPort", "http.proxyHost", "http.proxyPort", "http.nonProxyHosts")) System.getProperty(k)?.let { systemProperty(k, it) }
    if (!System.getenv("QJ_LIVE_URL").isNullOrEmpty()) outputs.upToDateWhen { false }
    testLogging { showStandardStreams = !System.getenv("QJ_LIVE_URL").isNullOrEmpty() }
}

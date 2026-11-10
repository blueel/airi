import org.jetbrains.kotlin.gradle.dsl.JvmTarget

import java.util.Properties

val minSdkVersion: Int by rootProject.extra
val compileSdkVersion: Int by rootProject.extra
val targetSdkVersion: Int by rootProject.extra
val androidxAppCompatVersion: String by rootProject.extra
val androidxCoordinatorLayoutVersion: String by rootProject.extra
val coreSplashScreenVersion: String by rootProject.extra
val junitVersion: String by rootProject.extra
val androidxJunitVersion: String by rootProject.extra
val androidxEspressoCoreVersion: String by rootProject.extra
val okhttpVersion: String by rootProject.extra
val orgJsonVersion: String by rootProject.extra

val androidMinSdk = minSdkVersion
val androidCompileSdk = compileSdkVersion
val androidTargetSdk = targetSdkVersion
val appVersionProperties = Properties().apply {
    rootProject.file("app-version.properties").inputStream().use(::load)
}
val androidVersionName = appVersionProperties.getProperty("AIRI_VERSION_NAME")
    ?: error("AIRI_VERSION_NAME is missing in android/app-version.properties")
val androidVersionCode = appVersionProperties.getProperty("AIRI_VERSION_CODE")
    ?.toIntOrNull()
    ?: error("AIRI_VERSION_CODE is missing or invalid in android/app-version.properties")

// The public host and its pinned certificate come from the build environment,
// so the repository carries neither. Without the variables the app trusts only
// the system anchors.
val airiNetworkConfigDir = layout.buildDirectory.dir("generated/airi/res")

val generateAiriNetworkConfig by tasks.registering {
    val outputDir = airiNetworkConfigDir
    val publicHost = providers.environmentVariable("AIRI_PUBLIC_HOST").orElse("")
    val publicCert = providers.environmentVariable("AIRI_PUBLIC_CERT").orElse("")

    inputs.property("publicHost", publicHost)
    inputs.property("publicCert", publicCert)
    outputs.dir(outputDir)

    doLast {
        val root = outputDir.get().asFile
        root.deleteRecursively()
        val xmlDir = File(root, "xml").apply { mkdirs() }
        val rawDir = File(root, "raw").apply { mkdirs() }

        val host = publicHost.get().trim()
        val cert = publicCert.get().trim()
        require(host.isEmpty() || host.matches(Regex("^[A-Za-z0-9.-]+$"))) {
            "AIRI_PUBLIC_HOST must be a host name or an IPv4 address: $host"
        }

        val pinned = host.isNotEmpty() && cert.isNotEmpty()
        if (pinned) {
            val source = file(cert)
            if (!source.isFile)
                error("AIRI_PUBLIC_CERT does not point to a file: $cert")
            source.copyTo(File(rawDir, "airi_cert.pem"), overwrite = true)
        }

        val domain = if (host.isEmpty()) {
            ""
        }
        else {
            val anchors = buildString {
                if (pinned)
                    appendLine("            <certificates src=\"@raw/airi_cert\" />")
                appendLine("            <certificates src=\"system\" />")
            }
            """
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">$host</domain>
        <trust-anchors>
$anchors        </trust-anchors>
    </domain-config>
"""
        }

        File(xmlDir, "network_security_config.xml").writeText(
            """
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
$domain</network-security-config>
""".trimStart(),
        )
    }
}

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.moeru.airi_pocket"
    compileSdk = androidCompileSdk

    defaultConfig {
        applicationId = "ai.moeru.airi_pocket"
        minSdk = androidMinSdk
        targetSdk = androidTargetSdk
        versionCode = androidVersionCode
        versionName = androidVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // NOTICE:
        // Pocket-specific slim build: only arm64-v8a is packaged. x86/x86_64
        // native libraries exist for emulator and ChromeOS use only; real
        // Android phones are arm64. Saves ~11MB in the APK.
        // Removal condition: restore when an emulator build is needed.
        ndk {
            // NOTICE: x86_64 added temporarily for local emulator debugging; revert to arm64-v8a only after done.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android.txt"),
                "proguard-rules.pro",
            )
        }
    }
    androidResources {
        // Files and dirs to omit from the packaged assets dir, modified to accommodate modern web apps.
        // Default: https://android.googlesource.com/platform/frameworks/base/+/282e181b58cf72b6ca770dc7ca5f91f135444502/tools/aapt/AaptAssets.cpp#61
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~"
    }

    sourceSets {
        getByName("main") {
            res.srcDir(airiNetworkConfigDir.get().asFile.path)
        }
    }
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(generateAiriNetworkConfig)
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
    }
}

repositories {
    flatDir {
        dirs("../capacitor-cordova-android-plugins/src/main/libs", "libs")
    }
}

dependencies {
    implementation(fileTree(mapOf("include" to listOf("*.jar"), "dir" to "libs")))
    implementation("androidx.appcompat:appcompat:$androidxAppCompatVersion")
    implementation("androidx.coordinatorlayout:coordinatorlayout:$androidxCoordinatorLayoutVersion")
    implementation("androidx.core:core-splashscreen:$coreSplashScreenVersion")
    implementation("com.squareup.okhttp3:okhttp:$okhttpVersion")
    implementation(project(":capacitor-android"))
    testImplementation("junit:junit:$junitVersion")
    testImplementation("org.json:json:$orgJsonVersion")
    androidTestImplementation("androidx.test.ext:junit:$androidxJunitVersion")
    androidTestImplementation("androidx.test.espresso:espresso-core:$androidxEspressoCoreVersion")
    implementation(project(":capacitor-cordova-android-plugins"))
}

apply(from = "capacitor.build.gradle")

try {
    val servicesJson = file("google-services.json")
    if (servicesJson.isFile && servicesJson.length() > 0) {
        apply(plugin = "com.google.gms.google-services")
    }
} catch (error: Exception) {
    logger.info("google-services.json not found, google-services plugin not applied. Push Notifications won't work")
}

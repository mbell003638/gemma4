# P1 LiteRT-LM feasibility spike

This code is not registered in Expo yet. It must not change Needle, the old optional runtime, the product catalog or accounting before the P1 gate.

`src/LiteRtFeasibility.kt` uses SDK APIs for text, prepared image, prepared audio and a manual read-tool round-trip. Automatic callbacks throw. There is no ledger/database access.

`src/ApiContractCheck.kt` checks API/configuration behavior without JNI. It is not an Android/model test.

SDK: `com.google.ai.edge.litertlm:litertlm-android:0.17.0`. Artifacts stay under ignored `.local-tools/`; no models are downloaded. Run the provided setup/compile scripts from this clone root. They write only to this clone.

Before P2/P3 activation, run all four `LiteRtFeasibility.run` modes on physical Android with verified E2B and controlled fixtures. Record device/backend/version/hash, output and latency. Use a worker thread. This synchronous spike is not the P3 production lifecycle coordinator.

Fixtures must already be prepared image/mono WAV files. Camera/PDF/AAC normalization belongs to a later adapter, not renaming extensions.

## Reproduce local checks

From this clone root:

```powershell
node spikes/gemma4/verify-isolation.mjs
$env:GEMMA_JDK = 'C:/Program Files/Android/Android Studio/jbr'
node spikes/gemma4/check-sdk.mjs
```

The first dependency preparation requires `--download-tools` and downloads compiler/SDK artifacts only, never model weights. Dependencies, class output and the machine-readable report stay inside this clone's ignored directories. A failed rerun removes the old success report first. Do not mistake the compiler's JVM output for an Android APK.

## New compatibility finding

The published SDK classes carry Kotlin metadata `2.4.0`; their POM uses Kotlin reflection 2.4.0 and coroutines Android 1.11.0. The app's installed React Native build-plugin catalog lists Kotlin 2.1.20 and AGP 8.11.0. This spike therefore uses an isolated Kotlin 2.4.0 compiler without changing the app toolchain.

Before app integration, test a compatible Kotlin/AGP/D8/R8 configuration with Expo/React Native and Needle, or investigate a supported earlier LiteRT-LM release that still implements the required Gemma modalities/manual tools. Do not use `-Xskip-metadata-version-check` or quietly upgrade every product.

References: [SDK POM](https://dl.google.com/dl/android/maven2/com/google/ai/edge/litertlm/litertlm-android/0.17.0/litertlm-android-0.17.0.pom), [Android Kotlin/D8/R8 compatibility](https://developer.android.com/build/kotlin-support).

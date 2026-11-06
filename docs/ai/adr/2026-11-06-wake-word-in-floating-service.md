# Wake word in the floating bubble service

Status: accepted

## Context

The Web wake word runs a Sherpa-ONNX keyword spotter in a Worker (`packages/stage-ui/src/libs/voice/wake-word-detector.ts`).
It owns a microphone stream from the page.

The floating bubble is different. `FloatingBubbleService` runs in a native foreground service over other apps.
Android can suspend the WebView and stop its audio capture while the owner uses another app.
A Web Worker cannot keep the microphone open in that state.

## Decision

The foreground service listens for the wake word.

- `WakeWordListener` runs Android `SpeechRecognizer` in a loop. It asks the recognizer to prefer the on-device model.
- `WakeWordMatcher` compares the transcript with the written wake words of the active character. It ignores case, spaces, and punctuation. A phrase matches only at the start of the transcript.
- A phrase with a command after it delivers one transcript. A phrase alone opens a short command capture.
- The listener pauses while AIRI speaks and while hold-to-talk runs. The WebView reports the speech state through `setWakeWordSpeaking`.
- The settings page sends the active character's wake words through `FloatingBubble.setWakeWord`.
- `WakeWordSettings` stores the switch, the phrases, and the language in private `SharedPreferences`. The service reads them before the WebView loads.
- The service declares `mediaProjection|microphone`. It adds the microphone foreground type only while the wake word is on and the microphone permission is granted.
- The foreground notification names the wake phrase while the wake word listens.

## Consequences

- No new native library, model download, or APK size is added.
- Text matching is less accurate than the token keyword spotter. A name that the system recognizer writes differently does not match.
- A phone without an offline model can send the audio to the system recognition service. The settings page states that the microphone stays open.
- The recognizer uses one language. A bilingual wake word list works only as well as the selected system language.
- Android can stop or delay recognition while the device sleeps or another app holds the microphone. The listener retries with backoff.
- The service and the Web keyword spotter use different engines. A later change can replace `WakeWordListener` with a native Sherpa-ONNX spotter and keep the plugin contract.

## Alternatives

- Keep the Web keyword spotter: the WebView and its Worker do not keep the microphone in the background.
- Add the Sherpa-ONNX Android AAR: it has no official Maven artifact, and it adds a model and native libraries to the APK.
- Use `AlwaysOnHotwordDetector`: it requires a system voice interaction service, which a normal app cannot provide.

<h1 align="center">アイリ VTuber</h1>

<p align="center">
  [<a href="https://airi.ayaka.io">Try it</a>]
</p>

> Heavily inspired by [Neuro-sama](https://www.youtube.com/@Neurosama)

## Local Hearing

Stage Pocket exposes Sherpaw models through the shared Vite plugin. The models load from pinned remote URLs when selected.
Chinese and English start with Paraformer. Other languages use an available model that supports them.

Selected remote models download into the WebView origin private file system.
Sherpaw settings show download state and let users remove stored files.
Verify origin private file system support on each target device.

## Screen Bubble Wake Word

The Android screen bubble can listen for the active character's wake word while it runs over other apps.
The native foreground service uses Android speech recognition and matches the written wake words at the start of an utterance.
The setting is off by default. The settings page states that the microphone stays open while the wake word listens.
The Web keyword spotter and the native service use different engines. See `docs/ai/adr/2026-11-06-wake-word-in-floating-service.md`.

## Watch Along

Watch along keeps one screen look per interval on the bubble's MediaProjection session.
The vision model describes the frame, and the character comments in voice when a reaction fits.
The mode needs the screen bubble and a configured vision provider. See `docs/ai/adr/2026-11-06-watch-along.md`.

## Background Replies

Android freezes a hidden WebView page after about a minute, so the page cannot answer or speak there.
The screen bubble service answers a wake word or hold-to-talk turn itself: it sends the prepared chat and speech
requests, plays the audio, and adds the finished turn to the chat history when the page runs again.
The switch is in the screen bubble settings and is on by default.
The background turn uses the character prompt and recent history, but no tools.
See `docs/ai/adr/2026-11-09-background-reply.md`.

## WebSocket Bridge

Stage Pocket adds a host-backed WebSocket bridge for `@proj-airi/server-sdk`.

Design constraints:
- keep page loading on secure origins (`https` or app-hosted local origins) to preserve secure-context web APIs
- only implement the WebSocket bridge needed by `@proj-airi/server-sdk`
- native owns socket I/O; `server-sdk` owns reconnect, heartbeat, authentication, and connection state
- the bridge only forwards `connect`, `send`, `close`, `open`, `message`, `error`, and `close`

# Background replies in the floating bubble

Status: accepted

## Context

Android freezes a hidden WebView page after about a minute. We measured this on an Android 36 emulator with the 0.14.26 build: a one-second page timer ran 66 times in 155 background seconds, then stopped, while the audio clock kept running. A foreground service does not prevent it. With the bubble service running, the app process stayed at `FOREGROUND_SERVICE`, was not cached, and was not frozen, yet the page still stopped. Native to JavaScript events waited too: a scheduled notification callback ran only when the page became visible again.

All speech work runs in the WebView: the chat request, the speech request, and Web Audio playback. A wake word or hold-to-talk turn that arrives after the freeze therefore has no reply and no voice until the owner returns.

## Decision

The floating bubble service answers a background turn itself.

- The WebView prepares the chat and speech HTTP requests with the same xsai helpers as a normal turn, and stores them in private `SharedPreferences`. It also stores the composed system prompt and up to 16 recent text turns.
- When the activity is not visible, `deliverVoice` starts `BackgroundReplyEngine` instead of sending the transcript to the WebView.
- The engine posts the chat request, keeps the reply text, posts the speech request, and plays the audio with `MediaPlayer` and a transient audio focus request. A local speech server that answers 409 is retried.
- The finished exchange is queued in private storage. When the page runs again, the app appends the owner message and the reply to the chat history.
- A failure falls back to the WebView path, so the normal turn answers when the owner returns. The phone shows a short toast.
- The screen bubble settings offer a switch. The default is on.

## Consequences

- Background voice works after the page freeze, including while the screen is locked.
- The background turn does not use tools, skills, recipes, stickers, or the runtime emotion pipeline. It does use the character system prompt and the recent text history.
- The engine reads the reply as written. It does not run the speech text preprocessor, so markdown and formulas read less well than in the app.
- The configuration carries the provider API key into private app storage. The key is already stored in the WebView localStorage.
- The reply appears in the chat history only when the page runs again. The owner hears it before seeing it.
- Watch along replies still need the WebView, because the vision read and the notice go through the JavaScript store. A later change can give the engine a frame and the vision request.
- Only OpenAI-style chat and speech endpoints work. Another provider leaves the switch ineffective and the normal path answers on return.

## Alternatives

- Picture in picture: keeps the page visible, so everything runs. It adds a second floating window next to the bubble.
- Move the page into a one-pixel overlay window: fragile view reparenting and a viewport resize.
- Keep the whole reply pipeline native: duplicates memory, tools, and the chat runtime.

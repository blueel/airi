# Watch along and play along

Status: accepted

## Context

AIRI already has screen capture, a vision model, a chat notice pipeline, and live voice output:

- The live room reads one region of the screen with local OCR and sends the comments as notices.
- The vision orchestrator describes a screen frame with the configured vision provider.
- The floating bubble on Android holds a MediaProjection session and can capture one frame on a tap.
- A notice reaches the owner conversation, and the character answers in her own voice.

The owner can watch a video or play a game and want the character to react without a question.

## Decision

### The mode

- `useWatchAlongStore` reads one frame per interval and asks the vision model for a short description.
- The description goes to the conversation as a `watch-along` notice. The character answers with a short line, or stays quiet.
- The notice shows only the description under a `Watch along` badge. The prompt around it stays for the model.
- The mode is off by default. The owner starts and stops it from the chat toolbar or the mobile add menu.

### Capture

- A capture source delivers JPEG frames and a 64-bit average hash.
- Web and desktop use `getDisplayMedia`. The browser asks for the screen or window once.
- Android registers a native source. The floating bubble runs one frame look per interval on its MediaProjection session, so the mode keeps working while the owner uses another app.
- A frame is at most 1280 pixels on its long side.

### Cost and pacing

- The store skips a frame whose average hash is within 6 bits of the previous frame. A cursor or clock does not reach the vision model.
- The store also skips a frame while a vision read runs, while the character writes a reply, or while the owner has a turn in flight.
- The interval is 20, 30, 60, or 120 seconds. The native loop has a 15 second floor.
- The character speaks at most once a minute, even when the screen changes faster.
- The vision workload asks for `nothing` when the screen is quiet. The store drops that answer.

### Vision and voice

- The new `screen:companion` workload asks for one or two sentences about the visible action, characters, game state, or dialogue. It ignores private messages and notifications.
- The chat model reads the description, not the image. The frame stays out of the chat history and out of cloud chat sync.
- The reply is a normal assistant turn, so the existing speech output speaks it.

## Consequences

- The mode needs a configured vision provider. Without one, the panel explains that and offers the vision settings.
- On Android the mode needs the screen bubble. Without it, the panel offers the screen bubble settings.
- Each look costs one vision call, and each comment costs one chat call. The hash gate and the active turn check limit both.
- The average hash is a cheap change detector. A small but important change, such as one line of dialogue, can stay under the threshold and wait for the next look.
- Watch-along notices stay in the local chat history. They do not sync to the cloud because a cloud chat cannot mark a notice.
- The frame goes to the vision provider that the owner configured. The panel states this and the mode stops at once.

## Alternatives

- Send every frame to the chat model as an attachment: the chat history fills with screenshots, and a model without vision needs a second read anyway.
- Read the screen with OCR only: it misses video, game scenes, and character animation.
- Capture only when the owner presses a button: it is the existing screenshot flow, not a companion that reacts on its own.

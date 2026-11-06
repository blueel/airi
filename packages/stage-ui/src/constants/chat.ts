/**
 * Source of the notice that asks the character to speak into the open conversation on her own.
 * Only the model reads it: the history leaves it out, so a broadcast reads as her speaking.
 */
export const AUTO_SPEAK_NOTICE_SOURCE = 'auto-speak'

/**
 * Source of the notice that carries the viewer comments read from one region of the shared screen.
 * The history shows these as the viewers wrote them, not as the owner speaking.
 */
export const LIVE_ROOM_NOTICE_SOURCE = 'live-room'

/**
 * Source of the notice that carries one description of the owner's screen during a watch-along.
 * The history shows the description under a small badge, not the prompt around it.
 */
export const WATCH_ALONG_NOTICE_SOURCE = 'watch-along'

/**
 * Source of the notice that the proactive scheduler sends after a long silence.
 * Only the model reads it: the history leaves it out, so a topic reads as the character starting it.
 */
export const PROACTIVE_NOTICE_SOURCE = 'proactive'

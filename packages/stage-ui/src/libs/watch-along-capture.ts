import type { WatchAlongFrame } from './watch-along'

import { averageHashFromLuma, WATCH_ALONG_MAX_FRAME_SIDE } from './watch-along'

export type WatchAlongCaptureKind = 'screen' | 'android-bubble'

export interface WatchAlongCaptureOptions {
  intervalMs: number
  onFrame: (frame: WatchAlongFrame) => void
  /** The owner stopped the share from the system UI, or the capture ended. */
  onEnded?: () => void
  onError?: (error: unknown) => void
}

/**
 * One source of screen frames for the companion mode.
 *
 * The browser source shares a screen or window. The Android source receives frames from the floating bubble's
 * MediaProjection session. Both deliver JPEG data URLs and an average hash.
 */
export interface WatchAlongCaptureSource {
  readonly kind: WatchAlongCaptureKind
  readonly previewStream?: MediaStream
  start: (options: WatchAlongCaptureOptions) => Promise<void>
  stop: () => Promise<void>
}

function lumaOf(data: Uint8ClampedArray) {
  const luma: number[] = []
  for (let index = 0; index < data.length; index += 4) {
    luma.push(Math.floor((data[index] * 299 + data[index + 1] * 587 + data[index + 2] * 114) / 1000))
  }
  return luma
}

function hashOfCanvas(canvas: HTMLCanvasElement) {
  const small = document.createElement('canvas')
  small.width = 8
  small.height = 8
  const context = small.getContext('2d', { willReadFrequently: true })
  if (!context)
    throw new Error('Canvas is unavailable')

  context.drawImage(canvas, 0, 0, small.width, small.height)
  return averageHashFromLuma(lumaOf(context.getImageData(0, 0, small.width, small.height).data))
}

/** Shares one screen or window and turns frames into small JPEGs on the interval. */
export function createBrowserWatchAlongCapture(): WatchAlongCaptureSource {
  let stream: MediaStream | undefined
  let video: HTMLVideoElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = true
  let options: WatchAlongCaptureOptions | undefined

  function clearTimer() {
    if (timer)
      clearTimeout(timer)
    timer = undefined
  }

  function capture() {
    if (stopped || !video || !options)
      return
    const target = video
    if (target.readyState < 2 || !target.videoWidth) {
      schedule()
      return
    }

    try {
      const scale = Math.min(1, WATCH_ALONG_MAX_FRAME_SIDE / Math.max(target.videoWidth, target.videoHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(target.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(target.videoHeight * scale))
      const context = canvas.getContext('2d')
      if (!context)
        throw new Error('Canvas is unavailable')

      context.drawImage(target, 0, 0, canvas.width, canvas.height)
      options.onFrame({
        dataUrl: canvas.toDataURL('image/jpeg', 0.82),
        hash: hashOfCanvas(canvas),
      })
    }
    catch (error) {
      options.onError?.(error)
    }
    schedule()
  }

  function schedule() {
    clearTimer()
    if (stopped || !options)
      return
    timer = setTimeout(capture, options.intervalMs)
  }

  async function stop() {
    stopped = true
    clearTimer()
    options = undefined
    for (const track of stream?.getTracks() ?? [])
      track.stop()
    stream = undefined
    if (video) {
      video.srcObject = null
      video.remove()
      video = undefined
    }
  }

  return {
    kind: 'screen',
    get previewStream() {
      return stream
    },
    async start(next) {
      if (!navigator.mediaDevices?.getDisplayMedia)
        throw new Error('Screen capture is unavailable')

      // Release a previous share without an await, so the picker opens inside the owner's click.
      clearTimer()
      for (const track of stream?.getTracks() ?? [])
        track.stop()
      stream = undefined
      if (video) {
        video.srcObject = null
        video.remove()
        video = undefined
      }

      options = next
      stopped = false
      try {
        const media = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 5, max: 10 } },
          audio: false,
        })
        stream = media

        const element = document.createElement('video')
        element.muted = true
        element.playsInline = true
        element.setAttribute('aria-hidden', 'true')
        element.srcObject = media
        element.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
        document.body.appendChild(element)
        video = element
        await element.play()

        media.getVideoTracks()[0]?.addEventListener('ended', () => {
          void stop().then(() => next.onEnded?.())
        }, { once: true })

        // The owner starts the mode before switching to the game or video. The first look waits one interval.
        schedule()
      }
      catch (error) {
        await stop()
        throw error
      }
    },
    stop,
  }
}

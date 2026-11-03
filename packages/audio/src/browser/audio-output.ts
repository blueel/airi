import type { PcmBlock, PlayedAudio, PlayingAudio } from '@proj-airi/pipelines-audio'

/** How long a clip waits for a suspended context to come back before it fails. */
const SUSPEND_WAIT_MS = 20_000

/**
 * One clip on a Web Audio context.
 *
 * Blocks are scheduled back to back on the context clock. The rendered interval comes from scheduled
 * node times, not from JavaScript timers.
 */
export class AudioOutput implements PlayingAudio {
  private readonly completion = Promise.withResolvers<PlayedAudio>()
  private readonly gain: GainNode
  private readonly nodes = new Map<AudioBufferSourceNode, { start: number, duration: number }>()
  private reader: ReadableStreamDefaultReader<PcmBlock> | undefined
  private nextStart: number
  private throughMs = 0
  /** Context seconds of the first scheduled sample and of the last rendered sample. */
  private firstStart: number | undefined
  private renderedEnd: number | undefined
  private ended = false
  private stopped = false
  private stoppedAt: number | undefined
  private settled = false
  private started = false
  readonly done = this.completion.promise

  constructor(private readonly context: AudioContext, audio: Blob | ReadableStream<PcmBlock>, destination: AudioNode, private readonly options?: {
    /** Earliest context time, in milliseconds, for the first sample. */
    startAtMs?: number
    onStart?: () => void
  }) {
    this.gain = context.createGain()
    this.gain.connect(destination)
    this.nextStart = Math.max(context.currentTime, (options?.startAtMs ?? 0) / 1000)
    context.addEventListener('statechange', this.contextChanged)
    void this.load(audio).catch(cause => this.finish(cause instanceof Error ? cause : new Error('Audio playback failed', { cause })))
  }

  private async load(audio: Blob | ReadableStream<PcmBlock>) {
    if (!await this.waitForRunning())
      throw new Error('Playback requires a running audio context')
    if (audio instanceof Blob) {
      const decoded = await this.context.decodeAudioData(await audio.arrayBuffer())
      if (!this.stopped)
        this.schedule(decoded)
    }
    else {
      this.reader = audio.getReader()
      try {
        while (!this.stopped) {
          const result = await this.reader.read()
          if (result.done || this.stopped)
            break
          const block = result.value
          const buffer = this.context.createBuffer(block.channels.length, block.channels[0].length, block.sampleRate)
          block.channels.forEach((channel, index) => buffer.copyToChannel(new Float32Array(channel), index))
          this.schedule(buffer)
        }
      }
      finally {
        this.reader.releaseLock()
        this.reader = undefined
      }
    }
    this.ended = true
    if (!this.nodes.size)
      this.finish()
  }

  private schedule(buffer: AudioBuffer) {
    if (this.stopped || this.settled)
      return
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    const start = Math.max(this.context.currentTime, this.nextStart)
    this.nextStart = start + buffer.duration
    this.nodes.set(source, { start, duration: buffer.duration })
    this.firstStart ??= start
    /** Triggering workflow: scheduled source ends → rendered interval → output drain or silence receipt. */
    source.onended = () => {
      const entry = this.nodes.get(source)
      if (!entry)
        return
      const rendered = Math.max(0, Math.min(entry.duration, (this.stoppedAt ?? this.context.currentTime) - entry.start))
      this.throughMs += rendered * 1000
      // A node that a fade stopped before its start rendered nothing and must not extend the interval.
      if (rendered > 0)
        this.renderedEnd = Math.max(this.renderedEnd ?? 0, entry.start + rendered)
      this.nodes.delete(source)
      source.disconnect()
      if (!this.nodes.size && (this.ended || this.stopped))
        this.finish()
    }
    source.start(start)
    if (!this.started) {
      this.started = true
      this.options?.onStart?.()
    }
  }

  stop(options: { fadeMs: number }): Promise<PlayedAudio> {
    if (this.stopped || this.settled)
      return this.done
    this.stopped = true
    void this.reader?.cancel('Playback stopped').catch(() => {})
    if (!this.nodes.size) {
      this.finish()
      return this.done
    }
    if (this.context.state !== 'running') {
      this.finish(new Error('Playback context cannot confirm fade completion'))
      return this.done
    }
    const start = this.context.currentTime
    const end = start + options.fadeMs / 1000
    this.stoppedAt = end
    this.gain.gain.cancelScheduledValues(start)
    this.gain.gain.setValueAtTime(this.gain.gain.value, start)
    this.gain.gain.linearRampToValueAtTime(0, end)
    this.nodes.forEach((_entry, source) => source.stop(end))
    return this.done
  }

  /** Triggering workflow: browser suspends or closes the audio context → resume, or fail when it closed. */
  private readonly contextChanged = () => {
    if (this.settled || this.stopped || this.context.state === 'running')
      return
    if (this.context.state === 'closed') {
      this.finish(new Error('Audio context closed during playback'))
      return
    }
    // NOTICE:
    // A phone suspends the context when the screen locks or audio focus moves,
    // and the stopped clock leaves queued clips waiting forever. Resume instead
    // of failing the reply; the sources continue where they stopped.
    // Source: Chrome Android audio-focus behaviour.
    // Removal: when platforms stop suspending contexts during playback.
    if (!this.stopped)
      void this.context.resume().catch(() => {})
  }

  /**
   * Waits for a usable clock, asking a suspended context to resume.
   *
   * A browser only grants `resume()` from a user gesture, so a clip that arrives
   * while the page is in the background waits instead of failing. The wait is
   * bounded, so a context that never returns cannot hold a reply open.
   */
  private async waitForRunning(timeoutMs = SUSPEND_WAIT_MS) {
    if (this.context.state === 'closed')
      return false
    const deadline = Date.now() + timeoutMs
    while (this.context.state !== 'running') {
      void this.context.resume().catch(() => {})
      if (Date.now() > deadline)
        return false
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }

    return true
  }

  private finish(error?: Error) {
    if (this.settled)
      return
    this.settled = true
    this.stopped = true
    void this.reader?.cancel(error).catch(() => {})
    this.context.removeEventListener('statechange', this.contextChanged)
    this.nodes.forEach((_entry, source) => {
      source.onended = null
      source.stop()
      source.disconnect()
    })
    this.nodes.clear()
    this.gain.disconnect()
    if (error)
      this.completion.reject(error)
    else if (this.firstStart === undefined || this.renderedEnd === undefined)
      this.completion.resolve({ throughMs: this.throughMs })
    else
      this.completion.resolve({ throughMs: this.throughMs, interval: { startMs: this.firstStart * 1000, endMs: this.renderedEnd * 1000 } })
  }
}

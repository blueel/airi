/**
 * The wire protocol of the Bilibili live danmaku socket.
 *
 * Every socket message carries one or more packets with a 16-byte big-endian header:
 * packet length (u32), header length (u16), protocol version (u16), operation (u32),
 * and sequence (u32). A version 2 body is a zlib stream and a version 3 body is a
 * brotli stream; both expand to more packets of the same shape. Version 0 and 1
 * bodies are plain JSON or an empty heartbeat payload.
 */

export const DANMAKU_HEADER_LENGTH = 16
export const DANMAKU_OP_HEARTBEAT = 2
export const DANMAKU_OP_HEARTBEAT_REPLY = 3
export const DANMAKU_OP_MESSAGE = 5
export const DANMAKU_OP_AUTH = 7
export const DANMAKU_OP_AUTH_REPLY = 8

export type DanmakuOperation
  = | typeof DANMAKU_OP_HEARTBEAT
    | typeof DANMAKU_OP_HEARTBEAT_REPLY
    | typeof DANMAKU_OP_MESSAGE
    | typeof DANMAKU_OP_AUTH
    | typeof DANMAKU_OP_AUTH_REPLY

export type DanmakuProtocolVersion = 0 | 1 | 2 | 3

/** One packet as it came off the socket, with its body still compressed if it was. */
export interface DanmakuFrame {
  protocolVersion: DanmakuProtocolVersion
  operation: number
  body: Uint8Array<ArrayBuffer>
}

/** One packet with a body that is ready to read as JSON. */
export interface DanmakuMessage {
  operation: number
  body: Uint8Array<ArrayBuffer>
}

function writeUint16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 8) & 0xFF
  bytes[offset + 1] = value & 0xFF
}

function writeUint32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xFF
  bytes[offset + 1] = (value >>> 16) & 0xFF
  bytes[offset + 2] = (value >>> 8) & 0xFF
  bytes[offset + 3] = value & 0xFF
}

/** Builds one packet around a text or binary body. */
export function encodeDanmakuPacket(options: { protocolVersion: DanmakuProtocolVersion, operation: number, body?: string | Uint8Array<ArrayBuffer> }): Uint8Array<ArrayBuffer> {
  const body = typeof options.body === 'string'
    ? new TextEncoder().encode(options.body)
    : options.body ?? new Uint8Array(0)

  const bytes = new Uint8Array(DANMAKU_HEADER_LENGTH + body.length)
  writeUint32(bytes, 0, bytes.length)
  writeUint16(bytes, 4, DANMAKU_HEADER_LENGTH)
  writeUint16(bytes, 6, options.protocolVersion)
  writeUint32(bytes, 8, options.operation)
  writeUint32(bytes, 12, 1)
  bytes.set(body, DANMAKU_HEADER_LENGTH)
  return bytes
}

export interface DanmakuAuthPayload {
  /** The uid of the viewer that connects, 0 when the request carries no login state. */
  uid: number
  roomId: number
  /** The token of the getDanmuInfo answer. */
  key: string
  /** The buvid3 cookie value. Recent servers drop connections that omit it. */
  buvid?: string
  protocolVersion?: 1 | 2 | 3
}

/**
 * Builds the auth packet that the socket expects within a few seconds of opening.
 * The default version is 2 (zlib) rather than 3 (brotli): every runtime that this
 * app targets can inflate zlib, while brotli through DecompressionStream needs a
 * newer engine, and the server accepts both.
 */
export function encodeDanmakuAuthPacket(payload: DanmakuAuthPayload): Uint8Array<ArrayBuffer> {
  const protocolVersion = payload.protocolVersion ?? 2
  const body = JSON.stringify({
    uid: payload.uid,
    roomid: payload.roomId,
    protover: protocolVersion,
    platform: 'web',
    type: 2,
    key: payload.key,
    ...(payload.buvid ? { buvid: payload.buvid } : {}),
  })
  return encodeDanmakuPacket({ protocolVersion, operation: DANMAKU_OP_AUTH, body })
}

/** Builds the heartbeat. The body repeats what the web client sends, for servers that check it. */
export function encodeDanmakuHeartbeatPacket(): Uint8Array<ArrayBuffer> {
  return encodeDanmakuPacket({ protocolVersion: 1, operation: DANMAKU_OP_HEARTBEAT, body: '[object Object]' })
}

/**
 * Splits one socket message into its packets. A body that does not fill a whole
 * packet ends the read, so a truncated tail never becomes a garbage packet.
 */
export function decodeDanmakuPackets(data: ArrayBuffer | Uint8Array<ArrayBuffer>): DanmakuFrame[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frames: DanmakuFrame[] = []
  let offset = 0
  while (offset + DANMAKU_HEADER_LENGTH <= bytes.length) {
    const packetLength = view.getUint32(offset)
    const headerLength = view.getUint16(offset + 4)
    if (packetLength < headerLength || offset + packetLength > bytes.length)
      break
    frames.push({
      protocolVersion: view.getUint16(offset + 6) as DanmakuProtocolVersion,
      operation: view.getUint32(offset + 8),
      body: bytes.slice(offset + headerLength, offset + packetLength),
    })
    offset += packetLength
  }
  return frames
}

/** The viewer count that a heartbeat reply carries in its four-byte body. */
export function decodeDanmakuPopularity(body: Uint8Array): number {
  if (body.length < 4)
    return 0
  return new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0)
}

let brotliSupported: boolean | undefined

function decompressionFormatSupported(format: 'deflate' | 'br'): boolean {
  if (format !== 'br')
    return true
  brotliSupported ??= (() => {
    try {
      // The DOM lib types `CompressionFormat` without "br", although newer
      // engines accept it, so the probe goes through Reflect.
      Reflect.construct(DecompressionStream, ['br'])
      return true
    }
    catch {
      return false
    }
  })()
  return brotliSupported
}

async function decompressBody(body: Uint8Array<ArrayBuffer>, format: 'deflate' | 'br'): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === 'undefined' || !decompressionFormatSupported(format))
    throw new Error(`DecompressionStream "${format}" is unavailable in this runtime`)

  // The DOM lib leaves "br" out of CompressionFormat, so the brotli branch constructs through Reflect.
  const source = new Blob([body]).stream()
  const stream = format === 'br'
    ? source.pipeThrough(Reflect.construct(DecompressionStream, [format]) as DecompressionStream)
    : source.pipeThrough(new DecompressionStream(format))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Reads one socket message into the messages that it carries. Compressed bodies
 * expand to the packets inside them; the rest pass through as they are.
 */
export async function readDanmakuSocketMessage(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<DanmakuMessage[]> {
  const messages: DanmakuMessage[] = []
  for (const frame of decodeDanmakuPackets(data)) {
    if (frame.protocolVersion === 2 || frame.protocolVersion === 3) {
      const format = frame.protocolVersion === 2 ? 'deflate' : 'br'
      const raw = await decompressBody(frame.body, format)
      for (const packet of decodeDanmakuPackets(raw))
        messages.push({ operation: packet.operation, body: packet.body })
    }
    else {
      messages.push({ operation: frame.operation, body: frame.body })
    }
  }
  return messages
}

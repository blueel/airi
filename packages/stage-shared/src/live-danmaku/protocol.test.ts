import { brotliCompressSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  DANMAKU_OP_AUTH,
  DANMAKU_OP_HEARTBEAT,
  DANMAKU_OP_HEARTBEAT_REPLY,
  DANMAKU_OP_MESSAGE,
  decodeDanmakuPackets,
  decodeDanmakuPopularity,
  encodeDanmakuAuthPacket,
  encodeDanmakuHeartbeatPacket,
  encodeDanmakuPacket,
  readDanmakuSocketMessage,
} from './protocol'

async function compressBody(body: string, format: 'deflate'): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function brotliIsSupported() {
  try {
    Reflect.construct(DecompressionStream, ['br'])
    return true
  }
  catch {
    return false
  }
}

describe('danmaku protocol', () => {
  it('builds an auth packet that decodes back to its fields', () => {
    const packet = encodeDanmakuAuthPacket({ uid: 0, roomId: 21653665, key: 'token-abc', buvid: 'buvid-1' })
    const [frame] = decodeDanmakuPackets(packet)

    expect(frame).toBeDefined()
    expect(frame!.operation).toBe(DANMAKU_OP_AUTH)
    expect(frame!.protocolVersion).toBe(2)
    expect(JSON.parse(new TextDecoder().decode(frame!.body))).toMatchObject({
      uid: 0,
      roomid: 21653665,
      protover: 2,
      platform: 'web',
      type: 2,
      key: 'token-abc',
      buvid: 'buvid-1',
    })
  })

  it('builds a heartbeat with a text body', () => {
    const [frame] = decodeDanmakuPackets(encodeDanmakuHeartbeatPacket())
    expect(frame!.operation).toBe(DANMAKU_OP_HEARTBEAT)
    expect(new TextDecoder().decode(frame!.body)).toBe('[object Object]')
  })

  it('reads several packets out of one socket message', () => {
    const first = encodeDanmakuPacket({ protocolVersion: 0, operation: DANMAKU_OP_MESSAGE, body: '{"cmd":"A"}' })
    const second = encodeDanmakuPacket({ protocolVersion: 0, operation: DANMAKU_OP_HEARTBEAT_REPLY, body: new Uint8Array([0, 0, 1, 0]) })
    const merged = new Uint8Array(first.length + second.length)
    merged.set(first)
    merged.set(second, first.length)

    const frames = decodeDanmakuPackets(merged)
    expect(frames).toHaveLength(2)
    expect(frames[0]!.operation).toBe(DANMAKU_OP_MESSAGE)
    expect(frames[1]!.operation).toBe(DANMAKU_OP_HEARTBEAT_REPLY)
  })

  it('stops before a truncated tail instead of reading garbage', () => {
    const packet = encodeDanmakuPacket({ protocolVersion: 0, operation: DANMAKU_OP_MESSAGE, body: '{"cmd":"A"}' })
    const truncated = packet.slice(0, packet.length - 3)
    expect(decodeDanmakuPackets(truncated)).toEqual([])
  })

  it('counts the viewers that a heartbeat reply carries', () => {
    const body = new Uint8Array([0, 0, 4, 210])
    expect(decodeDanmakuPopularity(body)).toBe(1234)
  })

  it.skipIf(!brotliIsSupported())('expands a brotli body into the packets inside it', async () => {
    const inner = encodeDanmakuPacket({ protocolVersion: 0, operation: DANMAKU_OP_MESSAGE, body: '{"cmd":"DANMU_MSG"}' })
    const body = brotliCompressSync(new TextEncoder().encode(new TextDecoder().decode(inner)))
    const socketMessage = encodeDanmakuPacket({ protocolVersion: 3, operation: DANMAKU_OP_MESSAGE, body: new Uint8Array(body) })

    const messages = await readDanmakuSocketMessage(socketMessage)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.operation).toBe(DANMAKU_OP_MESSAGE)
    expect(JSON.parse(new TextDecoder().decode(messages[0]!.body))).toEqual({ cmd: 'DANMU_MSG' })
  })

  it('expands a zlib body into the packets inside it', async () => {
    const inner = encodeDanmakuPacket({ protocolVersion: 0, operation: DANMAKU_OP_MESSAGE, body: '{"cmd":"SEND_GIFT"}' })
    const body = await compressBody(new TextDecoder().decode(inner), 'deflate')
    const socketMessage = encodeDanmakuPacket({ protocolVersion: 2, operation: DANMAKU_OP_MESSAGE, body })

    const messages = await readDanmakuSocketMessage(socketMessage)
    expect(messages).toHaveLength(1)
    expect(JSON.parse(new TextDecoder().decode(messages[0]!.body))).toEqual({ cmd: 'SEND_GIFT' })
  })

  it('passes a plain body through without decompression', async () => {
    const socketMessage = encodeDanmakuPacket({ protocolVersion: 0, operation: DANMAKU_OP_AUTH, body: '{"ok":1}' })
    const messages = await readDanmakuSocketMessage(socketMessage)
    expect(messages).toHaveLength(1)
    expect(JSON.parse(new TextDecoder().decode(messages[0]!.body))).toEqual({ ok: 1 })
  })
})

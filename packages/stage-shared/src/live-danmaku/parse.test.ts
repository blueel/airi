import { describe, expect, it } from 'vitest'

import { parseLiveDanmakuEvent, readDanmakuCommandBody } from './parse'
import { encodeDanmakuPacket } from './protocol'

const danmuMsg = {
  cmd: 'DANMU_MSG:4:0:2:2:2:0',
  info: [
    [0, 1, 0, 0, 0, 0],
    '主播好可爱',
    [12345, '小明', 0, 0, 0, 0, 0, 0, 0],
    [],
  ],
}

const sendGift = {
  cmd: 'SEND_GIFT',
  data: {
    uname: '小明',
    giftName: '小花花',
    num: 2,
    coinType: 'gold',
    price: 100,
    super: 0,
  },
}

const superChat = {
  cmd: 'SUPER_CHAT_MESSAGE',
  data: {
    uname: '老板',
    message: '唱一首歌吧',
    price: 30,
  },
}

function packetBody(payload: unknown) {
  const packet = encodeDanmakuPacket({ protocolVersion: 0, operation: 5, body: JSON.stringify(payload) })
  return packet.slice(16)
}

describe('danmaku commands', () => {
  it('reads a viewer line out of a suffixed DANMU_MSG', () => {
    const event = parseLiveDanmakuEvent(danmuMsg.cmd, danmuMsg)
    expect(event).toEqual({ kind: 'comment', comment: { name: '小明', text: '主播好可爱' } })
  })

  it('prices a gold gift at its worth and a silver one at zero', () => {
    const gold = parseLiveDanmakuEvent(sendGift.cmd, sendGift)
    expect(gold).toEqual({ kind: 'gift', gift: { name: '小明', giftName: '小花花', num: 2, priceCny: 0.2 } })

    const silver = parseLiveDanmakuEvent('SEND_GIFT', { data: { uname: '路人', giftName: '辣条', num: 1, coinType: 'silver', price: 100 } })
    expect(silver).toEqual({ kind: 'gift', gift: { name: '路人', giftName: '辣条', num: 1, priceCny: 0 } })
  })

  it('reads a super chat with its price in CNY', () => {
    const event = parseLiveDanmakuEvent(superChat.cmd, superChat)
    expect(event).toEqual({ kind: 'super-chat', superChat: { name: '老板', text: '唱一首歌吧', priceCny: 30 } })
  })

  it('ignores the rank and watch counter commands', () => {
    expect(parseLiveDanmakuEvent('WATCHED_CHANGE', { data: { num: 100 } })).toBeUndefined()
    expect(parseLiveDanmakuEvent('ONLINE_RANK_COUNT', { data: {} })).toBeUndefined()
    expect(parseLiveDanmakuEvent('INTERACT_WORD', { data: {} })).toBeUndefined()
    expect(parseLiveDanmakuEvent('UNKNOWN_THING', { data: {} })).toBeUndefined()
  })

  it('gives up on a DANMU_MSG without a line', () => {
    expect(parseLiveDanmakuEvent('DANMU_MSG', { info: [0, '', []] })).toBeUndefined()
    expect(parseLiveDanmakuEvent('DANMU_MSG', { nope: true })).toBeUndefined()
  })

  it('reads the command and payload out of a packet body', () => {
    const read = readDanmakuCommandBody(packetBody(danmuMsg))
    expect(read?.cmd).toBe(danmuMsg.cmd)
    expect(read?.payload).toEqual(danmuMsg)

    expect(readDanmakuCommandBody(new TextEncoder().encode('not json'))).toBeUndefined()
    expect(readDanmakuCommandBody(new TextEncoder().encode('{"no_cmd":1}'))).toBeUndefined()
  })
})

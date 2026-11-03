import { describe, expect, it } from 'vitest'

import {
  clampLiveRoomRect,
  LIVE_ROOM_MIN_SIZE,
  liveRoomCommentKey,
  liveRoomCropRegion,
  liveRoomRectFromPoints,
  liveRoomRectIsUsable,
  parseLiveRoomComments,
  selectFreshComments,
} from './live-room'

describe('liveRoomRectFromPoints', () => {
  it('builds a region whichever way the drag went', () => {
    const rect = liveRoomRectFromPoints({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 })
    expect(rect).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.4 })
  })

  it('keeps a region inside the screen', () => {
    expect(clampLiveRoomRect({ x: 0.9, y: 0.8, width: 0.5, height: 0.5 }))
      .toEqual({ x: 0.9, y: 0.8, width: 0.1, height: 0.2 })
  })
})

describe('liveRoomRectIsUsable', () => {
  it('rejects a click and a jitter', () => {
    expect(liveRoomRectIsUsable({ x: 0, y: 0, width: 0, height: 0 })).toBe(false)
    expect(liveRoomRectIsUsable({ x: 0, y: 0, width: LIVE_ROOM_MIN_SIZE / 2, height: 0.4 })).toBe(false)
    expect(liveRoomRectIsUsable(null)).toBe(false)
  })

  it('accepts a region that holds text', () => {
    expect(liveRoomRectIsUsable({ x: 0.1, y: 0.1, width: LIVE_ROOM_MIN_SIZE, height: 0.4 })).toBe(true)
  })
})

describe('liveRoomCropRegion', () => {
  it('translates the region into pixels of the frame', () => {
    expect(liveRoomCropRegion({ x: 0.5, y: 0.25, width: 0.25, height: 0.5 }, 1920, 1080))
      .toEqual({ x: 960, y: 270, width: 480, height: 540 })
  })

  it('keeps a crop inside a frame after rounding', () => {
    const crop = liveRoomCropRegion({ x: 0.99, y: 0.99, width: 0.01, height: 0.01 }, 100, 100)
    expect(crop.x + crop.width).toBeLessThanOrEqual(100)
    expect(crop.y + crop.height).toBeLessThanOrEqual(100)
  })
})

describe('parseLiveRoomComments', () => {
  it('reads the JSON array that the request asks for', () => {
    expect(parseLiveRoomComments('```json\n[{"name":"小明","text":"你好可爱"},{"name":"阿伟","text":"今天播什么"}]\n```'))
      .toEqual([
        { name: '小明', text: '你好可爱' },
        { name: '阿伟', text: '今天播什么' },
      ])
  })

  it('keeps a line without a nickname', () => {
    expect(parseLiveRoomComments('[{"text":"哈哈哈哈"}]')).toEqual([{ name: '', text: '哈哈哈哈' }])
  })

  it('drops entries without text', () => {
    expect(parseLiveRoomComments('[{"name":"小明","text":""},{"name":"阿伟","text":"在吗"}]'))
      .toEqual([{ name: '阿伟', text: '在吗' }])
  })

  it('reads prose lines when the answer is not JSON', () => {
    expect(parseLiveRoomComments('1. 小明：你好可爱\n- 阿伟: 今天播什么'))
      .toEqual([
        { name: '小明', text: '你好可爱' },
        { name: '阿伟', text: '今天播什么' },
      ])
  })

  it('reads an empty answer as no comment', () => {
    expect(parseLiveRoomComments('[]')).toEqual([])
    expect(parseLiveRoomComments('   ')).toEqual([])
  })
})

describe('liveRoomCommentKey', () => {
  it('matches a line that the reader spaced or punctuated differently', () => {
    expect(liveRoomCommentKey({ name: '小明', text: '你好 可爱！' }))
      .toBe(liveRoomCommentKey({ name: ' 小明 ', text: '你好可爱' }))
  })

  it('separates two viewers who write the same line', () => {
    expect(liveRoomCommentKey({ name: '小明', text: '在吗' }))
      .not
      .toBe(liveRoomCommentKey({ name: '阿伟', text: '在吗' }))
  })
})

describe('selectFreshComments', () => {
  it('keeps only the lines that no earlier scan sent, without repeating one inside the same scan', () => {
    const seen = new Set([liveRoomCommentKey({ name: '小明', text: '你好' })])
    expect(selectFreshComments([
      { name: '小明', text: '你好' },
      { name: '阿伟', text: '在吗' },
      { name: '阿伟', text: '在吗 ' },
    ], seen)).toEqual([{ name: '阿伟', text: '在吗' }])
  })
})

import { describe, expect, it } from 'vitest'

import { groupOcrLines } from './local-ocr'

/** One box of a reader, as four corners: top-left, top-right, bottom-right, bottom-left. */
function box(text: string, left: number, top: number, width = 40, height = 16) {
  return {
    text,
    box: [
      [left, top],
      [left + width, top],
      [left + width, top + height],
      [left, top + height],
    ],
  }
}

describe('groupOcrLines', () => {
  it('joins the boxes of one row, left to right', () => {
    expect(groupOcrLines([
      box('你好可爱', 60, 100),
      box('小明', 20, 100),
      box('：', 45, 100, 8),
    ])).toEqual(['小明：你好可爱'])
  })

  it('keeps rows apart', () => {
    expect(groupOcrLines([
      box('阿伟：在吗', 20, 100),
      box('小明：在的', 20, 60),
    ])).toEqual(['小明：在的', '阿伟：在吗'])
  })

  it('keeps the space between two Latin words', () => {
    expect(groupOcrLines([box('world', 60, 0), box('hello', 0, 0)])).toEqual(['hello world'])
  })

  it('drops a box without text', () => {
    expect(groupOcrLines([box('  ', 0, 0), box('在吗', 20, 100)])).toEqual(['在吗'])
  })

  it('reads nothing as no line', () => {
    expect(groupOcrLines([])).toEqual([])
  })
})

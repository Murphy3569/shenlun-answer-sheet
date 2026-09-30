/**
 * 光标映射测试
 *
 * 需求原文：
 *   「如果一个 Token 占 2 格，例如 ——，光标也必须按照逻辑 Token 移动，
 *     不能产生『光标卡在破折号中间』的奇怪状态。」
 */

import { describe, expect, it } from 'vitest'
import { backspaceRange, caretPositionFor, deleteRange, nextStop, offsetForCellPoint, prevStop, snapOffset } from './caret'
import { tokenize } from './tokenizer'
import { createDefaultProfile, withProfile } from './profile'
import { layoutBlock } from './layoutEngine'

const profile = createDefaultProfile()
/** 光标映射测试不关心段首缩进，关掉以免偏移量对不上 */
const plainProfile = withProfile(profile, { autoIndentFirstLine: false })
const tokensOf = (text: string) => tokenize(text, profile)
const layoutOf = (text: string) => layoutBlock({ blockId: 'b', blockTitle: 't', text, capacity: 0 }, plainProfile)

describe('按 Token 对齐的光标移动', () => {
  it('破折号是整体：左移一次直接跨过两个字符', () => {
    const tokens = tokensOf('发展——进步')
    // offset 4 是破折号之后
    expect(prevStop(tokens, 4)).toBe(2)
  })

  it('破折号内部的光标会被吸附到起点', () => {
    const tokens = tokensOf('发展——进步')
    expect(prevStop(tokens, 3)).toBe(2)
    expect(snapOffset(tokens, 3)).toBe(2)
  })

  it('右移跨过破折号', () => {
    const tokens = tokensOf('发展——进步')
    expect(nextStop(tokens, 6, 2)).toBe(4)
  })

  it('省略号同样整体移动', () => {
    const tokens = tokensOf('等等……')
    expect(prevStop(tokens, 4)).toBe(2)
    expect(nextStop(tokens, 4, 2)).toBe(4)
  })

  it('复合标点按字符移动：视觉上并进一格，逻辑上仍是两个字符', () => {
    const tokens = tokensOf('他说：“好”')
    // ：“ 占 offset [2,4)，光标在 4 时左移一格到 3（引号前），不是直接跳到 2
    expect(prevStop(tokens, 4)).toBe(3)
    expect(nextStop(tokens, 8, 2)).toBe(3)
  })

  it('复合标点按输入顺序逐个删除：先打的先删', () => {
    const text = '他说：“好”'
    const tokens = tokensOf(text)

    // 第一次退格：只删掉后打的左引号
    const first = backspaceRange(tokens, 4)
    const afterFirst = text.slice(0, first[0]) + text.slice(first[1])
    expect(afterFirst).toBe('他说：好”')

    // 第二次退格：再删掉冒号
    const tokens2 = tokensOf(afterFirst)
    const second = backspaceRange(tokens2, 3)
    expect(afterFirst.slice(0, second[0]) + afterFirst.slice(second[1])).toBe('他说好”')
  })

  it('数字串按字符移动（方便修改单个数字）', () => {
    const tokens = tokensOf('2026')
    expect(prevStop(tokens, 4)).toBe(3)
    expect(nextStop(tokens, 4, 0)).toBe(1)
  })

  it('删除键删掉整个破折号，不留下半截', () => {
    const text = '发展——进步'
    const tokens = tokensOf(text)
    const [from, to] = deleteRange(tokens, text.length, 2)
    expect(text.slice(0, from) + text.slice(to)).toBe('发展进步')
  })

  it('退格删掉整个省略号', () => {
    const text = '等等……'
    const tokens = tokensOf(text)
    const [from, to] = backspaceRange(tokens, text.length)
    expect(text.slice(0, from) + text.slice(to)).toBe('等等')
  })

  it('退格只删一个数字', () => {
    const text = '2026'
    const tokens = tokensOf(text)
    const [from, to] = backspaceRange(tokens, 4)
    expect(text.slice(0, from) + text.slice(to)).toBe('202')
  })
})

describe('TextOffset → Cell 映射', () => {
  it('文本开头落在第一格', () => {
    const r = layoutOf('你好')
    const pos = caretPositionFor(r.rows, 0)
    expect([pos.rowIndex, pos.column, pos.fraction]).toEqual([0, 0, 0])
  })

  it('文本中间落在对应格', () => {
    const r = layoutOf('你好')
    expect(caretPositionFor(r.rows, 1).column).toBe(1)
  })

  it('文本末尾落在第一个空白补齐格', () => {
    const r = layoutOf('你好')
    const pos = caretPositionFor(r.rows, 2)
    expect([pos.rowIndex, pos.column]).toEqual([0, 2])
  })

  it('多字符格内部的 offset 会落在格内中间位置', () => {
    const r = layoutOf('2026')
    // 第一格显示 "20"，offset 1 在格内一半处
    const pos = caretPositionFor(r.rows, 1)
    expect(pos.column).toBe(0)
    expect(pos.fraction).toBeCloseTo(0.5, 5)
  })

  it('整行写满时光标显示在下一行行首（与文本编辑器一致）', () => {
    const r = layoutOf('字'.repeat(20) + '\n' + '第二行')
    const pos = caretPositionFor(r.rows, 20)
    expect([pos.rowIndex, pos.column]).toEqual([1, 0])
  })

  it('整行写满且没有下一行时，光标停在最后一格右端', () => {
    const r = layoutOf('字'.repeat(20))
    const pos = caretPositionFor(r.rows, 20)
    expect([pos.rowIndex, pos.column]).toEqual([0, 19])
    expect(pos.fraction).toBe(1)
  })

  it('换行之后的光标落在下一行行首', () => {
    const r = layoutOf('第一行\n第二行')
    const pos = caretPositionFor(r.rows, 4)
    expect([pos.rowIndex, pos.column]).toEqual([1, 0])
  })

  it('自动换行处：写满一行后光标进入下一行', () => {
    const r = layoutOf('字'.repeat(21))
    const pos = caretPositionFor(r.rows, 20)
    expect([pos.rowIndex, pos.column]).toEqual([1, 0])
  })

  it('挤占格内 offset 的落点单调递增', () => {
    const r = layoutOf('字'.repeat(20) + '。')
    const before = caretPositionFor(r.rows, 19)
    const after = caretPositionFor(r.rows, 20)
    expect(before.column).toBe(19)
    expect(after.column).toBe(19)
    expect(after.fraction).toBeGreaterThan(before.fraction)
  })
})

describe('点击格子反查 offset', () => {
  it('点在格左边缘取格首 offset', () => {
    const r = layoutOf('你好')
    expect(offsetForCellPoint(r.rows[0].cells[1], 0)).toBe(1)
  })

  it('点在格右边缘取格尾 offset', () => {
    const r = layoutOf('你好')
    expect(offsetForCellPoint(r.rows[0].cells[1], 1)).toBe(2)
  })

  it('点在空白格得到该格的锚点 offset', () => {
    const r = layoutOf('你好')
    expect(offsetForCellPoint(r.rows[0].cells[5], 0.5)).toBe(2)
  })
})

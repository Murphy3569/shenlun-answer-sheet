/**
 * 回归测试：排版引擎与文档模型里几个「静默出错」的地方。
 *
 * 共同点：不崩溃、不报错，只是**结果和输入对不上** ——
 * 少一个字、多画一笔、样式跑到别的段落上。这类问题用户很难自己定位。
 */

import { describe, expect, it } from 'vitest'
import { layoutBlock, run } from './testUtils'
import { LAYOUT_PRESETS, createDefaultProfile, withProfile } from './profile'
import { reconcileParagraphStyles } from '../document/model'
import { findUnsupportedChars } from '../export/pdfFontCharset'
import { normalizeText } from './tokenizer'
import type { ParagraphStyle } from '../document/model'

describe('复合标点被强制拆分', () => {
  it('拆开之后不能把第一个格的字形在第二个格重画一遍，也不能丢字', () => {
    // 每行只给 1 格，'？？？' 横竖放不下 → 只能拆。
    // 拆之前每个格都会把「第一格的字形」再画一次：纸上出现 4 个问号，第三个字无处安放。
    const profile = withProfile(createDefaultProfile(), { columns: 1, autoIndentFirstLine: false })
    const result = layoutBlock({ blockId: 'x', blockTitle: 't', text: '？？？', capacity: 0 }, profile)

    const shown = result.rows.flatMap((r) => r.cells).map((c) => c.display).join('')
    expect(shown, `纸面上显示成了「${shown}」`).toBe('？？？')

    // 每一个源字符都要有格承载
    const covered = new Set<number>()
    for (const row of result.rows) {
      for (const cell of row.cells) {
        if (cell.empty) continue
        for (let o = cell.sourceStart; o < cell.sourceEnd; o++) covered.add(o)
      }
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([0, 1, 2])
  })
})

describe('段落行区间', () => {
  it('最后一段的 endRow 要含住它的最后一行（单行段落不能是空区间）', () => {
    const single = run('你好')
    expect(single.rows.length).toBe(1)
    expect(single.paragraphs[0].endRow).toBe(1)

    const three = run('a\nb\nc')
    const last = three.paragraphs[three.paragraphs.length - 1]
    expect(last.endRow).toBe(three.rows.length)
    expect(last.endRow).toBeGreaterThan(last.startRow)
  })
})

describe('plain 预设', () => {
  it('「一个字符一格」就该数字和字母一个口径', () => {
    const profile = LAYOUT_PRESETS.plain.build()
    const letters = layoutBlock({ blockId: 'x', blockTitle: 't', text: 'GDP', capacity: 0 }, profile)
    const digits = layoutBlock({ blockId: 'x', blockTitle: 't', text: '2026', capacity: 0 }, profile)
    expect(letters.occupiedCellCount, 'GDP 应占 3 格').toBe(3)
    expect(digits.occupiedCellCount, '2026 应占 4 格').toBe(4)
  })
})

describe('删段落时的样式归属', () => {
  const title: ParagraphStyle = { kind: 'title', align: 'center', indentCells: 0 }
  const normal: ParagraphStyle = { kind: 'normal', align: 'left', indentCells: 2 }

  it('删掉上一段后，幸存段落保留自己的样式', () => {
    const oldText = '第一，坚持规划先行。\n第一，坚持规划先行，统筹推进各项任务。'
    const newText = '第一，坚持规划先行，统筹推进各项任务。'
    const out = reconcileParagraphStyles(oldText, [title, normal], newText, true)
    expect(out).toEqual([normal])
  })

  it('两段无共同字面时同样保留（对照）', () => {
    const oldText = '一、总体要求。\n第一，坚持规划先行，统筹推进各项任务。'
    const newText = '第一，坚持规划先行，统筹推进各项任务。'
    const out = reconcileParagraphStyles(oldText, [title, normal], newText, true)
    expect(out).toEqual([normal])
  })
})

describe('从网页 / PDF 粘贴材料带进来的特殊空白', () => {
  it('各种 Unicode 空白要归一成普通空格', () => {
    expect(normalizeText('乡村振兴\u00a0是重点')).toBe('乡村振兴 是重点')
    expect(normalizeText('\u2000\u2001\u2007\u202f\u205f')).toBe('     ')
  })

  it('归一之后不再被判成生僻字（否则整篇导出会退回打印版）', () => {
    // U+00A0 是网页复制最常见的产物：屏幕上看着就是空格，但内置字体没有它的字形。
    // 不做归一的话，导出 PDF 会打印「有 1 个生僻字」并把用户丢进打印对话框。
    expect(findUnsupportedChars('乡村振兴\u00a0是重点').length).toBeGreaterThan(0)
    expect(findUnsupportedChars(normalizeText('乡村振兴\u00a0是重点'))).toEqual([])
  })

  it('用替换而不是删除，字符数不变（光标 offset 不会被挪动）', () => {
    const src = 'a\u00a0b\u2000c'
    expect(normalizeText(src)).toHaveLength(src.length)
  })

  it('全角空格保留 —— 字体有它，方格纸上是有意义的宽度', () => {
    expect(normalizeText('甲\u3000乙')).toBe('甲\u3000乙')
  })
})

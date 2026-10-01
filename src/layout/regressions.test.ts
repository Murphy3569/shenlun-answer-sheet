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


describe('序号共格', () => {
  /** 这一行里每个非空格显示什么（共格的格子显示成一个整体） */
  const shown = (text: string) =>
    run(text).rows.flatMap((r) => r.cells).filter((c) => !c.empty).map((c) => c.display)

  it('行首的序号：收尾符号与序号体共占一格', () => {
    expect(shown('1、加强学习').slice(0, 2)).toEqual(['1、', '加'])
    expect(shown('一、加强学习').slice(0, 2)).toEqual(['一、', '加'])
    expect(shown('1.加强学习').slice(0, 2)).toEqual(['1.', '加'])
    expect(shown('1)加强学习').slice(0, 2)).toEqual(['1)', '加'])
    // 序号后面习惯空一格，那一格是独立的空格
    expect(shown('1. 加强学习').slice(0, 3)).toEqual(['1.', ' ', '加'])
  })

  it('句首的序号也共格 —— 申论里序号多是接着上一句写的', () => {
    const text = '取得了明显成效。1、加强学习'
    const cells = shown(text)
    expect(cells).toContain('。')
    expect(cells).toContain('1、')

    // 关掉开关就该多占一格 —— 证明这一格确实是共格省下来的
    const off = run(text, { profile: withProfile(createDefaultProfile(), { pairListMarker: false }) })
      .rows.flatMap((r) => r.cells)
      .filter((c) => !c.empty)
    expect(off.length).toBe(cells.length + 1)
  })

  it('句首：句末点号与冒号之后都算', () => {
    expect(shown('成效。1、加强学习')).toContain('1、')
    expect(shown('主要有三点：1、加强学习')).toContain('1、')
    expect(shown('真的吗？1、加强学习')).toContain('1、')
  })

  it('★行中的枚举不是序号，绝不共格', () => {
    // 用户给的反例：这里的 1 是数据，不是序号
    const cells = shown('我国石油产量和进口量分别为1、2和3')
    const i = cells.indexOf('1')
    expect(i).toBeGreaterThan(0)
    expect(cells[i + 1]).toBe('、')
    expect(cells[i + 2]).toBe('2')
  })

  it('分号后不算句首（「分别为1、2；3、4」里的 3 是数据）', () => {
    expect(shown('分别为1、2；3、4')).not.toContain('3、')
    expect(shown('分别为1、2；3、4')).not.toContain('1、')
  })

  it('括号序号整组占一格 —— GB/T 15834 B.3.4：括号序次语后不加任何点号', () => {
    expect(shown('（1）想象力').slice(0, 2)).toEqual(['（1）', '想'])
    expect(shown('（一）遵守法律法规').slice(0, 2)).toEqual(['（一）', '遵'])
    expect(shown('(2)直觉的理解力').slice(0, 2)).toEqual(['(2)', '直'])
  })

  it('括号序号紧跟标点时，前括号不能被前面的标点吞掉', () => {
    // 「：（」在复合标点表里，会把序号的开括号吃掉，括号序号就组不起来了
    const afterColon = shown('主要有三点：（1）加强学习')
    expect(afterColon.some((c) => c === '：（')).toBe(false)
    expect(afterColon).toContain('（1）')

    expect(shown('要求如下。（1）遵守法律法规')).toContain('（1）')
    expect(shown('他说：“（1）第一条”')).toContain('（1）')
  })

  it('行中的「1. 2. 3.」也共格 —— 点号没有歧义，不必要求位置', () => {
    // 国标示例本身就是行中连着写的：「1.传递信息……；2.确定关系……」
    const cells = shown('1. 狠抓落实 2. 强化保障 3. 压实责任')
    expect(cells.filter((c) => /^\d\.$/.test(c))).toEqual(['1.', '2.', '3.'])
  })

  it('顿号仍然只认行首/句首 —— 「1、2」里的顿号是并列数据的分隔符', () => {
    // 这是「点号」和「顿号」的关键差别：
    // 数字后面的句点除了当序号终止符几乎没别的可能（小数已被数字 token 吃掉），
    // 而顿号在「分别为1、2」里纯粹是在分隔两个数字。
    expect(shown('分别为1、2和3').some((c) => c === '1、')).toBe(false)
    expect(shown('分别为1、2；3、4').some((c) => c === '3、')).toBe(false)
  })

  it('数字本身的分组不受影响', () => {
    // 小数由数字 token 自己处理，与序号共格无关
    expect(shown('1.5')).toEqual(['1.', '5'])
    // 2026 占两格，不认作序号
    expect(shown('2026.')).toEqual(['20', '26', '.'])
  })
})

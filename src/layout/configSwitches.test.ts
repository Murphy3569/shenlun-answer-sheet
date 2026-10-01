/**
 * 规则开关回归测试
 *
 * 需求原文：「所有规则必须可以配置」—— 更准确地说，**每个开关都必须真的生效**，
 * 不能是写了没人读的死配置。这里逐个开关验证。
 */

import { describe, expect, it } from 'vitest'
import { cellText, firstUsedColumn, rowContent, rowText, usedColumns, run } from './testUtils'
import { withProfile, createDefaultProfile, createStrictGbProfile, createPlainProfile, validateProfile } from './profile'
import type { LayoutProfile } from './types'

const FILLER = '字'.repeat(19)
const FULL = '字'.repeat(20)
const base = createDefaultProfile()

describe('行末策略', () => {
  it('分隔号既禁行首又禁行尾 → 必须挤占，不能落到下一行行首', () => {
    const r = run(FULL + '/')
    expect(usedColumns(r, 0)).toBe(20)
    expect(rowText(r, 0).endsWith('/~')).toBe(true)
    expect(rowContent(r, 1)).toEqual([])
  })

  it('避头下拉不会把「禁行首」的复合标点拖到下一行行首', () => {
    // 第 20 格放着复合标点 。”，后面紧跟句号：挤占不了，也不能把它拖下去
    const r = run(FILLER + '。”' + '。')
    expect(usedColumns(r, 0)).toBe(20)
    // 复合标点仍在原处，没有跑到第二行
    expect(rowText(r, 0).endsWith('。”')).toBe(true)
    expect(r.rules.some((e) => e.type === 'line-end-pull-down')).toBe(false)
  })

  it('普通汉字仍然可以走避头下拉', () => {
    const r = run(FULL + '。', {
      profile: { lineEndStrategy: 'pull-down', endOfLinePunctuationCompression: false },
    })
    expect(usedColumns(r, 0)).toBe(19)
    expect(rowContent(r, 1)).toEqual(['字', '。'])
  })
})

describe('开闭标号的额外开关', () => {
  it('allowOpeningPunctuationAtLineStart=false 时，开引号宁可挤占也不起行', () => {
    const strict = run(FILLER + '“你好”')
    expect(usedColumns(strict, 0)).toBe(19) // 默认：移到下一行行首
    expect(cellText(strict, 1, 0)).toBe('“')

    const squeezed = run(FILLER + '“你好”', { profile: { allowOpeningPunctuationAtLineStart: false } })
    // 开引号挤进第 19 格，腾出来的最后一格留给下一个字
    expect(squeezed.rows[0].cells[18].occupants).toHaveLength(2)
    expect(usedColumns(squeezed, 0)).toBe(20)
    expect(cellText(squeezed, 0, 19)).toBe('你')
    expect(firstUsedColumn(squeezed, 1)).toBe(0)
    expect(cellText(squeezed, 1, 0)).toBe('好')
  })

  it('preventClosingPunctuationAtLineStart=false 时，闭引号允许落到下一行行首', () => {
    const r = run(FULL + '”', { profile: { preventClosingPunctuationAtLineStart: false } })
    expect(usedColumns(r, 0)).toBe(20)
    expect(cellText(r, 1, 0)).toBe('”')
  })
})

describe('数字 / 英文是否可断行', () => {
  it('keepNumberIntact=false 时数字串可以在格边界拆开', () => {
    const at = (p: Partial<LayoutProfile>) => run(FILLER + '2026', { profile: p })
    // 默认：整体挪到下一行
    expect(rowContent(at({}), 1)).toEqual(['20', '26'])
    // 允许拆分：先把 "20" 填进本行，剩下的顺延
    const split = at({ keepNumberIntact: false })
    expect(usedColumns(split, 0)).toBe(20)
    expect(cellText(split, 0, 19)).toBe('20')
    expect(rowContent(split, 1)).toEqual(['26'])
  })

  it('keepEnglishIntact=false 时英文串可以在格边界拆开', () => {
    const r = run(FILLER + 'ABCD', { profile: { keepEnglishIntact: false } })
    expect(usedColumns(r, 0)).toBe(20)
    expect(cellText(r, 0, 19)).toBe('AB')
    expect(rowContent(r, 1)).toEqual(['CD'])
  })
})

describe('占格宽度可配置', () => {
  it('normalPunctuationWidth 改变普通标点的占格数', () => {
    const r = run('好，', { profile: { normalPunctuationWidth: 2 } })
    const punct = r.tokens.find((t) => t.type === 'PUNCT')!
    expect(punct.cellWidth).toBe(2)
    // 汉字 1 格 + 标点 2 格 = 3 格（标点的两个格都显示该字形）
    expect(r.rows[0].cells.slice(0, 3).filter((c) => !c.empty)).toHaveLength(3)
    expect(r.rows[0].cells[1].display).toBe('，')
    expect(r.rows[0].cells[2].display).toBe('，')
  })

  it('dashWidth / ellipsisWidth 改变破折号与省略号的占格数', () => {
    const r = run('——', { profile: { dashWidth: 3 } })
    expect(r.tokens[0].cellWidth).toBe(3)
    const e = run('……', { profile: { ellipsisWidth: 4 } })
    expect(e.tokens[0].cellWidth).toBe(4)
  })
})

describe('自成一格的破折号字符', () => {
  it('U+2E3A 一个字符就占两格且不可拆', () => {
    const r = run('甲⸺乙')
    const dash = r.tokens.find((t) => t.type === 'DASH')!
    expect(dash.rawText).toBe('⸺')
    expect(dash.cellWidth).toBe(2)
    expect(dash.unbreakable).toBe(true)
    expect(usedColumns(r, 0)).toBe(4)
  })
})

describe('复合标点表补全', () => {
  it('闭引号 + 叹号 / 问号 与镜像写法对称地占一格', () => {
    expect(run('好”！').occupiedCellCount).toBe(2)
    expect(run('好”？').occupiedCellCount).toBe(2)
    expect(run('好！”').occupiedCellCount).toBe(2)
  })
})

describe('复合标点开关', () => {
  it('关掉 compoundPunctuation 后一律各占其格', () => {
    const r = run('他说：“好。”', { profile: { compoundPunctuation: false } })
    expect(rowContent(r, 0)).toEqual(['他', '说', '：', '“', '好', '。', '”'])
  })
})

describe('预设', () => {
  it('strictGb 不做任何方格纸压缩，标点一律各占其格', () => {
    const strict = withProfile(createStrictGbProfile(), { autoIndentFirstLine: false })
    const r = run(FULL + '。', { profile: strict })
    expect(usedColumns(r, 0)).toBe(20)
    expect(cellText(r, 1, 0)).toBe('。') // 而不是挤进第 20 格

    const c = run('他说：“好。”', { profile: strict })
    expect(rowContent(c, 0)).toEqual(['他', '说', '：', '“', '好', '。', '”'])
  })

  it('plain 预设：不配对数字、不缩进、不压缩', () => {
    const r = run('2026', { profile: createPlainProfile() })
    expect(rowContent(r, 0)).toEqual(['2', '0', '2', '6'])
  })

  it('pairListMarker：关掉后序号收尾符号不再与前字共格', () => {
    // 表示法见 testUtils.renderCell：同一格里多个占位者用 + 连接，被挤占的加 ~
    const on = run('1、加强学习')
    expect(rowContent(on, 0).slice(0, 2)).toEqual(['1+、~', '加'])

    const off = run('1、加强学习', { profile: withProfile(base, { pairListMarker: false }) })
    expect(rowContent(off, 0).slice(0, 3)).toEqual(['1', '、', '加'])
  })
})

describe('默认 profile 的完整性', () => {
  it('validateProfile 通过', () => {
    expect(validateProfile(base)).toEqual([])
  })

  it('错误配置能被校验出来', () => {
    expect(validateProfile(withProfile(base, { columns: 0 })).length).toBeGreaterThan(0)
    expect(validateProfile(withProfile(base, { arabicDigitsPerCell: 0 })).length).toBeGreaterThan(0)
  })
})

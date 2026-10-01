// @vitest-environment node
/**
 * 行末共格这一格的绘制
 *
 * 这一格是整张答题卡上最容易画糊的地方：一个格子里要塞下「正文 + 尾随标点」，
 * 极端情况还要塞下三个标点。这里用几何断言把它钉死：
 *   · 标点必须够大（相对字号不低于 0.5），否则渲染出来发灰看不清
 *   - 正文与标点的墨迹范围不能互相压住
 *   - 多个标点之间也不能互相压住
 */

import { describe, expect, it } from 'vitest'
import { buildCellGlyphs } from './cellGlyphs'
import { buildCompoundRules, resolveCompoundRule } from '../layout'
import type { Cell, CellOccupant, Token } from '../layout'
import { inkMetricsOf } from './cellGlyphs'
import { __setMetricsForTest, glyphInkMetrics } from './glyphMetrics'

/**
 * 注入一套**真实的**墨迹度量（取自 Noto Serif SC 的实测值），
 * 这样在没有 canvas 的 node 测试环境里也能验证布局几何。
 * 真实浏览器里这些值是 canvas 现场量出来的，见 glyphMetrics.ts。
 */
const METRICS: Record<string, { offsetXEm: number; offsetYEm: number; inkWidthEm: number; inkHeightEm: number }> = {
  // offsetYEm 为正表示墨迹中心在元素中心**下方**
  '。': { offsetXEm: -0.318, offsetYEm: 0.36, inkWidthEm: 0.28, inkHeightEm: 0.28 },
  '，': { offsetXEm: -0.348, offsetYEm: 0.46, inkWidthEm: 0.15, inkHeightEm: 0.31 },
  '、': { offsetXEm: -0.336, offsetYEm: 0.375, inkWidthEm: 0.25, inkHeightEm: 0.25 },
  '”': { offsetXEm: -0.247, offsetYEm: -0.29, inkWidthEm: 0.35, inkHeightEm: 0.28 },
  '？': { offsetXEm: -0.254, offsetYEm: 0.04, inkWidthEm: 0.42, inkHeightEm: 0.78 },
  '！': { offsetXEm: -0.252, offsetYEm: 0.03, inkWidthEm: 0.11, inkHeightEm: 0.78 },
  '“': { offsetXEm: 0.248, offsetYEm: -0.29, inkWidthEm: 0.35, inkHeightEm: 0.28 },
  '字': { offsetXEm: 0, offsetYEm: -0.08, inkWidthEm: 0.9, inkHeightEm: 0.88 },
  '—': { offsetXEm: -0.055, offsetYEm: 0.155, inkWidthEm: 0.8, inkHeightEm: 0.05 },
  '2': { offsetXEm: 0, offsetYEm: 0, inkWidthEm: 0.5, inkHeightEm: 0.64 },
  '0': { offsetXEm: 0, offsetYEm: 0, inkWidthEm: 0.5, inkHeightEm: 0.64 },
  '6': { offsetXEm: 0, offsetYEm: 0, inkWidthEm: 0.5, inkHeightEm: 0.64 },
  '1': { offsetXEm: -0.02, offsetYEm: 0, inkWidthEm: 0.34, inkHeightEm: 0.64 },
  '.': { offsetXEm: -0.22, offsetYEm: 0.36, inkWidthEm: 0.14, inkHeightEm: 0.14 },
}
for (const [ch, m] of Object.entries(METRICS)) __setMetricsForTest('serif', ch, m)

const compoundRules = buildCompoundRules()

function token(id: number, rawText: string, type: Token["type"] = "CHAR", compoundKey?: string): Token {
  return {
    id,
    type,
    charClass: 'CJK',
    rawText,
    sourceStart: id,
    sourceEnd: id + rawText.length,
    cellWidth: 1,
    unbreakable: false,
    caretAtomic: false,
    ...(compoundKey ? { compoundKey } : {}),
  }
}

function cellOf(occupants: CellOccupant[]): Cell {
  return {
    row: 0,
    rowInPanel: 0,
    column: 0,
    occupants,
    sourceStart: 0,
    sourceEnd: 1,
    display: '',
    empty: false,
    paragraph: 0,
    overflow: false,
  }
}

const normal = (id: number, rawText: string): CellOccupant => ({
  tokenId: id,
  sliceStart: 0,
  sliceEnd: rawText.length,
  render: 'normal',
})
const squeezed = (id: number, rawText: string): CellOccupant => ({
  tokenId: id,
  sliceStart: 0,
  sliceEnd: rawText.length,
  render: 'squeezed',
})
const marker = (id: number, rawText: string): CellOccupant => ({
  tokenId: id,
  sliceStart: 0,
  sliceEnd: rawText.length,
  render: 'marker',
})

/** 字形在格内实际占的墨迹范围（用锚点把字身框换算回墨迹中心） */
function inkBox(g: { text: string; x: number; y: number; scale: number }) {
  const m = inkMetricsOf(g.text)
  const fontSize = 0.76 * g.scale
  const inkX = g.x / 100 + m.offsetXEm * fontSize
  const inkY = g.y / 100 + m.offsetYEm * fontSize
  const halfW = (m.inkWidthEm * fontSize) / 2
  const halfH = (m.inkHeightEm * fontSize) / 2
  return { x0: inkX - halfW, x1: inkX + halfW, y0: inkY - halfH, y1: inkY + halfH, inkX, inkY }
}

function overlaps(a: ReturnType<typeof inkBox>, b: ReturnType<typeof inkBox>): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

describe('普通格保持原样', () => {
  it('独立占格的标点居中画（墨迹自然落在它在这套字体里的书写位置）', () => {
    const tokens = new Map([
      [1, token(1, '。', 'PUNCT')],
      [2, token(2, '“', 'OPEN_PUNCT')],
    ])
    const comma = buildCellGlyphs(cellOf([normal(1, '。')]), tokens, compoundRules)[0]
    const quote = buildCellGlyphs(cellOf([normal(2, '“')]), tokens, compoundRules)[0]
    // 元素居中（不做任何偏移）
    expect([comma.x, comma.y]).toEqual([50, 50])
    expect([quote.x, quote.y]).toEqual([50, 50])
    // 但墨迹落点不同：句号在左下、开引号在右上
    expect(inkBox(comma).inkX).toBeLessThan(0.4)
    expect(inkBox(comma).inkY).toBeGreaterThan(0.6)
    expect(inkBox(quote).inkX).toBeGreaterThan(0.6)
    expect(inkBox(quote).inkY).toBeLessThan(0.4)
  })

  it('单个汉字居中、不缩放', () => {
    const [g] = buildCellGlyphs(cellOf([normal(1, '字')]), new Map([[1, token(1, '字')]]), compoundRules)
    expect(g.className).toBe('glyph')
    expect(g.scale).toBe(1)
    expect([g.x, g.y]).toEqual([50, 50])
  })

  it('两个标点时逐个排开、互不重叠，且都不压住正文', () => {
    const tokens = new Map([
      [1, token(1, '字')],
      [2, token(2, '。”', 'COMPOUND_PUNCT', '。”')],
    ])
    const glyphs = buildCellGlyphs(cellOf([normal(1, '字'), squeezed(2, '。”')]), tokens, compoundRules)
    expect(glyphs).toHaveLength(3)

    const boxes = glyphs.map(inkBox)
    for (const g of glyphs) expect(g.scale).toBeGreaterThanOrEqual(0.5)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j]), `第 ${i} 个和第 ${j} 个字形叠住了`).toBe(false)
      }
    }
    // 先输入的句号在下、后输入的右引号在上
    const period = inkBox(glyphs.find((g) => g.text === '。')!)
    const quote = inkBox(glyphs.find((g) => g.text === '”')!)
    expect(period.inkY).toBeGreaterThan(quote.inkY)
  })

  it('三个标点也排得开（？！” 这种极端情况）', () => {
    const tokens = new Map([
      [1, token(1, '字')],
      [2, token(2, '？！”', 'COMPOUND_PUNCT', '？！”')],
    ])
    const glyphs = buildCellGlyphs(cellOf([normal(1, '字'), squeezed(2, '？！”')]), tokens, compoundRules)
    expect(glyphs).toHaveLength(4)
    expect(glyphs.every((g) => g.scale >= 0.5)).toBe(true)

    const boxes = glyphs.map(inkBox)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j]), `第 ${i} 个和第 ${j} 个字形叠住了`).toBe(false)
      }
    }
  })

  it('被压缩的破折号与标点共格时同样排得开', () => {
    const tokens = new Map([
      [1, token(1, '——', 'DASH')],
      [2, token(2, '。', 'PUNCT')],
    ])
    const cell = cellOf([
      { tokenId: 1, sliceStart: 0, sliceEnd: 2, render: 'compressed' },
      squeezed(2, '。'),
    ])
    const glyphs = buildCellGlyphs(cell, tokens, compoundRules)
    const compressed = glyphs.find((g) => g.className.includes('glyph--compressed'))
    expect(compressed).toBeTruthy()
    const punct = glyphs.find((g) => g.className === 'attach')
    expect(punct).toBeTruthy()
    expect(overlaps(inkBox(compressed!), inkBox(punct!))).toBe(false)
  })

  it('所有字形的墨迹都落在格子内（不会被 overflow 裁掉）', () => {
    const cases: Array<[string, string]> = [
      ['字', '。'],
      ['字', '，”'],
      ['字', '？！”'],
      ['2026', '。'],
    ]
    for (const [mainText, punctText] of cases) {
      const mainType = mainText === '2026' ? 'NUMBER' : 'CHAR'
      const tokens = new Map([
        [1, token(1, mainText, mainType)],
        [2, token(2, punctText, 'COMPOUND_PUNCT', punctText)],
      ])
      const cell = cellOf([
        { tokenId: 1, sliceStart: 0, sliceEnd: mainText.length, render: 'normal' },
        squeezed(2, punctText),
      ])
      for (const g of buildCellGlyphs(cell, tokens, compoundRules)) {
        const box = inkBox(g)
        expect(box.inkX, `${mainText}+${punctText} 的「${g.text}」跑到格子外了`).toBeGreaterThan(0.05)
        expect(box.inkX).toBeLessThan(0.95)
        expect(box.inkY).toBeGreaterThan(0.05)
        expect(box.inkY).toBeLessThan(0.95)
      }
    }
  })
})

describe('序号格子', () => {
  const glyphsOf = (bodyText: string, tailText: string) =>
    buildCellGlyphs(
      cellOf([normal(0, bodyText), marker(1, tailText)]),
      new Map([
        [0, token(0, bodyText, 'NUMBER')],
        [1, token(1, tailText, 'PUNCT')],
      ]),
      compoundRules,
    )
  const byText = (gs: ReturnType<typeof glyphsOf>, t: string) => gs.find((g) => g.text === t)!

  it('放得下就整串一个文本串 —— 和小数（1.5 → [1.][5]）同一套', () => {
    const g = glyphsOf('1', '.')
    expect(g, '应该只画一个字形').toHaveLength(1)
    expect(g[0].text).toBe('1.')
    expect(g[0].scale, '放得下就该保持原大小').toBe(1)
  })

  it('放不下时分区画：序号体保持接近正文的大小', () => {
    // 「一、」是两个全角字，整串等比缩小会把它压到 0.62。
    // 顿号的墨迹只占字身框约 25%，跟着一起缩等于白白浪费右边一大块。
    const g = glyphsOf('一', '、')
    expect(g, '应该分成两段').toHaveLength(2)
    const body = byText(g, '一')
    const tail = byText(g, '、')
    expect(body.scale, `序号体只有 ${body.scale.toFixed(2)}，太小了`).toBeGreaterThan(0.8)
    expect(tail.scale, '收尾符号应该明显小于序号体').toBeLessThan(body.scale * 0.85)
  })

  it('分区之后两段不重叠、都不出格', () => {
    for (const [body, tail] of [['一', '、'], ['二', '、'], ['1', '、'], ['2', '）']]) {
      const g = glyphsOf(body, tail)
      const boxes = g.map((x) => inkBox(x))
      for (let i = 1; i < boxes.length; i++) {
        expect(boxes[i].x0, `${body}${tail} 的两段压在一起了`).toBeGreaterThan(boxes[i - 1].x1)
      }
      for (const b of boxes) {
        expect(b.x0, `${body}${tail} 左边出格`).toBeGreaterThan(-0.02)
        expect(b.x1, `${body}${tail} 右边出格`).toBeLessThan(1.02)
      }
    }
  })
})

describe('括号序号：分区画，不整串等比缩小', () => {
  // 括号本来就窄（墨迹只占字身框约三成），跟数字一起缩会让数字小得看不清。
  // 所以两侧窄段放括号、中间宽段放序号体，各自定字号。
  const rule = resolveCompoundRule(buildCompoundRules(), '（一）')!

  it('规则把格子分成三段，序号体明显大于括号', () => {
    expect(rule.glyphs, '应该是三段').toHaveLength(3)
    const [left, body, right] = rule.glyphs
    expect(body.scale, '序号体应该比括号大').toBeGreaterThan(left.scale * 1.2)
    expect(left.scale).toBe(right.scale)
    // 三段从左到右排开
    expect(left.x).toBeLessThan(body.x)
    expect(body.x).toBeLessThan(right.x)
  })

  it('三段互不重叠，也不出格', () => {
    const boxes = rule.glyphs.map((g) => {
      const text = rule.key.slice(g.start, g.end)
      const m = glyphInkMetrics(text)
      const fontSize = 0.76 * g.scale
      const halfW = (m.inkWidthEm * fontSize) / 2
      return { x0: g.x - halfW, x1: g.x + halfW }
    })
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].x0, `第 ${i} 段压到了前一段`).toBeGreaterThan(boxes[i - 1].x1)
    }
    expect(boxes[0].x0).toBeGreaterThan(0)
    expect(boxes[boxes.length - 1].x1).toBeLessThan(1)
  })

  it('两位数序号要缩得比一位数小 —— 中间段就那么宽', () => {
    const one = resolveCompoundRule(buildCompoundRules(), '（1）')!
    const two = resolveCompoundRule(buildCompoundRules(), '（12）')!
    expect(two.glyphs[1].scale).toBeLessThan(one.glyphs[1].scale)
    // 两位数整段不能超出中间段（两侧还要留给括号）
    expect(2 * 0.76 * two.glyphs[1].scale).toBeLessThanOrEqual(0.65)
  })
})

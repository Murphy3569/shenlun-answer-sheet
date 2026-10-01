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
import { buildCompoundRules } from '../layout'
import type { Cell, CellOccupant, Token } from '../layout'
import { inkMetricsOf } from './cellGlyphs'
import { __setMetricsForTest } from './glyphMetrics'

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

  it('序号体保持原大小 —— 不能被缩小让位给标点', () => {
    // 用户明确反馈过「数字有点小」：行末共格那套会把正文缩到 0.8
    for (const [body, tail] of [['2', '、'], ['1', '.'], ['2', '、']]) {
      const bodyGlyph = glyphsOf(body, tail).find((g) => g.text === body)!
      expect(bodyGlyph, `${body}${tail} 没找到序号体`).toBeTruthy()
      expect(bodyGlyph.scale, `${body}${tail} 的序号体被缩小了`).toBe(1)
    }
  })

  it('收尾符号紧挨着序号体右边，不飘到格子角落', () => {
    const glyphs = glyphsOf('2', '、')
    const body = inkBox(glyphs.find((g) => g.text === '2')!)
    const tail = inkBox(glyphs.find((g) => g.text === '、')!)
    const gap = tail.x0 - body.x1
    expect(gap, '序号体和标点压在一起了').toBeGreaterThan(-0.02)
    expect(gap, `数字和顿号之间空了 ${(gap * 100).toFixed(0)}% 格`).toBeLessThan(0.08)
    expect(tail.x1, '收尾符号出格了').toBeLessThan(1)
  })

  it('序号里的点和小数里的点一样紧（两者该长得一样）', () => {
    // 小数：数字和点是同一个 token 的两个字符，参照它的间距
    const glyphs = glyphsOf('1', '.')
    const body = inkBox(glyphs.find((g) => g.text === '1')!)
    const tail = inkBox(glyphs.find((g) => g.text === '.')!)
    const gap = tail.x0 - body.x1
    expect(gap).toBeGreaterThan(-0.02)
    expect(gap, `1 和 . 之间空了 ${(gap * 100).toFixed(0)}% 格`).toBeLessThan(0.06)
  })
})

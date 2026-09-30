/**
 * 格内字形的视觉排布
 *
 * 逻辑层（Token）只决定「哪些字在哪个格」，这里决定「字在格子里画在哪」。
 *
 * ⚠️ 关键概念：**墨迹锚点（ink anchor）**
 *
 * 全角标点的字形在设计上就把墨迹画在字身框的特定角落 —— 句号在左下、开引号在右上、
 * 闭引号在左上。所以「把字形居中画进格子」得到的**就已经是**正确的书写位置。
 *
 * 之前这里是「居中 + 再按经验偏移一次」，等于把字体的偏移叠加了两遍，
 * 结果句号、逗号被推到格子边框上，看起来像显示不全。
 *
 * 现在统一成：**先声明想让墨迹落在格子的哪个位置（ink 目标点），
 * 再由锚点表反推出字身框该摆在哪**。独立占格时目标点就是自然位置（= 居中），
 * 复合标点、挤占时才需要真正挪位置。
 */

import { CLOSE_PUNCT_CHARS, OPEN_PUNCT_CHARS, PUNCT_END_CHARS, PUNCT_INNER_CHARS, SEPARATOR_CHARS } from '../layout'
import { glyphInkMetrics } from './glyphMetrics'
import type { Cell, CellOccupant, CompoundRule, Token } from '../layout'

/** 普通字形相对格子的基准字号（与 sheet.css 里 .glyph 的 font-size 保持一致） */
const BASE_FONT_SIZE = 0.76

export interface GlyphRender {
  key: string
  text: string
  /** 字身框中心在格内的百分比坐标（已按墨迹锚点换算好） */
  x: number
  y: number
  scale: number
  className: string
}

/**
 * 把「想让墨迹落在格内哪个点」换算成「元素中心该摆在哪」。
 *
 * 元素是整格大小、内部用 flex 居中，所以元素中心 = 文字居中摆放时的中心；
 * 再减去实测出来的「墨迹中心相对该中心的偏移」即可。
 *
 * @param inkX 目标墨迹横坐标（0~1，格内比例）
 * @param inkY 目标墨迹纵坐标（0~1）
 * @param text 该字形文本（用来查实测度量）
 * @param fontSize 字号（相对格子的比例）
 */
function boxForInk(inkX: number, inkY: number, text: string, fontSize: number): { x: number; y: number } {
  const m = glyphInkMetrics(text)
  return {
    x: clamp01(inkX - m.offsetXEm * fontSize),
    y: clamp01(inkY - m.offsetYEm * fontSize),
  }
}

function clamp01(v: number): number {
  return Math.max(-0.6, Math.min(1.6, v))
}

/**
 * 「行末共格」专用布局：这一格里既有正文（汉字/数字/压缩标号）又有标点。
 *
 * 普通格子的正文居中画；共格时必须把正文缩小让到左上，把右下腾给标点。
 * 约定：
 *   · mainInk   —— 正文墨迹的目标位置（0~1）
 *   · mainScale / glyphScale —— 相对基准字号（0.76 格）的倍率
 *   · slots     —— 尾随标点的墨迹落点，从下往上排：
 *                  第 1 个标点在最下面，依次往上，这样「。”」永远是句号在下、右引号在上
 *   · 最多排 3 个标点，再多就真挤了（真实作答基本不会出现）
 */
const SQUEEZE_LAYOUTS: Record<number, {
  /** 正文可以缩小，但仍然上下居中 */
  mainScale: number
  /** 正文墨迹的期望落点（会被夹紧，保证不出格、不压到标点列） */
  mainInk: [number, number]
  glyphScale: number
}> = {
  1: { mainScale: 0.80, mainInk: [0.34, 0.5], glyphScale: 0.84 },
  2: { mainScale: 0.72, mainInk: [0.32, 0.5], glyphScale: 0.78 },
  3: { mainScale: 0.64, mainInk: [0.30, 0.5], glyphScale: 0.70 },
}

function isPositionablePunct(ch: string): boolean {
  return (
    PUNCT_END_CHARS.includes(ch) ||
    PUNCT_INNER_CHARS.includes(ch) ||
    OPEN_PUNCT_CHARS.includes(ch) ||
    CLOSE_PUNCT_CHARS.includes(ch) ||
    SEPARATOR_CHARS.includes(ch)
  )
}

/**
 * 把一个格子的占位者翻译成待渲染的字形列表。
 *
 * @param compoundRules 复合标点表（挤占时要把组合的字形映射到右上角小区）
 */
export function buildCellGlyphs(
  cell: Cell,
  tokensById: Map<number, Token>,
  compoundRules: Record<string, CompoundRule>,
): GlyphRender[] {
  const out: GlyphRender[] = []

  const push = (key: string, text: string, inkX: number, inkY: number, scale: number, className: string) => {
    const fontSize = BASE_FONT_SIZE * scale
    const box = boxForInk(inkX, inkY, text, fontSize)
    out.push({ key, text, x: box.x * 100, y: box.y * 100, scale, className })
  }

  // ---- 先把这一格的内容分成「正文」和「被挤进来的尾随标点」 ----
  const primaries: Array<{ key: string; text: string; compressed: boolean }> = []
  const trailing: string[] = []

  cell.occupants.forEach((occupant, oi) => {
    const token = tokensById.get(occupant.tokenId)
    if (!token) return
    const text = token.rawText.slice(occupant.sliceStart, occupant.sliceEnd)

    if (occupant.render === 'squeezed') {
      // 复合标点要拆成单个字形分别落位，普通标点就是一个字形
      const rule = token.type === 'COMPOUND_PUNCT' && token.compoundKey ? compoundRules[token.compoundKey] : undefined
      if (rule) {
        for (const g of rule.glyphs) trailing.push(token.rawText.slice(g.start, g.end))
      } else {
        trailing.push(text)
      }
      return
    }
    primaries.push({ key: `${oi}`, text, compressed: occupant.render === 'compressed' })
  })

  // ---- 没有尾随标点：按原来的画法 ----
  if (trailing.length === 0) {
    cell.occupants.forEach((occupant, oi) => {
      const token = tokensById.get(occupant.tokenId)
      if (!token) return
      const text = token.rawText.slice(occupant.sliceStart, occupant.sliceEnd)

      if (occupant.render === 'compressed') {
        out.push({ key: `${oi}`, text, x: 50, y: 50, scale: 1, className: 'glyph glyph--compressed' })
        return
      }
      // 复合标点：组合表里的 x/y 就是「墨迹想落在哪」
      if (cell.occupants.length === 1 && cell.glyphs && cell.glyphs.length > 0) {
        cell.glyphs.forEach((g, gi) => {
          push(`${oi}-${gi}`, token.rawText.slice(g.start, g.end), g.x, g.y, g.scale, 'glyph glyph--positioned')
        })
        return
      }
      // 独立占格的单个标点：居中画，墨迹自然落在它在这套字体里的书写位置
      if (text.length === 1 && isPositionablePunct(text) && token.type !== 'NUMBER') {
        out.push({ key: `${oi}`, text, x: 50, y: 50, scale: 0.98, className: 'glyph' })
        return
      }
      out.push({ key: `${oi}`, text, x: 50, y: 50, scale: 1, className: 'glyph' })
    })
    return out
  }

  // ---- 有尾随标点：走「行末共格」专用布局 ----
  //
  // 不用固定槽位，而是按**实测的墨迹尺寸**排：
  //   · 标点排成右侧一列，竖直方向按各自墨迹高度等分，保证互不重叠、上下都不出格；
  //   · 正文让到左侧，它的墨迹右边缘不越过标点列的左边界；
  //   · 横向再夹一次，任何墨迹都不会被格子边框裁掉。
  const level = Math.min(trailing.length, 3)
  const layout = SQUEEZE_LAYOUTS[level]
  const mainFontSize = BASE_FONT_SIZE * layout.mainScale

  const columnX = 0.74
  const columnTop = 0.06
  const columnBottom = 0.94
  const available = columnBottom - columnTop

  // 上下位置由标点**自身的天然位置**决定，而不是输入顺序：
  // 「。」的墨迹天然在字身框下方、「”」天然在上方，所以不管是先打句号还是先打引号，
  // 排出来都应该是「引号在上、句号在下」。这正是中文标点书写的样子。
  const naturalBand = (text: string) => {
    const m = glyphInkMetrics(text)
    // 归一成 -1（天然靠上）~ +1（天然靠下）的粗档位；同一档保持输入顺序
    return Math.round(m.offsetYEm / 0.15)
  }
  const ordered = trailing
    .map((text, index) => ({ text, index, band: naturalBand(text) }))
    .sort((a, b) => a.band - b.band || a.index - b.index)

  const buildMarks = (scale: number) =>
    ordered.map((item) => {
      const m = glyphInkMetrics(item.text)
      return {
        key: `${item.index}`,
        text: item.text,
        band: item.band,
        m,
        halfW: (m.inkWidthEm * BASE_FONT_SIZE * scale) / 2,
        halfH: (m.inkHeightEm * BASE_FONT_SIZE * scale) / 2,
      }
    })

  // 先按名义字号量一遍；三个标点（比如 ？！ + 闭引号）总高会超出这一列，那就整体缩小
  let glyphScale = layout.glyphScale
  let markBoxes = buildMarks(glyphScale)
  let totalInk = markBoxes.reduce((sum, b) => sum + b.halfH * 2, 0)
  if (totalInk > available) {
    glyphScale *= (available / totalInk) * 0.98
    markBoxes = buildMarks(glyphScale)
    totalInk = markBoxes.reduce((sum, b) => sum + b.halfH * 2, 0)
  }

  // 竖直排布：
  //   · 只有一个标点时，按它的天然位置靠上或靠下（不硬塞在中间）；
  //   · 有两个以上时，最上面的顶到上沿、最下面的顶到下沿，中间平均分 —— 上下撑开更清楚。
  const slack = Math.max(0, available - totalInk)
  const gap = markBoxes.length > 1 ? slack / (markBoxes.length - 1) : 0
  let cursor = columnTop
  markBoxes.forEach((box) => {
    let inkY: number
    if (markBoxes.length === 1) {
      inkY = box.band < 0 ? columnTop + box.halfH + 0.06 : columnBottom - box.halfH - 0.06
    } else {
      cursor += box.halfH
      inkY = cursor
      cursor += box.halfH + gap
    }
    const inkX = Math.min(Math.max(columnX, 0.04 + box.halfW), 0.96 - box.halfW)
    push(`t${box.key}`, box.text, inkX, inkY, glyphScale, 'attach')
  })

  // 正文：让到左侧，右边缘不越过标点列
  const markLeftEdge = Math.min(...markBoxes.map((b) => columnX - b.halfW))
  primaries.forEach((p) => {
    const m = glyphInkMetrics(p.text)
    const halfW = (m.inkWidthEm * mainFontSize) / 2
    const halfH = (m.inkHeightEm * mainFontSize) / 2
    const inkX = Math.min(layout.mainInk[0], markLeftEdge - 0.02 - halfW)
    const inkY = Math.min(Math.max(layout.mainInk[1], 0.04 + halfH), 0.96 - halfH)
    const className = p.compressed ? 'glyph glyph--compressed' : 'glyph glyph--positioned'
    push(p.key, p.text, Math.max(0.04 + halfW, inkX), inkY, layout.mainScale, className)
  })

  return out
}

/** 该格是否为「空格」占位（屏幕上给个淡淡的小圈提示，打印不会出现） */
export function isSpaceCell(cell: Cell, tokensById: Map<number, Token>): boolean {
  if (cell.empty || cell.occupants.length !== 1) return false
  const token = tokensById.get(cell.occupants[0].tokenId)
  return token?.type === 'SPACE'
}

/** 供测试与调试：查询某个字形的实测墨迹度量 */
export function inkMetricsOf(text: string) {
  return glyphInkMetrics(text)
}

export type { CellOccupant }

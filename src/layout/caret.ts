/**
 * 光标映射：文本 offset ↔ 答题格
 *
 * 因为视觉上不是普通文本，光标必须建立四层映射：
 *
 *   TextOffset → Token → Cell → Row → Panel/Page
 *
 * 关键约定：
 *   · 光标停在某个 offset，等于停在「第 offset 个字符之前」。
 *   · 光标渲染位置 = 第一个覆盖该 offset 的格；找不到则第一个 sourceStart >= offset 的格。
 *   · 破折号 / 省略号 / 复合标点是 caretAtomic，方向键与退格必须整体跨越，
 *     绝不允许光标卡在 "——" 中间。
 */

import type { Cell, Row, Token } from './types'

export interface CaretPosition {
  rowIndex: number
  column: number
  /** 格内水平位置 0~1 */
  fraction: number
  /** 命中格在 rows 中的下标；-1 表示没找到（空文档） */
  cellIndex: number
}

const EMPTY: CaretPosition = { rowIndex: 0, column: 0, fraction: 0, cellIndex: -1 }

/** 文本 offset → 光标在答题卡上的位置 */
export function caretPositionFor(rows: Row[], offset: number): CaretPosition {
  if (rows.length === 0) return EMPTY

  // 第一遍：找覆盖该 offset 的格（含多字符格、复合标点格、被挤占的格）
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].cells
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]
      if (cell.sourceStart <= offset && offset < cell.sourceEnd) {
        const span = cell.sourceEnd - cell.sourceStart
        return {
          rowIndex: r,
          column: c,
          fraction: span > 0 ? (offset - cell.sourceStart) / span : 0,
          cellIndex: r * cells.length + c,
        }
      }
    }
  }

  // 第二遍：找第一个起点不早于 offset 的格（文本末尾 / 空白格）
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].cells
    for (let c = 0; c < cells.length; c++) {
      if (cells[c].sourceStart >= offset) {
        return { rowIndex: r, column: c, fraction: 0, cellIndex: r * cells.length + c }
      }
    }
  }

  // 兜底：文本末尾之后没有任何格 → 停在最后一格右端
  const lastRow = rows.length - 1
  const lastCol = rows[lastRow].cells.length - 1
  return { rowIndex: lastRow, column: Math.max(0, lastCol), fraction: 1, cellIndex: -1 }
}

/** 点击格内某点 → 文本 offset */
export function offsetForCellPoint(cell: Cell, fraction: number): number {
  const span = cell.sourceEnd - cell.sourceStart
  if (span <= 0) return cell.sourceStart
  const clamped = Math.max(0, Math.min(1, fraction))
  return cell.sourceStart + Math.round(clamped * span)
}

/** 找到包含 offset 的 Token（offset 落在 [start, end) 内） */
function tokenAt(tokens: Token[], offset: number): Token | null {
  for (const t of tokens) {
    if (t.type === 'LINE_BREAK') continue
    if (t.sourceStart <= offset && offset < t.sourceEnd) return t
  }
  return null
}

/** 方向键左移：整体跳过原子 Token */
export function prevStop(tokens: Token[], offset: number): number {
  if (offset <= 0) return 0
  const target = offset - 1
  const t = tokenAt(tokens, target)
  if (t && t.caretAtomic && t.sourceStart < offset) return t.sourceStart
  return target
}

/** 方向键右移：整体跳过原子 Token */
export function nextStop(tokens: Token[], textLength: number, offset: number): number {
  if (offset >= textLength) return textLength
  const t = tokenAt(tokens, offset)
  if (t && t.caretAtomic) return Math.min(t.sourceEnd, textLength)
  return offset + 1
}

/**
 * 把任意 offset 吸附到最近的原子边界（用于鼠标点击后校正）。
 * 正好落在中点时向前吸附 —— 与「点击靠左半边取格首」的直觉一致。
 */
export function snapOffset(tokens: Token[], offset: number): number {
  const t = tokenAt(tokens, offset)
  if (!t || !t.caretAtomic) return offset
  return 2 * offset <= t.sourceStart + t.sourceEnd ? t.sourceStart : t.sourceEnd
}

/** 一次退格要删掉的区间 [from, to) */
export function backspaceRange(tokens: Token[], offset: number): [number, number] {
  return [prevStop(tokens, offset), offset]
}

/** 一次删除键要删掉的区间 [from, to) */
export function deleteRange(tokens: Token[], textLength: number, offset: number): [number, number] {
  return [offset, nextStop(tokens, textLength, offset)]
}

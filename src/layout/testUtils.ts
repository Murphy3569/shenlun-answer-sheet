/**
 * 测试辅助：把排版结果渲染成可读字符串，便于断言。
 * 仅被 *.test.ts 引用，不进生产包。
 */

import { layoutBlock } from './layoutEngine'
import { createDefaultProfile, withProfile } from './profile'
import type { BlockLayoutResult } from './types'
import type { LayoutProfile } from './types'

export { layoutBlock }

export interface LayoutOpts {
  columns?: number
  capacity?: number
  profile?: Partial<LayoutProfile>
  paragraphs?: Parameters<typeof layoutBlock>[0]['paragraphs']
  /** 是否启用正文段首缩进（默认关闭，让断行用例不受缩进干扰） */
  indent?: boolean
}

export function run(text: string, opts: LayoutOpts = {}): BlockLayoutResult {
  const base = createDefaultProfile()
  const profile = withProfile(base, {
    autoIndentFirstLine: opts.indent ?? false,
    ...(opts.columns !== undefined ? { columns: opts.columns } : {}),
    ...(opts.profile ?? {}),
  })
  return layoutBlock(
    {
      blockId: 'test',
      blockTitle: '测试题目',
      text,
      capacity: opts.capacity ?? 0,
      paragraphs: opts.paragraphs,
    },
    profile,
  )
}

/** 单个格子的可读表示：□ = 空格；a+b = 共格；x(squeezed) = 挤占 */
export function cellText(result: BlockLayoutResult, rowIndex: number, column: number): string {
  const row = result.rows[rowIndex]
  if (!row) return '<无此行>'
  const cell = row.cells[column]
  if (!cell) return '<无此格>'
  return renderCell(result, cell)
}

export function renderCell(result: BlockLayoutResult, cell: BlockLayoutResult['cells'][number]): string {
  if (cell.empty) return '□'
  return cell.occupants
    .map((o) => {
      const token = result.tokens.find((t) => t.id === o.tokenId)
      const text = token ? token.rawText.slice(o.sliceStart, o.sliceEnd) : '?'
      // squeezed 是行末挤占进来的，marker 是序号收尾符号 —— 两者都是「共格」，测试里用同一个记号
      if (o.render === 'squeezed' || o.render === 'marker') return `${text}~`
      if (o.render === 'compressed') return `${text}#`
      return text
    })
    .join('+')
}

/** 整行渲染：格与格之间用 | 分隔 */
export function rowText(result: BlockLayoutResult, rowIndex: number): string {
  const row = result.rows[rowIndex]
  if (!row) return '<无此行>'
  return row.cells.map((c) => renderCell(result, c)).join('|')
}

/** 整行渲染（压缩显示，连续空格格合并成 ·×n） */
export function rowCompact(result: BlockLayoutResult, rowIndex: number): string {
  const row = result.rows[rowIndex]
  if (!row) return '<无此行>'
  const parts: string[] = []
  let blanks = 0
  const flushBlanks = () => {
    if (blanks > 0) {
      parts.push(blanks === 1 ? '□' : `□×${blanks}`)
      blanks = 0
    }
  }
  for (const c of row.cells) {
    if (c.empty) {
      blanks += 1
      continue
    }
    flushBlanks()
    parts.push(renderCell(result, c))
  }
  flushBlanks()
  return parts.join(' ')
}

/** 取某行所有非空格内容 */
export function rowContent(result: BlockLayoutResult, rowIndex: number): string[] {
  const row = result.rows[rowIndex]
  if (!row) return []
  return row.cells.filter((c) => !c.empty).map((c) => renderCell(result, c))
}

/** 该行的第一个非空格所在的列号；整行皆空返回 -1 */
export function firstUsedColumn(result: BlockLayoutResult, rowIndex: number): number {
  const row = result.rows[rowIndex]
  if (!row) return -1
  return row.cells.findIndex((c) => !c.empty)
}

export function rowCount(result: BlockLayoutResult): number {
  return result.rows.length
}

/**
 * 有序 Token 原文列表（跳过换行）。
 * 一个 Token 可能横跨多个格（数字、破折号），用这个断言比逐格断言更直观。
 */
export function tokenTexts(result: BlockLayoutResult): string[] {
  return result.tokens.filter((t) => t.type !== 'LINE_BREAK').map((t) => t.rawText)
}

/** 某一行里出现的 Token 原文（按格子顺序，去重相邻重复） */
export function rowTokens(result: BlockLayoutResult, rowIndex: number): string[] {
  const row = result.rows[rowIndex]
  if (!row) return []
  const seen = new Set<number>()
  const out: string[] = []
  for (const cell of row.cells) {
    for (const o of cell.occupants) {
      if (seen.has(o.tokenId)) continue
      seen.add(o.tokenId)
      const token = result.tokens.find((t) => t.id === o.tokenId)
      if (token) out.push(token.rawText)
    }
  }
  return out
}

/** 该行使用的格数（非空格数量） */
export function usedColumns(result: BlockLayoutResult, rowIndex: number): number {
  const row = result.rows[rowIndex]
  if (!row) return 0
  return row.cells.filter((c) => !c.empty).length
}

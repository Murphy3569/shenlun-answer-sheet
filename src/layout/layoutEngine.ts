/**
 * Layout Engine —— Token 序列 → 答题格
 *
 * 这是整个应用的心脏。规则全部来自 LayoutProfile，本文件不写死任何数值。
 *
 * 行填充算法（核心循环）处理五种「放不下」的情形：
 *
 *   ① 行尾禁则 —— 开引号不能落在最后一格   → 移到下一行行首
 *   ② 行末挤占 —— 句末点号落在满行之后     → 与前一个字共用最后一格
 *   ③ 行末压缩 —— 破折号/省略号只剩 1 格   → 整体压进 1 格，绝不拆行
 *   ④ 避头下拉 —— 挤占不可行时把前一字拉下来（可配置）
 *   ⑤ 强制拆分 —— 超长数字/英文串宽过整行  → 只能按格拆开
 */

import { normalizeText, tokenize, countLogicalChars } from './tokenizer'
import {
  emptyCell,
  flushRow,
  placeCompressed,
  placeToken,
  pullDown,
  pushEvent,
  splitTokenAt,
  squeezeInto,
  startRow,
  wrapRow,
} from './cellAllocator'
import type { BuilderState } from './cellAllocator'
import {
  canOnlySqueeze,
  canSplitFreely,
  isCompressibleWideToken,
  isWiderThanLine,
  landsOnLastColumn,
  lineRulesOf,
  mustAvoidLineEnd,
  mustAvoidLineStart,
} from './lineBreakRules'
import type {
  BlockLayoutInput,
  Cell,
  DocumentLayout,
  LayoutProfile,
  Page,
  Panel,
  ParagraphLayoutInfo,
  ParagraphMeta,
  Row,
  RuleEvent,
  Token,
} from './types'

// ---------------------------------------------------------------------------
// 段落样式解析
// ---------------------------------------------------------------------------

export function resolveParagraphMeta(
  partial: Partial<ParagraphMeta> | undefined,
  profile: LayoutProfile,
): ParagraphMeta {
  const kind = partial?.kind ?? 'normal'
  const isHeading = kind === 'title' || kind === 'subtitle'
  const align = partial?.align ?? (isHeading ? 'center' : 'left')
  const indentCells =
    partial?.indentCells ?? (kind === 'normal' && align === 'left' && profile.autoIndentFirstLine ? profile.defaultIndentCells : 0)
  return { kind, align, indentCells }
}

// ---------------------------------------------------------------------------
// Token 行规则查询
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 单元格构造辅助
// ---------------------------------------------------------------------------

export function layoutBlock(input: BlockLayoutInput, profile: LayoutProfile): BlockLayoutResult {
  const text = normalizeText(input.text)
  const allTokens = tokenize(text, profile)
  const paragraphTexts = text.split('\n')

  const metas: ParagraphMeta[] = paragraphTexts.map((_, idx) =>
    resolveParagraphMeta(input.paragraphs?.[idx], profile),
  )

  // 按 LINE_BREAK 切分 Token 分组（分组数与段落数一致）
  const groups: Token[][] = [[]]
  for (const t of allTokens) {
    if (t.type === 'LINE_BREAK') groups.push([])
    else groups[groups.length - 1].push(t)
  }
  while (groups.length < paragraphTexts.length) groups.push([])

  const tokenById = new Map<number, Token>()
  for (const t of allTokens) tokenById.set(t.id, t)

  const state: BuilderState = {
    profile,
    rows: [],
    cells: [],
    events: [],
    rowCells: [],
    rowEndOffset: -1,
    paragraph: 0,
    kind: 'normal',
    align: 'left',
    rowBlank: true,
  }

  const columns = profile.columns
  const paragraphInfos: ParagraphLayoutInfo[] = []
  // 最后一段的区间要等收尾换行之后再补记，见下面循环里的说明
  let lastParagraphInfo: ParagraphLayoutInfo | null = null
  let paragraphStartOffset = 0

  for (let p = 0; p < groups.length; p++) {
    const meta = metas[p]
    const group = groups[p].slice()
    state.paragraph = p
    state.kind = meta.kind
    state.align = meta.align

    const contentWidth = group.reduce((sum, t) => sum + t.cellWidth, 0)
    const isHeadingAligned = (meta.align === 'center' || meta.align === 'right') && contentWidth <= columns
    const indentCells = meta.align === 'left' ? Math.max(0, Math.min(meta.indentCells, columns - 1)) : 0
    const leading = isHeadingAligned
      ? meta.align === 'center'
        ? Math.max(0, Math.floor((columns - contentWidth) / 2))
        : Math.max(0, columns - contentWidth)
      : indentCells

    const startRowIndex = state.rows.length
    const paragraphStart = paragraphStartOffset

    startRow(state, paragraphStart)
    for (let k = 0; k < leading; k++) {
      state.rowCells.push(emptyCell(k, paragraphStart, p))
    }

    let i = 0
    while (i < group.length) {
      const token = group[i]
      const rules = lineRulesOf(token, profile)
      const w = token.cellWidth
      let col = state.rowCells.length
      const remaining = columns - col

      // ① 行尾禁则：开引号不能落在最后一格
      if (mustAvoidLineEnd(token, rules, profile) && landsOnLastColumn(col, w, columns) && col > 0) {
        // 该符号既不能在行尾（正在处理），也不能在行首（不允许开符号起行）→ 唯一出路是挤占
        if (canOnlySqueeze(rules, profile)) {
          // 既不能行首也不能行尾（如 ：“）→ 挤占前一格
          const prev = state.rowCells[col - 1]
          if (squeezeInto(state, prev, token, tokenById)) {
            pushEvent(state, 'line-end-squeeze', token, `行尾禁则：${token.rawText} 与前字共格`)
            i += 1
            continue
          }
        }
        pushEvent(state, 'open-punct-moved-from-line-end', token, `行尾禁则：${token.rawText} 移到下一行`)
        wrapRow(state, token.sourceStart)
        continue
      }

      // 放得下
      if (w <= remaining) {
        placeToken(state, token)
        i += 1
        continue
      }

      // ② 破折号 / 省略号 只剩 1 格 → 压缩进 1 格，绝不拆行
      //    只对这两个 2 格宽的「整字标号」生效；数字串、英文串放不下就整体换行，
      //    绝不为了塞进一行而把 "2026" 压成一格。
      if (isCompressibleWideToken(token, remaining, profile)) {
        placeCompressed(state, token)
        pushEvent(state, 'line-end-compress', token, `行末压缩：${token.rawText} 压进 1 格`)
        i += 1
        continue
      }

      // ③ 行首禁则的标点落在满行之后 → 按 lineEndStrategy 避让
      //    救济顺序：挤占（默认）→ 避头下拉 → 兜底允许行首。
      //    三种策略各自独立，互不依赖对方的开关。
      if (
        mustAvoidLineStart(token, rules, profile) &&
        rules.squeezable &&
        w === 1 &&
        col > 0 &&
        profile.lineEndStrategy !== 'allow'
      ) {
        const prev = state.rowCells[col - 1]
        const squeezeFirst = profile.lineEndStrategy === 'squeeze' && profile.endOfLinePunctuationCompression
        if (squeezeFirst && squeezeInto(state, prev, token, tokenById)) {
          pushEvent(state, 'line-end-squeeze', token, `行末挤占：${token.rawText} 与前字共格`)
          i += 1
          continue
        }
        if (pullDown(state, group, i, tokenById, w)) {
          pushEvent(state, 'line-end-pull-down', token, `避头下拉：前一字与 ${token.rawText} 一起移到下一行`)
          continue
        }
        // ⑤ 兜底：允许出现在行首
        pushEvent(state, 'line-start-punct-allowed', token, `行首禁则：${token.rawText} 无法避让，落在行首`)
        wrapRow(state, token.sourceStart)
        placeToken(state, token)
        i += 1
        continue
      }

      // ④ 配置允许拆分的 Token：能塞多少塞多少，剩下的顺延到下一行
      if (canSplitFreely(token, remaining)) {
        const rest = splitTokenAt(state, token, remaining)
        pushEvent(state, 'forced-split', token, `按配置拆分：${token.rawText}`)
        if (rest) group.splice(i + 1, 0, rest)
        i += 1
        flushRow(state, state.rowBlank)
        startRow(state, token.sourceEnd)
        continue
      }

      if (col === 0 && isWiderThanLine(token, columns)) {
        // 整行都放不下（超长数字 / 英文串）→ 强制拆分
        const rest = splitTokenAt(state, token, columns)
        pushEvent(state, 'forced-split', token, `强制拆分：${token.rawText}`)
        if (rest) {
          group.splice(i + 1, 0, rest)
        }
        flushRow(state, state.rowBlank)
        startRow(state, token.sourceEnd)
        i += 1
        continue
      }

      // 本行一个字都没排，只有段首缩进 / 居中留白的占位格 —— 不能就这么白占一行
      if (state.rowBlank && col > 0) {
        if (isWiderThanLine(token, columns)) {
          // 整行都装不下，本来就得拆：把缩进之后的剩余格填满，缩进得以保留
          const rest = splitTokenAt(state, token, remaining)
          pushEvent(state, 'forced-split', token, `按行拆分：${token.rawText}`)
          if (rest) group.splice(i + 1, 0, rest)
          i += 1
          flushRow(state, false)
          startRow(state, token.sourceEnd)
          continue
        }
        // 只是塞不进缩进之后的剩余格 —— 丢掉占位格，让它从第 0 格整块排，
        // 既不白占一行，也不把本来完整的数字串拆开。
        state.rowCells = []
        state.rowEndOffset = token.sourceStart
        continue
      }

      wrapRow(state, token.sourceStart)
    }

    // 段落收尾：非最后一段必须换行（空段落 → 一整行空白答题区）
    if (p < groups.length - 1) {
      flushRow(state, state.rowBlank)
      paragraphInfos.push({
        index: p,
        text: paragraphTexts[p],
        meta,
        startRow: startRowIndex,
        endRow: state.rows.length,
        tokenCount: group.length,
        cellWidth: contentWidth,
      })
    } else {
      // 最后一段的收尾换行在循环之外（见下面的 flushRow），所以要等那一行真的落下去再记。
      // 在这里 push 的话 endRow 会少算最后一行 —— 单行段落直接得到空区间 [0,0)，
      // 任何按段落遍历行的消费方都会漏掉它。
      lastParagraphInfo = {
        index: p,
        text: paragraphTexts[p],
        meta,
        startRow: startRowIndex,
        endRow: 0,
        tokenCount: group.length,
        cellWidth: contentWidth,
      }
    }

    paragraphStartOffset += paragraphTexts[p].length + 1
  }

  // 收尾：最后一段（即使为空也要留下一行，光标的落点在这里）
  flushRow(state, state.rowBlank)
  if (lastParagraphInfo) {
    lastParagraphInfo.endRow = state.rows.length
    paragraphInfos.push(lastParagraphInfo)
  }

  // ---- 容量补齐 ----
  const capacityCells = Math.max(0, Math.floor(input.capacity))
  const capacityRows = capacityCells > 0 ? Math.ceil(capacityCells / columns) : 0
  const contentRows = state.rows.length
  const totalRows = Math.max(contentRows, capacityRows)
  const endOffset = text.length

  for (let r = contentRows; r < totalRows; r++) {
    const cells: Cell[] = []
    for (let c = 0; c < columns; c++) cells.push(emptyCell(c, endOffset, Math.max(0, groups.length - 1)))
    const row: Row = {
      index: r,
      rowInPanel: r,
      panelIndex: 0,
      pageIndex: 0,
      cells,
      paragraph: Math.max(0, groups.length - 1),
      kind: 'normal',
      align: 'left',
      isBlankLine: false,
      isPadding: true,
      overflow: false,
      isContinuation: false,
      markers: [],
    }
    for (const c of row.cells) c.row = r
    state.rows.push(row)
    state.cells.push(...row.cells)
  }

  // ---- 溢出标记 ----
  // 口径必须和工具栏显示完全一致：容量算的是「内容格」。
  //   · 段首缩进的占位格是空格式，不算内容，不该吃掉用户的字数预算；
  //   · 容量不是每行格数整数倍时，多出来的空白补齐格也不算。
  // 所以判定依据是「这个格是所有非空格里的第几个」，而不是它在页面上的绝对序号。
  const milestoneStep = profile.milestoneStep > 0 ? profile.milestoneStep : 0
  let contentOrdinal = 0
  let overflowCells = 0
  for (const row of state.rows) {
    // 行末格数标注按**格在纸上的绝对位置**固定打点，和用户写了多少字无关 ——
    // 真实答题卡上的 100 / 200 / 300 就是印死在纸上的，空白卡上也看得见。
    if (milestoneStep > 0) {
      const rowStart = row.index * columns
      const rowEnd = rowStart + columns
      const milestone = Math.floor(rowEnd / milestoneStep) * milestoneStep
      if (milestone > rowStart) row.markers.push(milestone)
    }

    let rowHasOverflow = false
    for (const c of row.cells) {
      c.overflow = false
      if (c.empty) continue
      contentOrdinal += 1
      if (capacityCells > 0 && contentOrdinal > capacityCells) {
        c.overflow = true
        rowHasOverflow = true
        overflowCells += 1
      }
    }
    row.overflow = rowHasOverflow
  }
  const overflow = overflowCells > 0

  const occupiedCellCount = state.cells.reduce((n, c) => n + (c.empty ? 0 : 1), 0)

  return {
    blockId: input.blockId,
    blockTitle: input.blockTitle,
    tokens: allTokens,
    rows: state.rows,
    cells: state.cells,
    paragraphs: paragraphInfos,
    logicalCharCount: countLogicalChars(text),
    occupiedCellCount,
    capacityCells,
    capacityRows: capacityRows || totalRows,
    overflow,
    overflowCells,
    rules: state.events,
    text,
  }
}

/** layoutBlock 的返回类型（含中间态） */
export interface BlockLayoutResult {
  blockId: string
  blockTitle: string
  tokens: Token[]
  rows: Row[]
  cells: Cell[]
  paragraphs: ParagraphLayoutInfo[]
  logicalCharCount: number
  occupiedCellCount: number
  capacityCells: number
  capacityRows: number
  overflow: boolean
  overflowCells: number
  rules: RuleEvent[]
  /** 归一化后的文本（与 offsets 对应） */
  text: string
}

// ---------------------------------------------------------------------------
// 放置原语
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 分页：Row → Panel → Page
// ---------------------------------------------------------------------------

export interface PaginationOptions {
  /** 每页每个面板的行数（首页可能更少，因为要留抬头） */
  rowsPerPanelForPage?: (pageIndex: number) => number
  /** 每页放几个答题面板：1 = 通栏，2 = 左半 + 右半（A3 横向默认） */
  panelsPerPage?: number
}

const DEFAULT_PANEL_ROWS = 24

/**
 * 分页规则：
 *   · 一页可以放 1 个（通栏）或 2 个（左半 + 右半）答题面板
 *   · 每个题目独占一个或多个面板，题目之间绝不共用面板
 *   · 题目内容超过一个面板的行数时，顺延到下一个面板并标记为「续」
 *
 * 注意：分页只影响 pageIndex / panelIndex / rowInPanel 这些展示字段，
 * 绝不改动 rows 本身，因此自动换行永远不会污染逻辑文本。
 */
export function paginateBlocks(
  blocks: BlockLayoutResult[],
  profile: LayoutProfile,
  options: PaginationOptions = {},
): { pages: Page[]; panels: Panel[] } {
  const panelsPerPage = Math.max(1, Math.min(2, options.panelsPerPage ?? 1))
  const rowsFor = options.rowsPerPanelForPage ?? (() => profile.rowsPerPanel || DEFAULT_PANEL_ROWS)

  const pages: Page[] = [{ index: 0, kind: 'first', panels: [] }]
  const panels: Panel[] = []
  let pageIndex = 0
  let slot = 0

  const ensurePage = (idx: number): Page => {
    while (pages.length <= idx) {
      pages.push({ index: pages.length, kind: pages.length === 0 ? 'first' : 'continuation', panels: [] })
    }
    return pages[idx]
  }

  /** 占用当前槽位并前进到下一个槽位 */
  const advance = () => {
    slot += 1
    if (slot >= panelsPerPage) {
      slot = 0
      pageIndex += 1
    }
    ensurePage(pageIndex)
  }

  for (const block of blocks) {
    let cursor = 0
    let continuation = false
    while (cursor < block.rows.length) {
      const rowsHere = Math.max(1, rowsFor(pageIndex))
      const slice = block.rows.slice(cursor, cursor + rowsHere)
      const firstRowInPanel = cursor
      const panel: Panel = {
        index: panels.length,
        pageIndex,
        slot: slot as 0 | 1,
        blockId: block.blockId,
        blockTitle: block.blockTitle,
        rows: slice,
        regionRows: slice.length,
        isContinuation: continuation,
        overflow: slice.length > 0 && slice.every((r) => r.overflow),
        capacity: block.capacityCells,
      }
      for (const row of slice) {
        row.panelIndex = panel.index
        row.pageIndex = pageIndex
        row.isContinuation = continuation
        row.rowInPanel = row.index - firstRowInPanel
        for (const c of row.cells) c.rowInPanel = row.index - firstRowInPanel
      }
      panels.push(panel)
      ensurePage(pageIndex).panels.push(panel)
      cursor += slice.length
      continuation = true
      advance()
    }
  }

  const cleaned = pages.filter((p) => p.panels.length > 0)
  cleaned.forEach((p, idx) => {
    p.index = idx
    p.kind = idx === 0 ? 'first' : 'continuation'
    for (const panel of p.panels) panel.pageIndex = idx
  })

  return {
    pages: cleaned.length > 0 ? cleaned : [{ index: 0, kind: 'first', panels: [] }],
    panels,
  }
}

/** 多块（整卷模式）排版 */
export function layoutDocument(
  inputs: BlockLayoutInput[],
  profile: LayoutProfile,
  options: PaginationOptions = {},
): DocumentLayout {
  const blocks = inputs.map((input) => layoutBlock(input, profile))
  const { pages, panels } = paginateBlocks(blocks, profile, options)
  return { blocks, pages, panels }
}

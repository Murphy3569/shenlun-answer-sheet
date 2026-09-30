/**
 * CellAllocator —— 把 Token 落到格子上
 *
 * 这一层只做「几何落位」，不做任何「该不该换行」的判断
 * （判断在 lineBreakRules.ts，编排在 layoutEngine.ts）。
 *
 * 所有原语都直接改写 state.rowCells，调用方负责推进 Token 下标。
 */

import { splitIntoCellSlices } from './numberRules'
import { lineRulesOf } from './lineBreakRules'
import type { Cell, LayoutProfile, ParagraphMeta, Row, RuleEvent, RuleEventType, Token } from './types'

export function emptyCell(column: number, offset: number, paragraph: number): Cell {
  return {
    row: -1,
    rowInPanel: -1,
    column,
    occupants: [],
    sourceStart: offset,
    sourceEnd: offset,
    display: '',
    empty: true,
    paragraph,
    overflow: false,
  }
}

// ---------------------------------------------------------------------------
// 排版状态
// ---------------------------------------------------------------------------

/** 单块排版过程中的可变状态；所有落格原语都直接改写它 */
export interface BuilderState {
  profile: LayoutProfile
  rows: Row[]
  cells: Cell[]
  events: RuleEvent[]
  rowCells: Cell[]
  rowEndOffset: number
  paragraph: number
  kind: ParagraphMeta['kind']
  align: ParagraphMeta['align']
  rowBlank: boolean
}

export function pushEvent(state: BuilderState, type: RuleEventType, token: Token, detail: string): void {
  state.events.push({ type, offset: token.sourceStart, tokenId: token.id, detail })
}

/** 把 Token 的第 cellIndex 个格内容写入单元格 */
export function fillCells(
  state: BuilderState,
  token: Token,
  cellIndex: number,
  target: Cell,
): Cell {
  const profile = state.profile

  if (token.type === 'COMPOUND_PUNCT' && token.compoundKey) {
    const rule = profile.compoundRules[token.compoundKey]
    if (rule) {
      // 按这一格的「切片区间」挑字形，不能按 g.cell === cellIndex 挑。
      // Token 被拆成 head/tail 之后 cellIndex 从 0 重新数，而字形表里的 cell
      // 是相对整个原始 Token 的 —— 按 cellIndex 挑会把头一格的字形在尾格再画一遍
      // （纸上平白多出字），真正那半截字符反而没有任何格承载。
      const slice = token.slices?.[cellIndex]
      const glyphs = slice
        ? rule.glyphs.filter((g) => g.start >= slice.start && g.end <= slice.end)
        : rule.glyphs.filter((g) => g.cell === cellIndex)
      if (glyphs.length > 0) {
        const start = Math.min(...glyphs.map((g) => g.start))
        const end = Math.max(...glyphs.map((g) => g.end))
        target.occupants = [{ tokenId: token.id, sliceStart: start, sliceEnd: end, render: 'normal' }]
        target.glyphs = glyphs.map((g) => ({ ...g }))
        target.display = token.rawText.slice(start, end)
        target.sourceStart = token.sourceStart + start
        target.sourceEnd = token.sourceStart + end
        target.empty = false
        return target
      }
    }
  }

  const slices = token.slices ?? splitIntoCellSlices(token.rawText.length, token.cellWidth)
  const slice = slices[cellIndex]
  if (!slice) return target
  target.occupants = [{ tokenId: token.id, sliceStart: slice.start, sliceEnd: slice.end, render: 'normal' }]
  target.display = token.rawText.slice(slice.start, slice.end)
  target.sourceStart = token.sourceStart + slice.start
  target.sourceEnd = token.sourceStart + slice.end
  target.empty = false
  return target
}

export function flushRow(state: BuilderState, isBlankLine: boolean): void {
  const columns = state.profile.columns
  while (state.rowCells.length < columns) {
    state.rowCells.push(emptyCell(state.rowCells.length, state.rowEndOffset, state.paragraph))
  }
  const rowIndex = state.rows.length
  const row: Row = {
    index: rowIndex,
    rowInPanel: rowIndex,
    panelIndex: 0,
    pageIndex: 0,
    cells: state.rowCells,
    paragraph: state.paragraph,
    kind: state.kind,
    align: state.align,
    isBlankLine,
    isPadding: false,
    overflow: false,
    isContinuation: false,
    markers: [],
  }
  for (const c of row.cells) c.row = rowIndex
  state.rows.push(row)
  state.cells.push(...row.cells)
  state.rowCells = []
  state.rowEndOffset = -1
}

export function startRow(state: BuilderState, offset: number): void {
  state.rowCells = []
  state.rowEndOffset = offset
  state.rowBlank = true
}

/**
 * 换行：结束当前行，从下一行继续。
 *
 * 关键细节：如果当前行**只有段首缩进 / 居中留白的占位格**（一个字都没排），
 * 就绝不能把它当成一行冲掉 —— 那会凭空多出一整行空白（还被标记成用户空行），
 * 同时把缩进吃掉、后面所有格子的绝对序号整体后移一格行，连容量统计都会误报超限。
 * 正确做法是丢掉这些占位格，让这个 Token 从第 0 格重新开始排。
 */
export function wrapRow(state: BuilderState, nextOffset: number): void {
  if (state.rowBlank) {
    state.rowCells = []
    state.rowEndOffset = nextOffset
    state.rowBlank = true
    return
  }
  flushRow(state, false)
  startRow(state, nextOffset)
}

// ---------------------------------------------------------------------------
// 放置原语
// ---------------------------------------------------------------------------

export function placeToken(state: BuilderState, token: Token): void {
  for (let c = 0; c < token.cellWidth; c++) {
    const cell = emptyCell(state.rowCells.length, token.sourceStart, state.paragraph)
    fillCells(state, token, c, cell)
    state.rowCells.push(cell)
  }
  // 行末 offset 取「本行最后一个格覆盖到哪里」，而不是整个 Token 的结束位置：
  // 超长 Token 被强制拆分后，Token.sourceEnd 指向整串末尾，直接用它会让本行的空白格
  // 声称自己覆盖了后面几行的文本，造成源区间倒挂。
  const last = state.rowCells[state.rowCells.length - 1]
  state.rowEndOffset = last ? last.sourceEnd : token.sourceEnd
  state.rowBlank = false
}

/** 2 格宽 Token 压进 1 格 */
export function placeCompressed(state: BuilderState, token: Token): void {
  const cell = emptyCell(state.rowCells.length, token.sourceStart, state.paragraph)
  cell.occupants = [
    {
      tokenId: token.id,
      sliceStart: 0,
      sliceEnd: token.rawText.length,
      render: 'compressed',
    },
  ]
  cell.display = token.rawText
  cell.sourceStart = token.sourceStart
  cell.sourceEnd = token.sourceEnd
  cell.empty = false
  state.rowCells.push(cell)
  state.rowEndOffset = token.sourceEnd
  state.rowBlank = false
}

/** 把 token 挤进 target 格（与原有字形共格） */
export function squeezeInto(
  state: BuilderState,
  target: Cell | undefined,
  token: Token,
  tokenByIdRef: Map<number, Token>,
): boolean {
  if (!target) return false
  if (target.empty) return false
  // 一格最多两个占位者：已经挤过一个就到此为止
  if (target.occupants.length !== 1) return false
  const owner = target.occupants[0]
  if (owner.render === 'squeezed') return false

  // 主字可以是：
  //   · 单个汉字 / 单个标点（切片长度 1）
  //   · 数字串或英文串占的这一格（切片长度 2，例如 "26"）—— 真实答题卡上
  //     句号就是写在最后那个数字的右下角的，不能因为「一格里有俩字符」就放弃避让
  //   · 行末被压缩的破折号 / 省略号
  // 但复合标点占的格不能再塞第三个字形（会糊成一团）。
  const ownerToken = tokenByIdRef.get(owner.tokenId)
  if (ownerToken?.type === 'COMPOUND_PUNCT') return false
  const sliceLength = owner.sliceEnd - owner.sliceStart
  if (sliceLength > 2) return false

  // 标点具体摆在格子的哪个位置由渲染层决定（见 components/cellGlyphs.ts 的「行末共格布局」），
  // 这里只负责把占位者挂上去。
  target.occupants.push({
    tokenId: token.id,
    sliceStart: 0,
    sliceEnd: token.rawText.length,
    render: 'squeezed',
  })
  target.sourceEnd = token.sourceEnd
  target.display += token.rawText
  state.rowBlank = false
  return true
}

/**
 * 避头下拉：把当前行末尾那个 Token 整块摘下来，与紧跟的标点一起进入下一行。
 *
 * 被摘的 Token 可以占多格（例如行末被压缩的破折号、数字串的最后一格），
 * 只要它在下一行能连同标点一起放下。这是「挤占 → 下拉 → 兜底允许行首」
 * 救济链的中间一环，缺了它，行末刚好被一个多格 Token 占满时，
 * 句末点号就只能违规落到下一行行首。
 */
export function pullDown(
  state: BuilderState,
  group: Token[],
  index: number,
  tokenById: Map<number, Token>,
  pendingWidth: number,
): boolean {
  const cells = state.rowCells
  const last = cells[cells.length - 1]
  if (!last) return false
  if (last.occupants.length !== 1) return false
  const occ = last.occupants[0]
  if (occ.render === 'squeezed') return false
  const owner = tokenById.get(occ.tokenId)
  if (!owner) return false
  if (owner.type === 'SPACE') return false
  // 被拖下来的 Token 会落在下一行行首，本身就禁行首的符号（复合标点等）不能这么处理
  if (lineRulesOf(owner, state.profile).noLineStart) return false
  // 死循环守卫：拉下来以后这两个 Token 必须能在新的一行里放下。
  // 否则下一轮会回到完全相同的局面（例如 columns=1 时，一个字 + 一个标点永远放不下）。
  if (owner.cellWidth + pendingWidth > state.profile.columns) return false

  // 找出该 Token 在本行末尾连续占用的所有格；必须整块都在行尾才能整体搬走
  let start = cells.length
  while (start > 0 && cells[start - 1].occupants.length === 1 && cells[start - 1].occupants[0].tokenId === owner.id) {
    start -= 1
  }
  const removed = cells.length - start
  if (removed < 1 || removed > owner.cellWidth) return false
  if (removed > 1 && cells.slice(start).some((c) => c.occupants[0].render !== 'normal')) return false

  cells.length = start
  const remaining = cells[cells.length - 1]
  state.rowEndOffset = remaining ? remaining.sourceEnd : owner.sourceStart
  if (cells.length > 0) {
    flushRow(state, false)
  }
  startRow(state, owner.sourceStart)
  // 把被摘下的 Token 重新插回待处理队列
  group.splice(index, 0, owner)
  return true
}

/**
 * 把一个 Token 拆成「填进 takeCells 格的头」和「剩下的尾」。
 *
 * 两个使用场景：
 *   1. Token 比一整行还宽（超长数字/英文串）—— 不拆就没法排；
 *   2. profile 里关掉了 keepNumberIntact / keepEnglishIntact —— 允许在任意格边界拆开。
 * 拆分点严格落在已有切片边界上，格子内容不会错位。
 */
export function splitTokenAt(state: BuilderState, token: Token, takeCells: number): Token | null {
  const slices = token.slices ?? splitIntoCellSlices(token.rawText.length, token.cellWidth)
  if (slices.length <= takeCells) {
    placeToken(state, token)
    return null
  }
  const headSlices = slices.slice(0, takeCells)
  const tailSlices = slices.slice(takeCells)

  // 关键：rawText 与切片下标都保持「相对整个原始 Token」的绝对坐标，
  // 只是把要落格的那一段换成 head / tail。这样按 tokenId 反查回来时
  // display 仍然能取到正确的子串（切片的基准不能被重设）。
  const head: Token = { ...token, cellWidth: headSlices.length, slices: headSlices }
  placeToken(state, head)

  const tail: Token = { ...token, cellWidth: tailSlices.length, slices: tailSlices }
  return tail
}

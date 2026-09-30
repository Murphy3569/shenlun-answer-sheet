/**
 * 答题卡渲染
 *
 * 层次：Page（A3 横向 / A4 纵向） → Panel（一道题的答题区） → Row（一行 N 格） → Cell（一格）
 *
 * 渲染层只负责画，不做任何规则判断 —— 所有取舍都在 layout 引擎里算好了。
 * 行组件按内容签名做 memo，1500 字量级下每次输入只有真正变化的行会重渲染。
 */

import { memo } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { buildCellGlyphs, isSpaceCell } from './cellGlyphs'
import type { Cell, CompoundRule, DocumentLayout, Page, Panel, Row, Token } from '../layout'

type TokenMap = Map<number, Token>

// ---------------------------------------------------------------------------
// 行内容签名（带缓存，供 memo 比较用）
// ---------------------------------------------------------------------------

const signatureCache = new WeakMap<Row, string>()

export function rowSignature(row: Row): string {
  const cached = signatureCache.get(row)
  if (cached !== undefined) return cached
  let s = row.overflow ? '1' : '0'
  s += row.isPadding ? '1' : '0'
  s += row.markers.join(',')
  s += '#'
  for (const c of row.cells) {
    // 签名要覆盖「渲染这一行时读到的每一个字段」，不只是格子里显示的字。
    // 漏掉任何一个都会出现「签名相同、但画出来不一样」，行级 memo 于是跳过重绘，
    // 这一行就永久停在旧样式上：
    //   · overflow        —— 红色斜纹。改容量时溢出边界会在行内左右移动，
    //                        而 row.overflow 前后都是 true，只看它认不出来。
    //   · sourceStart/End  —— 这格算不算落在选区里。排版变了但格子内容没变时
    //                        （连续重复字符），偏移会变而显示不会变。
    // 空格没有 occupants，但它的偏移同样会变，所以这两项要在 empty 判断之前写。
    s += c.overflow ? '1' : '0'
    s += c.sourceStart
    s += ','
    s += c.sourceEnd
    s += ':'
    if (c.empty) {
      s += '.'
      continue
    }
    s += c.display
    s += String(c.occupants.length)
    for (const o of c.occupants) s += o.render[0]
    s += '|'
  }
  signatureCache.set(row, s)
  return s
}

// ---------------------------------------------------------------------------
// 单格
// ---------------------------------------------------------------------------

interface CellViewProps {
  cell: Cell
  tokensById: TokenMap
  compoundRules: Record<string, CompoundRule>
  selected: boolean
  /** 光标落在本格时的水平位置（0~1），不落在本格为 null */
  caretFraction: number | null
}

function CellViewInner({ cell, tokensById, compoundRules, selected, caretFraction }: CellViewProps) {
  const glyphs = cell.empty ? [] : buildCellGlyphs(cell, tokensById, compoundRules)
  const space = isSpaceCell(cell, tokensById)

  const className = [
    'cell',
    cell.overflow ? 'cell--overflow' : '',
    selected ? 'cell--selected' : '',
    caretFraction !== null ? 'cell--caret' : '',
    space ? 'cell--space' : cell.empty ? 'cell--pad' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className} data-cell="1" data-row={cell.row} data-col={cell.column}>
      {glyphs.map((g) => {
        // 统一约定：scale 是「相对基准字号（0.76 格）」的倍率
        const fontSize = `calc(var(--cell) * ${(0.76 * g.scale).toFixed(3)})`
        // 需要挪位置的字形（含被挤占的标点）统一走同一套定位：字身框与格子等大 + 整体平移
        if (g.className === 'attach' || g.className.includes('glyph--positioned') || g.className.includes('glyph--compressed')) {
          return (
            <span
              key={g.key}
              className={g.className}
              style={
                {
                  '--gx': g.x,
                  '--gy': g.y,
                  fontSize,
                } as CSSProperties
              }
            >
              {g.text}
            </span>
          )
        }
        return (
          <span key={g.key} className={g.className}>
            {g.text}
          </span>
        )
      })}
      {/* 光标横向也留出间隙：把格内比例映射到 12%~88%，不压在竖格线上 */}
      {caretFraction !== null && <span className="caret" style={{ left: `${12 + caretFraction * 76}%` }} />}
    </div>
  )
}

const CellView = memo(CellViewInner)

// ---------------------------------------------------------------------------
// 一行
// ---------------------------------------------------------------------------

interface RowViewProps {
  row: Row
  tokensById: TokenMap
  compoundRules: Record<string, CompoundRule>
  /** 该行所在面板在页面中的位置：0 = 左半页，1 = 右半页 */
  slot: 0 | 1
  /** 该页有几个面板：只有 1 个（通栏）时，标注要放到行的右侧页边距里 */
  panelsOnPage: number
  selStart: number
  selEnd: number
  caretColumn: number
  caretFraction: number
  caretActive: boolean
}

function RowViewInner({
  row,
  tokensById,
  compoundRules,
  slot,
  panelsOnPage,
  selStart,
  selEnd,
  caretColumn,
  caretFraction,
  caretActive,
}: RowViewProps) {
  const hasSelection = selEnd > selStart
  // 左半页的行尾紧挨着页面中间那条虚线，标记要右对齐、留出间隙，否则会压在虚线上；
  // 通栏时行尾右边就是页边距，直接左对齐排出去即可。
  const inset = panelsOnPage > 1 && slot === 0
  const markerClass = `row-marker row-marker--${inset ? 'inset' : 'outer'}`
  const markerText = row.markers.join('·')
  return (
    <div className="grid-row">
      {/* 行末格数标注：每满 100 格一个，位置固定印在纸上 */}
      {row.markers.length > 0 && (
        <span
          className={markerClass}
          // 四位数（1000 / 1200 这类）缩小一点，左半页才不会顶到左边的格子上
          style={markerText.length > 3 ? { fontSize: '1.6mm' } : undefined}
        >
          {markerText}
        </span>
      )}
      {row.cells.map((cell) => (
        <CellView
          key={cell.column}
          cell={cell}
          tokensById={tokensById}
          compoundRules={compoundRules}
          selected={hasSelection && cell.sourceStart < selEnd && cell.sourceEnd > selStart}
          caretFraction={caretActive && cell.column === caretColumn ? caretFraction : null}
        />
      ))}
    </div>
  )
}

export const RowView = memo(
  RowViewInner,
  (a, b) =>
    // 注意两件事：
    // 1. 绝不能写成「row 是同一个对象就跳过渲染」—— 光标移动、选区变化时排版结果不变
    //    （row 对象不变），但画面必须重绘，否则方向键、点击格子、撤销之后可见光标原地不动。
    // 2. 也绝不能比较 tokensById 的引用 —— 每次输入排版结果都是新对象，
    //    Map 引用必然不同，会让所有行无条件重渲染，行级 memo 直接失效。
    //    行的内容签名里已经含了每格要显示的文本，签名相同就说明这一行画出来一模一样。
    a.slot === b.slot &&
    a.panelsOnPage === b.panelsOnPage &&
    a.selStart === b.selStart &&
    a.selEnd === b.selEnd &&
    a.caretColumn === b.caretColumn &&
    a.caretFraction === b.caretFraction &&
    a.caretActive === b.caretActive &&
    a.compoundRules === b.compoundRules &&
    (a.row === b.row || rowSignature(a.row) === rowSignature(b.row)),
)

// ---------------------------------------------------------------------------
// 一个答题区（一道题的一个面板）
// ---------------------------------------------------------------------------

interface PanelViewProps {
  panel: Panel
  tokensById: TokenMap
  compoundRules: Record<string, CompoundRule>
  selStart: number
  selEnd: number
  caretRow: number
  caretColumn: number
  caretFraction: number
  active: boolean
  /** 本页面板数（1 = 通栏，2 = 左右分栏），只用来决定行末标注的贴法 */
  panelsOnPage: number
  onPointerDown: (blockId: string, rowIndex: number, column: number, fraction: number, shift: boolean) => void
}

function PanelViewInner({
  panel,
  tokensById,
  compoundRules,
  selStart,
  selEnd,
  caretRow,
  caretColumn,
  caretFraction,
  active,
  panelsOnPage,
  onPointerDown,
}: PanelViewProps) {
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('[data-cell]') as HTMLElement | null
    if (!target) return
    const rowIndex = Number(target.dataset.row)
    const column = Number(target.dataset.col)
    if (!Number.isFinite(rowIndex) || !Number.isFinite(column)) return
    const rect = target.getBoundingClientRect()
    const fraction = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
    onPointerDown(panel.blockId, rowIndex, column, fraction, e.shiftKey)
  }

  return (
    <div className={`panel${active ? '' : ' panel--inactive'}`}>
      <div className="panel-heading">
        <span>{panel.blockTitle}</span>
        <span className="cap">（{panel.capacity} 字）</span>
        {panel.isContinuation && <span className="cont-badge">接上页</span>}
      </div>
      <div className="grid" data-block={panel.blockId} onPointerDown={handlePointerDown}>
        {panel.rows.map((row) => {
          // 关键：只把「真的会影响这一行」的选区/光标状态传下去。
          // 如果无脑给每一行都传 selStart/selEnd，光标一动所有行的 props 都变，
          // 行级 memo 立刻失效，1500 字时每次按键都要重渲染上千个格。
          const first = row.cells[0]
          const last = row.cells[row.cells.length - 1]
          const rowTouchesSelection =
            selEnd > selStart && first.sourceStart < selEnd && last.sourceEnd > selStart
          const isCaretRow = active && caretRow === row.index
          return (
            <RowView
              key={row.index}
              row={row}
              tokensById={tokensById}
              compoundRules={compoundRules}
              slot={panel.slot}
              panelsOnPage={panelsOnPage}
              selStart={rowTouchesSelection ? selStart : -1}
              selEnd={rowTouchesSelection ? selEnd : -1}
              caretColumn={isCaretRow ? caretColumn : -1}
              caretFraction={isCaretRow ? caretFraction : 0}
              caretActive={isCaretRow}
            />
          )
        })}
      </div>
    </div>
  )
}

export const PanelView = memo(PanelViewInner)

// ---------------------------------------------------------------------------
// 一页 A3
// ---------------------------------------------------------------------------

interface PageViewProps {
  page: Page
  pageCount: number
  columns: number
  /** 是否左右两栏版式（A3）—— 决定中间虚线与页脚说明怎么显示 */
  split: boolean
  /** 纸张说明，如「A4 纵向」 */
  paperLabel: string
  activeBlockId: string
  tokensByBlockId: Map<string, TokenMap>
  compoundRules: Record<string, CompoundRule>
  selStart: number
  selEnd: number
  caretRow: number
  caretColumn: number
  caretFraction: number
  showTemplate: boolean
  interactive: boolean
  onPointerDown: (blockId: string, rowIndex: number, column: number, fraction: number, shift: boolean) => void
}

function PageViewInner({
  page,
  pageCount,
  columns,
  split,
  paperLabel,
  activeBlockId,
  tokensByBlockId,
  compoundRules,
  selStart,
  selEnd,
  caretRow,
  caretColumn,
  caretFraction,
  showTemplate,
  interactive,
  onPointerDown,
}: PageViewProps) {
  const isFirst = page.kind === 'first'
  const isLast = page.index === pageCount - 1
  const emptyTokens: TokenMap = EMPTY_TOKEN_MAP

  return (
    <div className="page-wrap">
      <div className={`sheet-page${showTemplate ? '' : ' sheet-page--bare'}`}>
        {showTemplate && (
          <>
            <span className="corner-mark corner-mark--tl" />
            <span className="corner-mark corner-mark--tr" />
            <span className="corner-mark corner-mark--bl" />
            <span className="corner-mark corner-mark--br" />
          </>
        )}

        <div className="sheet-header">
          {isFirst && showTemplate && (
            <div className="absent-box">
              <span>
                <i className="tick" />
                缺考
              </span>
              <span>
                <i className="tick" />
                作弊
              </span>
            </div>
          )}
          {isFirst ? (
            <>
              <h1 className="sheet-title">申论答题卡</h1>
              <p className="sheet-subtitle">适用于 市（地）级以下综合管理类和行政执法类 职位</p>
            </>
          ) : (
            <p className="cont-title">接上页，以下为答题区域，请勿折叠</p>
          )}
          <div className="sheet-meta">
            <span className="field">
              姓名：<i className="underline" />
            </span>
            <span className="field">
              准考证号：<i className="underline underline--short" />
            </span>
          </div>
          <div className="notice">
            <b>注意事项</b>
            <ol>
              <li>请用黑色签字笔在方格内作答，超出答题区域的作答无效。</li>
              <li>一个汉字占一格，标点按其书写规范占格；不得折叠、污损答题卡。</li>
              <li>请在各题指定的答题区域内作答，不得跨区域答题，不得做任何标记。</li>
              <li>如需修改，请用修改符号划去后在旁边重写；字迹不清影响评卷的，责任由考生自负。</li>
            </ol>
          </div>
        </div>

        {/* 中间那条竖向虚线只在左右两栏版式下才有意义；A4 单栏时画上去会横穿答题区 */}
        <div className={`sheet-body${split ? '' : ' sheet-body--single'}`}>
          {page.panels.map((panel) => {
            const isActive = interactive && panel.blockId === activeBlockId
            return (
              <PanelView
                key={panel.index}
                panel={panel}
                tokensById={tokensByBlockId.get(panel.blockId) ?? emptyTokens}
                compoundRules={compoundRules}
                selStart={isActive ? selStart : 0}
                selEnd={isActive ? selEnd : 0}
                caretRow={isActive ? caretRow : -1}
                caretColumn={caretColumn}
                caretFraction={caretFraction}
                active={isActive}
                panelsOnPage={page.panels.length}
                onPointerDown={onPointerDown}
              />
            )
          })}
        </div>

        <div className="sheet-footer">
          <span className="end-note">{isLast ? '全卷到此结束' : ''}</span>
          <span className="page-no">
            第 {page.index + 1} 页 / 共 {pageCount} 页
          </span>
        </div>
      </div>
      <div className="page-caption">
        {paperLabel} · 每行 {columns} 格
      </div>
    </div>
  )
}

const EMPTY_TOKEN_MAP: TokenMap = new Map()

export const PageView = memo(PageViewInner)

// ---------------------------------------------------------------------------
// 整卷
// ---------------------------------------------------------------------------

export interface SheetViewProps {
  doc: DocumentLayout
  columns: number
  /** 版式：A3 左右两栏 / A4 单栏 */
  split: boolean
  paperLabel: string
  activeBlockId: string
  tokensByBlockId: Map<string, TokenMap>
  compoundRules: Record<string, CompoundRule>
  selStart: number
  selEnd: number
  caretRow: number
  caretColumn: number
  caretFraction: number
  showTemplate: boolean
  interactive: boolean
  onPointerDown: (blockId: string, rowIndex: number, column: number, fraction: number, shift: boolean) => void
}

export function SheetView({ doc, ...rest }: SheetViewProps) {
  return (
    <>
      {doc.pages.map((page) => (
        <PageView key={page.index} page={page} pageCount={doc.pages.length} {...rest} />
      ))}
    </>
  )
}

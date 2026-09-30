/**
 * 答题卡几何
 *
 * 参考件是 A3 横向（420 × 297 mm），中间一条竖向虚线把答题区分成左右两块。
 * 这里把全部尺寸集中成变量，坐标一律从这些常量推导，
 * 不允许在组件里写死任何 mm / px 数值 —— 否则改版式就会到处漏改。
 *
 * 两种纸张版式：
 *   · a3-split   A3 横向，左右两栏（整卷模式固定用它；单题的答案装不下时也用它）
 *   · a4-single  A4 纵向，只有一栏（单题且装得下时用它）
 *
 * **关键不变量：两种版式的「栏宽」完全相同（196mm）**，所以
 * `格子边长 = 栏宽 ÷ 每行格数` 在两种版式下一模一样 ——
 * 缩小的是纸张，不是格子。改这两个规格时务必保持这一点（有测试盯着）。
 */

/** 纸张版式 */
export type SheetLayout = 'a3-split' | 'a4-single'

interface SheetSpec {
  pageWidth: number
  pageHeight: number
  /** 页面四周留白 */
  padding: number
  /** 每页几个答题面板 */
  panelsPerPage: 1 | 2
  /** 两栏之间的竖向虚线间隔 */
  panelGap: number
  /**
   * 抬头高度。首页与续页**用同一个高度**：
   * 续页也要重复姓名/准考证号与注意事项，才能把抬头填满、不让内容溢出到答题区上。
   */
  headerFirst: number
  /** 页脚高度（页码 / 全卷到此结束） */
  footer: number
  /** 面板内题目小标题占用的高度 */
  panelHeading: number
}

export const SHEET_SPECS: Record<SheetLayout, SheetSpec> = {
  // 抬头 68 是反推的：让每个答题栏正好放下 24 行（= 600 格 @25 格/行）
  // 420 - 0.6×2(边框) - 9.4×2 - 8 = 392，两栏各 196
  'a3-split': {
    pageWidth: 420,
    pageHeight: 297,
    padding: 9.4,
    panelsPerPage: 2,
    panelGap: 8,
    headerFirst: 68,
    footer: 8,
    panelHeading: 7,
  },
  // 210 - 0.6×2(边框) - 6.4×2 = 196，正好也是 196
  //
  // 抬头 74 / 页脚 10 是反推出来的：每行 25 格时格子 7.84mm，
  // 要让一页 A4 正好放下 600 格（24 行 × 25 格）：
  //   可用高度 = 297 - 7×2 - 抬头 - 页脚，再减面板标题 7mm，除以 7.84 必须恰好落在 [24, 25)
  // 改抬头/页脚/留白时务必重新验算（有测试盯着「25 格一行 = 600 格一页」）。
  'a4-single': {
    pageWidth: 210,
    pageHeight: 297,
    padding: 6.4,
    panelsPerPage: 1,
    panelGap: 0,
    headerFirst: 74,
    footer: 10,
    panelHeading: 7,
  },
}

/** 两种版式共用的栏宽（mm）—— 格子大小不变靠的就是它 */
export const PANEL_WIDTH_MM = 196

/**
 * CSS 里会吃掉尺寸的两处，几何必须扣掉，否则格子会溢出纸张：
 *   · .sheet-page 的红色边框（sheet.css 里是 0.6mm，四周共 1.2mm）
 *   · .sheet-body 的上内边距（把抬头和答题区隔开，2mm）
 * 改这两处 CSS 时记得同步改这里（有测试盯着「内容不溢出纸张」）。
 */
const PAGE_BORDER_MM = 0.6
const BODY_PADDING_TOP_MM = 2

export interface SheetGeometry {
  layout: SheetLayout
  /** 页面宽高（mm） */
  pageWidth: number
  pageHeight: number
  /** 页面四周留白 */
  padding: number
  headerFirst: number
  footer: number
  panelGap: number
  panelHeading: number
  /** 每页面板数 */
  panelsPerPage: 1 | 2
  /** 每行格数 */
  columns: number
  /** 方格边长（mm）—— 正方形，且两种版式一致 */
  cell: number
  /** 可用内容宽度 */
  contentWidth: number
  /** 单个面板宽度 */
  panelWidth: number
  /** 指定页每面板可用高度 */
  panelHeight: (pageIndex: number) => number
  /** 指定页每面板可容纳的行数 */
  rowsForPage: (pageIndex: number) => number
}

export interface GeometryOptions {
  columns?: number
  layout?: SheetLayout
}

export function computeGeometry(options: GeometryOptions = {}): SheetGeometry {
  const layout = options.layout ?? 'a3-split'
  const spec = SHEET_SPECS[layout]
  const columns = Math.max(1, Math.floor(options.columns ?? 20))

  const contentWidth = spec.pageWidth - PAGE_BORDER_MM * 2 - spec.padding * 2
  const panelWidth = (contentWidth - spec.panelGap * (spec.panelsPerPage - 1)) / spec.panelsPerPage
  const cell = panelWidth / columns

  // 注意：首页与续页的可用高度完全相同 —— 这样每一页都正好放 24 行（600 格）
  const panelHeight = (_pageIndex: number) =>
    spec.pageHeight - PAGE_BORDER_MM * 2 - spec.padding * 2 - spec.headerFirst - spec.footer - BODY_PADDING_TOP_MM

  const rowsForPage = (pageIndex: number) => {
    const usable = panelHeight(pageIndex) - spec.panelHeading
    return Math.max(1, Math.floor(usable / cell))
  }

  return {
    layout,
    pageWidth: spec.pageWidth,
    pageHeight: spec.pageHeight,
    padding: spec.padding,
    headerFirst: spec.headerFirst,
    footer: spec.footer,
    panelGap: spec.panelGap,
    panelHeading: spec.panelHeading,
    panelsPerPage: spec.panelsPerPage,
    columns,
    cell,
    contentWidth,
    panelWidth,
    panelHeight,
    rowsForPage,
  }
}

/**
 * 决定用哪种版式。
 *
 * · 整卷模式：永远 A3 横向左右两栏 —— 不同题目本来就该排在左右两半。
 * · 单题练习：**装得进一页 A4 纵向就用 A4**（一栏到底）。
 *   否则一道 300 字的题会占掉 A3 的左半页、右半页永远空着，看着别扭。
 *   装不下（比如 800 字大作文）再回到 A3 左右两栏，那样一页能放下更多内容。
 *
 * 注意：两种版式的格子大小是一样的，缩小的只是纸张。
 *
 * @param capacityRows 这道题需要多少行（= 容量 ÷ 每行格数，向上取整）
 */
export function chooseLayout(
  columns: number,
  capacityRows: number,
  mode: 'single' | 'full',
): SheetLayout {
  if (mode === 'full') return 'a3-split'
  const single = computeGeometry({ columns, layout: 'a4-single' })
  return capacityRows <= single.rowsForPage(0) ? 'a4-single' : 'a3-split'
}

/** 生成供 CSS 变量使用的键值对（单位 mm） */
export function geometryToCssVars(geo: SheetGeometry): Record<string, string> {
  return {
    '--page-w': `${geo.pageWidth}mm`,
    '--page-h': `${geo.pageHeight}mm`,
    '--page-padding': `${geo.padding}mm`,
    '--header-first': `${geo.headerFirst}mm`,
    '--footer-h': `${geo.footer}mm`,
    '--panel-gap': `${geo.panelGap}mm`,
    '--panel-heading': `${geo.panelHeading}mm`,
    '--cell': `${geo.cell}mm`,
    '--cols': String(geo.columns),
    '--panel-w': `${geo.panelWidth}mm`,
    '--content-w': `${geo.contentWidth}mm`,
  }
}

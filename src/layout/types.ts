/**
 * 申论方格答题卡 —— 排版引擎核心类型
 *
 * 设计原则：逻辑文本（logical text）与视觉格子（visual cell）完全分离。
 *
 *   Paragraph → Token → Cell → Row → Panel → Page
 *
 * - Token 是逻辑单位（一个不可再分的输入片段）
 * - Cell 是视觉单位（答题卡上的一个方格）
 * - 一个 Token 可以占 1 格、2 格，或与另一个 Token 共用一个格
 * - Token 的边界与 Cell 的边界**不要求一一对应**
 */

// ---------------------------------------------------------------------------
// 字符类别
// ---------------------------------------------------------------------------

/**
 * 字符类别 —— 描述单个字符在方格纸排版中的行为。
 *
 * 基础层参考 GB/T 15834-2011《标点符号用法》，
 * 适配层参考申论答题卡书写约定（见 profile.ts / README.md）。
 */
export type CharClass =
  /** 汉字及全角宽字符 */
  | 'CJK'
  /** 句末点号：。！？ */
  | 'PUNCT_END'
  /** 句内点号：，、；： */
  | 'PUNCT_INNER'
  /** 其他标点（间隔号、连接号等） */
  | 'PUNCT_OTHER'
  /** 开引号 / 开括号 / 开书名号：“ ‘ 「 『 （ 〔 ［ ｛ 《 〈 【 */
  | 'OPEN_PUNCT'
  /** 闭引号 / 闭括号 / 闭书名号：” ’ 」 』 ） 〕 ］ ｝ 》 〉 】 */
  | 'CLOSE_PUNCT'
  /** 阿拉伯数字 0-9 */
  | 'DIGIT'
  /** 拉丁字母 A-Za-z */
  | 'LATIN'
  /** 空白（半角空格、全角空格、制表符） */
  | 'SPACE'
  /** 破折号 —— */
  | 'DASH'
  /** 省略号 …… */
  | 'ELLIPSIS'
  /** 换行 \n */
  | 'LINE_BREAK'
  /** 其他（emoji、生僻符号等） */
  | 'OTHER'

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** Token 的逻辑类型 */
export type TokenType =
  | 'CHAR'
  | 'PUNCT'
  | 'OPEN_PUNCT'
  | 'CLOSE_PUNCT'
  | 'COMPOUND_PUNCT'
  | 'NUMBER'
  | 'ENGLISH'
  | 'SPACE'
  | 'LINE_BREAK'
  | 'DASH'
  | 'ELLIPSIS'
  | 'OTHER'

export interface Token {
  /** 在本次布局中的稳定序号，用于 React key 与调试 */
  id: number
  type: TokenType
  charClass: CharClass
  /** 原始逻辑文本（可能包含多个字符，如 "2026" / "——" / "：“"） */
  rawText: string
  /** 在排版输入文本中的起始下标（含） */
  sourceStart: number
  /** 在排版输入文本中的结束下标（不含） */
  sourceEnd: number
  /** 占用的答题格数（逻辑宽度） */
  cellWidth: number
  /**
   * 不可拆行：换行时该 Token 必须整体落到同一行。
   * 破折号 / 省略号 / 数字串 / 英文串 = true
   */
  unbreakable: boolean
  /**
   * 光标整体移动：方向键 / 退格 / 删除键把该 Token 当作一个整体。
   * 破折号 / 省略号 / 复合标点 / 代理对字符 = true；数字与英文 = false
   */
  caretAtomic: boolean
  /** 复合标点命中的组合键（如 '：“'），仅 COMPOUND_PUNCT 有值 */
  compoundKey?: string
  /**
   * 预计算的分格切片（数字串专用：2026 → [0,2) [2,4)；10000 → [0,2) [2,4) [4,5)）。
   * 缺省时由布局引擎按「尽量平均、余数靠前」自动切分。
   */
  slices?: Array<{ start: number; end: number }>
}

// ---------------------------------------------------------------------------
// 复合标点规则
// ---------------------------------------------------------------------------

/** 字形在格子内的相对位置（0~1 比例坐标，x/y 为字形中心） */
export interface GlyphPlacement {
  /** 该字形在 token.rawText 中的起始下标（含） */
  start: number
  /** 该字形在 token.rawText 中的结束下标（不含） */
  end: number
  /** 该字形落在组合的第几个格（0 起） */
  cell: number
  /** 字形中心相对格子的横坐标，0 = 左边缘，1 = 右边缘 */
  x: number
  /** 字形中心相对格子的纵坐标，0 = 上边缘，1 = 下边缘 */
  y: number
  /** 相对正常字号的缩放 */
  scale: number
  /** 供调试面板 / 文档使用的可读标签 */
  label: string
}

/**
 * 复合标点规则：多个标点字符合并占用 cellCount 个格。
 *
 * 依据：申论方格纸书写约定（连续标点组合） + GB/T 15834-2011（问号叹号叠用）。
 * 未在表中定义的组合一律按普通规则分别占格。
 */
export interface CompoundRule {
  /** 组合串原文，如 '：“' */
  key: string
  /** 占用格数 */
  cellCount: number
  /** 各字形的格内位置 */
  glyphs: GlyphPlacement[]
  /** 规则依据说明，导出 README / 调试面板用 */
  note?: string
}

// ---------------------------------------------------------------------------
// 标点规则表
// ---------------------------------------------------------------------------

export interface PunctSpec {
  char: string
  charClass: CharClass
  /** 占格数 */
  cellWidth: number
  /** 禁止出现在行首（避头） */
  noLineStart: boolean
  /** 禁止出现在行尾（避尾） */
  noLineEnd: boolean
  /** 行首遇阻时是否允许与前字挤占同格 */
  squeezableAtLineEnd: boolean
}

// ---------------------------------------------------------------------------
// 排版配置（LayoutProfile）
// ---------------------------------------------------------------------------

export type LineEndStrategy =
  /** 标点与前一个汉字共用最后一格（申论答题卡常见做法，默认） */
  | 'squeeze'
  /** 把最后一格的字连同标点一起移到下一行（避头点） */
  | 'pull-down'
  /** 不做处理，允许标点出现在下一行行首 */
  | 'allow'

export interface LayoutProfile {
  // ---- 网格 ----
  /** 每行格数 */
  columns: number
  /** 每个答题区（面板）的行数 */
  rowsPerPanel: number
  /** 每满多少格在行末标注一次格数（0 = 不标） */
  milestoneStep: number

  // ---- 占格宽度 ----
  /** 汉字占格数 */
  chineseCharWidth: number
  /** 普通中文标点占格数 */
  normalPunctuationWidth: number
  /** 破折号占格数 */
  dashWidth: number
  /** 省略号占格数 */
  ellipsisWidth: number
  /** 几个阿拉伯数字占一格 */
  arabicDigitsPerCell: number
  /** 几个英文字母占一格 */
  englishCharsPerCell: number
  /** 空格占格数 */
  spaceWidth: number

  // ---- 行首 / 行尾规则 ----
  /** 行末标点压缩（挤占同格）总开关 */
  endOfLinePunctuationCompression: boolean
  /** 允许开引号出现在行首（国标：开引号可以在行首） */
  allowOpeningPunctuationAtLineStart: boolean
  /** 禁止闭引号出现在行首（国标：闭引号不可在行首） */
  preventClosingPunctuationAtLineStart: boolean
  /** 禁止开引号出现在行尾（国标：开引号不可在行尾） */
  preventOpeningPunctuationAtLineEnd: boolean
  /** 行末策略 */
  lineEndStrategy: LineEndStrategy
  /** 破折号 / 省略号在行末只剩 1 格时压缩进 1 格（否则整体移到下一行） */
  compressWideTokenAtLineEnd: boolean

  // ---- 复合标点 ----
  /** 启用复合标点组合表 */
  compoundPunctuation: boolean

  // ---- 数字 / 英文 ----
  /** 连续数字两两成组（2026 → [20][26]） */
  pairArabicDigits: boolean
  /** 数字串不可被换行打断 */
  keepNumberIntact: boolean
  /** 英文串不可被换行打断 */
  keepEnglishIntact: boolean

  // ---- 段落 ----
  /** 正文默认段首缩进格数 */
  defaultIndentCells: number
  /** 全局开关：正文段首自动缩进 */
  autoIndentFirstLine: boolean

  // ---- 标点表 ----
  punctuation: Record<string, PunctSpec>
  /** 复合标点组合表 */
  compoundRules: Record<string, CompoundRule>
  /** 破折号字符 */
  dashChar: string
  /** 省略号字符 */
  ellipsisChar: string
}

// ---------------------------------------------------------------------------
// 段落
// ---------------------------------------------------------------------------

export type ParagraphKind = 'normal' | 'title' | 'subtitle'
export type ParagraphAlign = 'left' | 'center' | 'right'

export interface ParagraphMeta {
  kind: ParagraphKind
  align: ParagraphAlign
  /** 段首缩进格数（0 / 1 / 2 ...） */
  indentCells: number
}

// ---------------------------------------------------------------------------
// 布局结果：Cell / Row / Panel / Page
// ---------------------------------------------------------------------------

/** 单元格内的一个占位者（通常 1 个，挤占 / 复合时为多个） */
export interface CellOccupant {
  tokenId: number
  /** 在 token.rawText 中显示的切片 [sliceStart, sliceEnd) */
  sliceStart: number
  sliceEnd: number
  /**
   * 渲染方式：
   * - normal      普通占格
   * - squeezed    行末被挤占进来的标点，依附在本格右下角
   * - compressed  2 格宽的 Token（破折号/省略号）压缩进 1 格
   */
  render: 'normal' | 'squeezed' | 'compressed'
  /** 覆盖时的手工字形位置（挤占标点用），缺省由渲染层决定 */
  glyph?: { x: number; y: number; scale: number }
}

export interface Cell {
  /** 文档内绝对行号 */
  row: number
  /** 该行在面板内的行号 */
  rowInPanel: number
  /** 格内列号 0..columns-1 */
  column: number
  /** 该格显示的占位者，空占位格为 [] */
  occupants: CellOccupant[]
  /** 该格覆盖的源文本区间 [sourceStart, sourceEnd) */
  sourceStart: number
  sourceEnd: number
  /** 供渲染层使用的完整显示文本（复合标点 / 数字切片） */
  display: string
  /** 复合标点的字形排布 */
  glyphs?: GlyphPlacement[]
  /** 是否为空白占位格 */
  empty: boolean
  /** 所属段落序号 */
  paragraph: number
  /** 是否落在超出容量的溢出区 */
  overflow: boolean
}

export interface Row {
  /** 文档内绝对行号（从 0 开始，跨面板连续） */
  index: number
  /** 该行在所属面板中的行号 */
  rowInPanel: number
  /** 该行所属面板的全局序号 */
  panelIndex: number
  /** 该行所属页面的全局序号 */
  pageIndex: number
  cells: Cell[]
  /** 所属段落序号 */
  paragraph: number
  /** 该行的段落样式 */
  kind: ParagraphKind
  align: ParagraphAlign
  /** 用户真实 Enter 产生的空行 */
  isBlankLine: boolean
  /** 是否为容量之外的补齐行 */
  isPadding: boolean
  /** 是否溢出 */
  overflow: boolean
  /** 该行是否为面板的续行（上一面板承接而来） */
  isContinuation: boolean
  /**
   * 行末右侧要标注的格数（真实答题卡上每满 100 格会印一个计数）。
   * 通常只有一项；整题末尾那一行会额外带上「本题共用了多少格」。
   */
  markers: number[]
}

export interface Panel {
  /** 面板全局序号 */
  index: number
  /** 所属页面序号 */
  pageIndex: number
  /** 该面板在页面中的位置：左侧 / 右侧 */
  slot: 0 | 1
  blockId: string
  blockTitle: string
  /** 本面板承载的行 */
  rows: Row[]
  /** 本面板应绘制的网格行数（含空白补齐行） */
  regionRows: number
  /** 本面板是否为该题目的续页 */
  isContinuation: boolean
  /** 本面板是否全部落在溢出区 */
  overflow: boolean
  /** 题目要求的容量（格数） */
  capacity: number
}

export interface Page {
  index: number
  /** first = 首页（带答题卡抬头），continuation = 续页（带"接上页"抬头） */
  kind: 'first' | 'continuation'
  panels: Panel[]
}

/** 段落布局信息（导出与渲染共用） */
export interface ParagraphLayoutInfo {
  index: number
  text: string
  meta: ParagraphMeta
  /** 起始行号 */
  startRow: number
  /** 结束行号（不含） */
  endRow: number
  /** token 数量 */
  tokenCount: number
  /** 视觉占格总数 */
  cellWidth: number
}

// ---------------------------------------------------------------------------
// 排版输入
// ---------------------------------------------------------------------------

/** 一个答题块（一道题）的排版输入 */
export interface BlockLayoutInput {
  blockId: string
  /** 题目标题，如「第（一）大题 第1小题」 */
  blockTitle: string
  /** 逻辑文本（含用户真实输入的换行） */
  text: string
  /** 目标容量，单位是「格」 */
  capacity: number
  /** 与 text.split('\n') 一一对应的段落样式 */
  paragraphs?: Array<Partial<ParagraphMeta>>
}

/** 单块排版结果（行 / 格 / Token / 统计） */
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
  /** 归一化后的文本（与所有 offset 对应） */
  text: string
}

/** 整卷排版结果 */
export interface DocumentLayout {
  blocks: BlockLayoutResult[]
  pages: Page[]
  panels: Panel[]
}

export interface LayoutOptions {
  profile: LayoutProfile
  /** 每页面板数：1 = 通栏，2 = 左半 + 右半 */
  panelsPerPage?: number
  /** 指定每页每个面板的行数 */
  rowsPerPanelForPage?: (pageIndex: number) => number
}

export interface LayoutResult {
  blockId: string
  blockTitle: string
  pages: Page[]
  panels: Panel[]
  rows: Row[]
  cells: Cell[]
  tokens: Token[]
  paragraphs: ParagraphLayoutInfo[]
  /** 逻辑字符数（按码点计） */
  logicalCharCount: number
  /** 实际占用格数 */
  occupiedCellCount: number
  /** 目标容量（格数） */
  capacityCells: number
  /** 容量对应的行数 */
  capacityRows: number
  /** 是否超出容量 */
  overflow: boolean
  /** 溢出格数 */
  overflowCells: number
  /** 排版过程中触发的规则记录（用于调试面板与测试断言） */
  rules: RuleEvent[]
}

// ---------------------------------------------------------------------------
// 规则事件（可观测性：测试与调试面板都依赖它）
// ---------------------------------------------------------------------------

/**
 * 只记录「非平凡的取舍」——即那些如果换一套规则就会有不同结果的决策。
 * 常规的逐字排格、复合标点命中、数字分组都是常态，不产生事件。
 */
export type RuleEventType =
  /** 行末挤占：标点与前一个字共用最后一格 */
  | 'line-end-squeeze'
  /** 避头下拉：前一个字与标点一起移到下一行 */
  | 'line-end-pull-down'
  /** 行末压缩：破折号 / 省略号压进 1 格 */
  | 'line-end-compress'
  /** 兜底：标点无法避让，被迫落在行首 */
  | 'line-start-punct-allowed'
  /** 行尾禁则：开符号从行尾移走 */
  | 'open-punct-moved-from-line-end'
  /** 超长 Token（宽过整行）被强制拆分 */
  | 'forced-split'

export interface RuleEvent {
  type: RuleEventType
  /** 触发的文本 offset */
  offset: number
  /** 相关 token */
  tokenId: number
  detail: string
}

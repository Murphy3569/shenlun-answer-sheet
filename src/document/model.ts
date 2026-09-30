/**
 * 文档模型
 *
 * 关键约定：**不存一个大字符串**，而是存「段落 + 段落样式」。
 *
 *   AnswerSheet
 *     └─ AnswerBlock（一道题 = 一个答题块 = 一个独立 textarea）
 *          ├─ text            用户输入的原始逻辑文本（含真实换行）
 *          └─ paragraphStyles 与 text.split('\n') 一一对应
 *
 * 答题卡布局：Paragraph → Tokenize → Layout
 * 导出：      Paragraph → Word/PDF formatter
 * 同一份数据，两种出口，互不干扰。
 */

import { normalizeText } from '../layout'
import type { ParagraphAlign, ParagraphKind } from '../layout'

export interface ParagraphStyle {
  kind: ParagraphKind
  align: ParagraphAlign
  /** 段首缩进格数（0 = 顶格） */
  indentCells: number
}

export interface AnswerBlock {
  id: string
  /** 题目标题，如「第（一）大题 第1小题」 */
  title: string
  /** 目标容量，单位是「格」 */
  capacity: number
  /** 用户输入的逻辑文本 */
  text: string
  /** 与 text.split('\n') 一一对应的段落样式 */
  paragraphStyles: ParagraphStyle[]
  /** 该题是否启用段首缩进（小题通常顶格，大作文/应用文空两格） */
  indentFirstLine: boolean
}

export type SheetMode = 'single' | 'full'

export interface AnswerSheet {
  mode: SheetMode
  blocks: AnswerBlock[]
  /** 排版配置预设名（见 LAYOUT_PRESETS） */
  profileKey: string
  /** 每行格数 */
  columns: number
  /** 是否显示答题卡的装饰模板（红色边框 / 三角定位 / 抬头 / 页码） */
  showTemplate: boolean
}

// ---------------------------------------------------------------------------
// 段落拆分
// ---------------------------------------------------------------------------

export function splitParagraphs(text: string): string[] {
  return normalizeText(text).split('\n')
}

export function defaultParagraphStyle(indentFirstLine: boolean, defaultIndent = 2): ParagraphStyle {
  return {
    kind: 'normal',
    align: 'left',
    indentCells: indentFirstLine ? defaultIndent : 0,
  }
}

/** 保证样式数组长度与段落数一致 */
export function alignStyles(styles: ParagraphStyle[], paragraphCount: number, indentFirstLine: boolean): ParagraphStyle[] {
  const out = styles.slice(0, paragraphCount)
  while (out.length < paragraphCount) out.push(defaultParagraphStyle(indentFirstLine))
  return out
}

// ---------------------------------------------------------------------------
// 文本变化时的段落样式迁移
// ---------------------------------------------------------------------------

/**
 * 判断新旧两个段落是否「同一段」。
 *
 * 不能只比全等：用户在段内打字，段落文本一直在变，判为不同段就会丢样式。
 * 采用「共同前缀或共同后缀至少占较短一方的一半」作为同一段的判据，
 * 这样在段首、段中、段尾增删字都不会丢失段落样式。
 */
function sameParagraph(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length === 0 || b.length === 0) return false
  const min = Math.min(a.length, b.length)
  const need = Math.max(1, Math.floor(min / 2))
  let prefix = 0
  while (prefix < min && a[prefix] === b[prefix]) prefix += 1
  if (prefix >= need) return true
  let suffix = 0
  while (suffix < min && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  return suffix >= need
}

/**
 * 文本变化后重新对齐段落样式。
 *
 * 用 LCS 找出「同一段」，把它们的样式搬到新位置上；
 * 新增段落继承它前面那一段的样式（在标题后回车 → 新行仍是标题风格），
 * 删掉的段落样式自然消失。段落数通常 < 50，O(n·m) 完全够用。
 */
export function reconcileParagraphStyles(
  oldText: string,
  oldStyles: ParagraphStyle[],
  newText: string,
  indentFirstLine: boolean,
): ParagraphStyle[] {
  const oldParas = splitParagraphs(oldText)
  const newParas = splitParagraphs(newText)

  if (oldText === newText) {
    return alignStyles(oldStyles, newParas.length, indentFirstLine)
  }

  // 段落数没变 —— 这是最常见的编辑（在段内打字、删字、改标点）。
  // 直接按下标对位，样式老老实实待在原地，绝不会被邻段吞掉。
  if (oldParas.length === newParas.length) {
    return alignStyles(oldStyles, newParas.length, indentFirstLine)
  }

  // 用「打分」对齐，而不是单纯数匹配条数：**完全相同**的段落权重高于「相似」的段落。
  //
  // 只数条数的话，删掉一段时被删的那段会和幸存段模糊匹配上（相邻段落往往长得很像），
  // 于是被删段落的样式落到幸存段落头上 —— 那段文字一个字都没动，格式却变了。
  // 打分之后，「精确匹配到幸存段」会压过「模糊匹配到被删段」。
  const scoreOf = (i: number, j: number): number => {
    if (oldParas[i] === newParas[j]) return 2
    return sameParagraph(oldParas[i], newParas[j]) ? 1 : -1
  }

  const n = oldParas.length
  const m = newParas.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const score = scoreOf(i, j)
      const diagonal = score > 0 ? score + dp[i + 1][j + 1] : -1
      dp[i][j] = Math.max(diagonal, dp[i + 1][j], dp[i][j + 1])
    }
  }

  const mapped: Array<ParagraphStyle | null> = new Array(m).fill(null)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const score = scoreOf(i, j)
    if (score > 0 && dp[i][j] === score + dp[i + 1][j + 1]) {
      mapped[j] = oldStyles[i] ?? defaultParagraphStyle(indentFirstLine)
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }

  // 未匹配的新段落：继承前一段的样式
  const out: ParagraphStyle[] = []
  let carry: ParagraphStyle = defaultParagraphStyle(indentFirstLine)
  for (let k = 0; k < m; k++) {
    const s = mapped[k]
    if (s) carry = s
    out.push({ ...carry })
  }
  return out
}

// ---------------------------------------------------------------------------
// 纯文本导出（复制用）
// ---------------------------------------------------------------------------

/** 单块原始文本 —— 不含任何方格、页码、自动换行 */
export function blockToPlainText(block: AnswerBlock): string {
  return normalizeText(block.text)
}

/**
 * 整卷原始文本。
 *
 * 多题时带上题号（与导出 Word/PDF 的写法一致），否则复制出来的几段答案分不清是哪一题；
 * 只有一道题时保持纯净，不加任何前缀。
 */
export function sheetToPlainText(sheet: AnswerSheet): string {
  if (sheet.blocks.length === 1) return blockToPlainText(sheet.blocks[0])
  return sheet.blocks.map((b) => `【${b.title}】\n${blockToPlainText(b)}`).join('\n\n')
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

let blockSeq = 0

export function createBlock(title: string, capacity: number, indentFirstLine = true): AnswerBlock {
  blockSeq += 1
  return {
    id: `block-${blockSeq}-${title}`,
    title,
    capacity,
    text: '',
    paragraphStyles: [defaultParagraphStyle(indentFirstLine)],
    indentFirstLine,
  }
}

/** 参考答题卡的整卷结构：四道小题 + 一道大作文 */
export const FULL_PAPER_TEMPLATE: Array<{ title: string; capacity: number; indent: boolean }> = [
  { title: '第一题', capacity: 200, indent: false },
  { title: '第二题', capacity: 200, indent: false },
  { title: '第三题', capacity: 300, indent: false },
  { title: '第四题', capacity: 400, indent: false },
  { title: '第五题', capacity: 1000, indent: true },
]

export function createFullPaper(): AnswerBlock[] {
  return FULL_PAPER_TEMPLATE.map((t) => createBlock(t.title, t.capacity, t.indent))
}

export function createSheet(mode: SheetMode, capacity = 300): AnswerSheet {
  return {
    mode,
    blocks: mode === 'full' ? createFullPaper() : [createBlock('第一题', capacity, true)],
    profileKey: 'shenlun',
    columns: DEFAULT_COLUMNS,
    showTemplate: true,
  }
}

export const CAPACITY_PRESETS = [150, 200, 300, 400, 500, 600, 800, 1000, 1200, 1500]

/** 题号用的中文数字 */
export const CN_NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']

/**
 * 追加一道题：题号接在**已有题号**之后，命名成「第六题」「第七题」……
 *
 * 不能按块数取号：删掉中间一题后块数就比最大题号小，新题会撞号
 * （实测会出现两个「第五题」）。而题号会原样进入「复制整卷」和 Word/PDF 导出的小标题，
 * 撞号之后两道不同题目的答案在导出文本里就分不出来了。
 */
export function appendBlock(blocks: AnswerBlock[], capacity = 300, indentFirstLine = true): AnswerBlock {
  const used = blocks
    .map((b) => CN_NUMBERS.indexOf(b.title.replace(/^第|题$/g, '')) + 1)
    .filter((n) => n > 0)
  const n = (used.length > 0 ? Math.max(...used) : blocks.length) + 1
  const label = CN_NUMBERS[n - 1] ?? String(n)
  return createBlock(`第${label}题`, capacity, indentFirstLine)
}

/** 答题卡默认每行格数（真实申论答题卡常见 25 格/行） */
export const DEFAULT_COLUMNS = 25

/** 每行格数可选值 */
export const COLUMN_OPTIONS = [20, 25, 30, 35]

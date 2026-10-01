/**
 * 标点规则表
 *
 * 本文件刻意分成两层，**不要混为一谈**：
 *
 *  ┌─ 基础层：GB/T 15834-2011《标点符号用法》+ W3C clreq 禁则
 *  │    · 标点分类（点号 / 标号）
 *  │    · 行首禁则（避头）：句末点号、句内点号、闭引号/闭括号/闭书名号
 *  │    · 行尾禁则（避尾）：开引号、开括号、开书名号、分隔号
 *  │    · 破折号、省略号各占两个字位置，内部不可拆行
 *  │    · 问号叹号叠用占一个字位置，三个叠用占两个字位置
 *  │
 *  └─ 适配层：申论方格答题卡书写约定
 *       · 连续标点组合压进同一格（：“ 。” ”。 ？！）
 *       · 行末标点挤占（句末点号写在前一格的右下角）
 *
 * 两层规则都通过 LayoutProfile 暴露，改规则只改 profile，不动引擎。
 * 详细依据与取舍见 README.md「规则依据」一节。
 */

import type { CharClass, CompoundRule, GlyphPlacement, LayoutProfile, PunctSpec } from './types'

// ---------------------------------------------------------------------------
// 字符集合
// ---------------------------------------------------------------------------

/** 句末点号（国标：。！？） */
export const PUNCT_END_CHARS = '。！？．'

/** 句内点号（国标：，、；：） */
export const PUNCT_INNER_CHARS = '，、；：'

/** 开引号 / 开括号 / 开书名号 —— 禁行尾、不参与挤占 */
export const OPEN_PUNCT_CHARS = '“‘「『〝（〔［【｛《〈＜[{' // eslint-disable-line

/** 闭引号 / 闭括号 / 闭书名号 —— 禁行首、可挤占 */
export const CLOSE_PUNCT_CHARS = '”’」』〞〟）〕］】｝》〉＞]}'

/** 其他标点：连接号（一字线/浪纹线）、间隔号等 */
export const PUNCT_OTHER_CHARS = '·・･～〜'

/** 分隔号：既禁行首也禁行尾（clreq） */
export const SEPARATOR_CHARS = '／/'

/** 破折号字符：连续两个 U+2014 / U+2015 */
export const DASH_CHARS = '—―'

/** 自身就等于一个破折号的字符（U+2E3A 双倍长破折号），单独占两格 */
export const SINGLE_DASH_CHARS = '⸺'

/** 省略号字符（U+2026 与 U+22EF） */
export const ELLIPSIS_CHARS = '…⋯'

/** 半角 ASCII 标点的等价分类（用户可能误用半角） */
const ASCII_PUNCT_CLASS: Record<string, CharClass> = {
  ',': 'PUNCT_INNER',
  '.': 'PUNCT_END',
  ';': 'PUNCT_INNER',
  ':': 'PUNCT_INNER',
  '!': 'PUNCT_END',
  '?': 'PUNCT_END',
  '(': 'OPEN_PUNCT',
  '[': 'OPEN_PUNCT',
  '{': 'OPEN_PUNCT',
  '<': 'OPEN_PUNCT',
  ')': 'CLOSE_PUNCT',
  ']': 'CLOSE_PUNCT',
  '}': 'CLOSE_PUNCT',
  '>': 'CLOSE_PUNCT',
}

function fullWidthClass(ch: string): CharClass | null {
  if (PUNCT_END_CHARS.includes(ch)) return 'PUNCT_END'
  if (PUNCT_INNER_CHARS.includes(ch)) return 'PUNCT_INNER'
  if (OPEN_PUNCT_CHARS.includes(ch)) return 'OPEN_PUNCT'
  if (CLOSE_PUNCT_CHARS.includes(ch)) return 'CLOSE_PUNCT'
  if (SEPARATOR_CHARS.includes(ch)) return 'PUNCT_OTHER'
  if (PUNCT_OTHER_CHARS.includes(ch)) return 'PUNCT_OTHER'
  return null
}

// ---------------------------------------------------------------------------
// 字符宽度判定（East Asian Width）
// ---------------------------------------------------------------------------

/** 是否为「宽字符」（汉字、假名、谚文、全角形式等，占 1 个答题格） */
export function isWideChar(ch: string): boolean {
  const c = ch.codePointAt(0)
  if (c === undefined) return false
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe10 && c <= 0xfe19) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f9ff) || // emoji 视作宽字符
    (c >= 0x20000 && c <= 0x3fffd)
  )
}

/** 是否为需要整体移动光标的字符（代理对，如 emoji） */
export function isAstral(ch: string): boolean {
  const c = ch.codePointAt(0)
  return c !== undefined && c > 0xffff
}

export function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

export function isLatin(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

export function isSpaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '　' || ch === ' '
}

export function isDashChar(ch: string): boolean {
  return DASH_CHARS.includes(ch)
}

/** 单字符破折号（本身占两格） */
export function isSingleDashChar(ch: string): boolean {
  return SINGLE_DASH_CHARS.includes(ch)
}

export function isEllipsisChar(ch: string): boolean {
  return ELLIPSIS_CHARS.includes(ch)
}

/** 跟在数字后面、与数字不可分割的单位符号 */
export const NUMBER_TRAILING_UNITS = '%‰°℃℉％'

/** 出现在数字中间的连接符（小数点、日期分隔、编号分隔） */
export const NUMBER_INNER_JOINERS = '.-/:'

/**
 * 单字符分类。
 * 注意：复合标点（如 "：“"）不是单字符能判定的，由 tokenizer 先行匹配。
 */
export function classifyChar(ch: string): CharClass {
  if (ch === '\n' || ch === '\r') return 'LINE_BREAK'
  if (isSpaceChar(ch)) return 'SPACE'
  if (isDigit(ch)) return 'DIGIT'
  if (isLatin(ch)) return 'LATIN'
  if (isDashChar(ch)) return 'DASH'
  if (isEllipsisChar(ch)) return 'ELLIPSIS'
  const fw = fullWidthClass(ch)
  if (fw) return fw
  const ascii = ASCII_PUNCT_CLASS[ch]
  if (ascii) return ascii
  if (isWideChar(ch)) return 'CJK'
  return 'OTHER'
}

// ---------------------------------------------------------------------------
// 标点规格表（占格 / 行首禁则 / 行尾禁则）
// ---------------------------------------------------------------------------

function punct(char: string, charClass: CharClass, width: number): PunctSpec {
  const noLineStart =
    charClass === 'PUNCT_END' ||
    charClass === 'PUNCT_INNER' ||
    charClass === 'CLOSE_PUNCT' ||
    SEPARATOR_CHARS.includes(char)
  const noLineEnd = charClass === 'OPEN_PUNCT' || SEPARATOR_CHARS.includes(char)
  return {
    char,
    charClass,
    cellWidth: width,
    noLineStart,
    noLineEnd,
    // 开符号绝不允许被挤占到前字右下角 —— 会被读成闭符号，语义完全错乱。
    // 分隔号同时禁行首与行尾，唯一合法出路就是挤占，所以必须允许。
    squeezableAtLineEnd:
      charClass === 'PUNCT_END' ||
      charClass === 'PUNCT_INNER' ||
      charClass === 'CLOSE_PUNCT' ||
      SEPARATOR_CHARS.includes(char),
  }
}

let cachedPunctuationTable: Record<string, PunctSpec> | null = null

/** 构建标点规格表（结果缓存） */
export function buildPunctuationTable(): Record<string, PunctSpec> {
  if (cachedPunctuationTable) return cachedPunctuationTable
  const table: Record<string, PunctSpec> = {}
  for (const ch of PUNCT_END_CHARS) table[ch] = punct(ch, 'PUNCT_END', 1)
  for (const ch of PUNCT_INNER_CHARS) table[ch] = punct(ch, 'PUNCT_INNER', 1)
  for (const ch of OPEN_PUNCT_CHARS) table[ch] = punct(ch, 'OPEN_PUNCT', 1)
  for (const ch of CLOSE_PUNCT_CHARS) table[ch] = punct(ch, 'CLOSE_PUNCT', 1)
  for (const ch of PUNCT_OTHER_CHARS) table[ch] = punct(ch, 'PUNCT_OTHER', 1)
  for (const ch of SEPARATOR_CHARS) table[ch] = punct(ch, 'PUNCT_OTHER', 1)
  for (const [ch, cls] of Object.entries(ASCII_PUNCT_CLASS)) table[ch] = punct(ch, cls, 1)
  cachedPunctuationTable = table
  return table
}

/** 取某字符的标点规格；非标点返回 undefined */
export function getPunctSpec(ch: string, profile: LayoutProfile): PunctSpec | undefined {
  return profile.punctuation[ch]
}

// ---------------------------------------------------------------------------
// 复合标点组合表
// ---------------------------------------------------------------------------

/**
 * 格内坐标（0~1，x/y 为字形中心）。
 *
 * 不变量「先到者保持自然位置，后到者移位到空闲半区」：
 *   闭符号的自然位在左上，被压缩到第二位时移到右上；
 *   点号的自然位在左下，被压缩到第二位时移到右下。
 */
const P = {
  /** 。，、 —— 自然位：左下 */
  dotLL: { x: 0.23, y: 0.75 },
  /** ；： —— 自然位：左下偏上 */
  dotLLHigh: { x: 0.24, y: 0.68 },
  /** ？ ！ —— 自然位：居左 */
  markL: { x: 0.33, y: 0.5 },
  /** ” ’ —— 自然位：左上 */
  closeQuoteL: { x: 0.29, y: 0.24 },
  /** ） 》 —— 自然位：左中 */
  closeBracketL: { x: 0.28, y: 0.5 },
  /** “ ‘ —— 作为后到者：右上 */
  openQuoteR: { x: 0.72, y: 0.24 },
  /** （ 《 —— 作为后到者：右中 */
  openBracketR: { x: 0.7, y: 0.5 },
  /** ” ’ —— 作为后到者：右上 */
  closeQuoteR: { x: 0.72, y: 0.24 },
  /** ） 》 —— 作为后到者：右中 */
  closeBracketR: { x: 0.7, y: 0.5 },
  /** 点号作为后到者：右下 */
  dotRL: { x: 0.7, y: 0.75 },
  dotRLHigh: { x: 0.7, y: 0.68 },
  /** 问号叹号作为后到者：居右 */
  markR: { x: 0.7, y: 0.52 },
} as const

/** 组合首位的点号及其字形位置 */
const LEAD_DOTS: Record<string, { x: number; y: number }> = {
  '，': P.dotLL,
  '。': P.dotLL,
  '、': P.dotLL,
  '；': P.dotLLHigh,
  '：': P.dotLLHigh,
  '！': P.markL,
  '？': P.markL,
}

/** 组合首位的闭符号及其字形位置 */
const LEAD_CLOSERS: Record<string, { x: number; y: number }> = {
  '”': P.closeQuoteL,
  '’': P.closeQuoteL,
  '」': P.closeQuoteL,
  '』': P.closeQuoteL,
  '）': P.closeBracketL,
  '〕': P.closeBracketL,
  '］': P.closeBracketL,
  '】': P.closeBracketL,
  '｝': P.closeBracketL,
  '》': P.closeBracketL,
  '〉': P.closeBracketL,
}

/** 组合第二位的开符号及其字形位置 */
const TAIL_OPENERS: Record<string, { x: number; y: number }> = {
  '“': P.openQuoteR,
  '‘': P.openQuoteR,
  '「': P.openQuoteR,
  '『': P.openQuoteR,
  '（': P.openBracketR,
  '〔': P.openBracketR,
  '［': P.openBracketR,
  '【': P.openBracketR,
  '《': P.openBracketR,
  '〈': P.openBracketR,
}

/** 组合第二位的闭符号及其字形位置 */
const TAIL_CLOSERS: Record<string, { x: number; y: number }> = {
  '”': P.closeQuoteR,
  '’': P.closeQuoteR,
  '」': P.closeQuoteR,
  '』': P.closeQuoteR,
  '）': P.closeBracketR,
  '〕': P.closeBracketR,
  '］': P.closeBracketR,
  '】': P.closeBracketR,
  '｝': P.closeBracketR,
  '》': P.closeBracketR,
  '〉': P.closeBracketR,
}

/** 组合第二位的点号及其字形位置（P4：闭符号 + 点号） */
const TAIL_DOTS: Record<string, { x: number; y: number }> = {
  '，': P.dotRL,
  '。': P.dotRL,
  '、': P.dotRL,
  '；': P.dotRLHigh,
  '：': P.dotRLHigh,
  // 与「！” ？’」镜像对称：闭符号后面的问号叹号同样并进同一格
  '！': P.markR,
  '？': P.markR,
}

const COMPOUND_SCALE = 0.86

function glyph(
  start: number,
  end: number,
  cell: number,
  pos: { x: number; y: number },
  scale = COMPOUND_SCALE,
): GlyphPlacement {
  return { start, end, cell, x: pos.x, y: pos.y, scale, label: '' }
}

function labelGlyphs(rule: CompoundRule): CompoundRule {
  for (const g of rule.glyphs) g.label = rule.key.slice(g.start, g.end)
  return rule
}

let cachedCompoundRules: Record<string, CompoundRule> | null = null

/**
 * 构建复合标点组合表。
 *
 * 原则（重要）：
 *   · **只有白名单内的组合才压缩**，未列入的一律各占其格 —— 这样新增标点永不产生意外行为。
 *   · 开符号 + 闭符号（如 `“”` `（）`）**绝不压缩**：压成镜像图样无法辨读（GB §5.1.3 明文各占一字）。
 *   · 闭符号 + 闭符号、点号 + 点号**不压缩**（嵌套书名号、非法输入）。
 *   · 涉及占 2 格符号的宽松变体（`……”` `——”`）默认**关闭**，见 buildWideSqueezeRules()。
 */
export function buildCompoundRules(): Record<string, CompoundRule> {
  if (cachedCompoundRules) return cachedCompoundRules
  const rules: Record<string, CompoundRule> = {}
  const add = (rule: CompoundRule) => {
    rules[rule.key] = labelGlyphs(rule)
  }

  // P1 点号 / 闭符号 + 开符号：  ：“   ，“   ”（
  for (const [lead, lpos] of Object.entries({ ...LEAD_DOTS, ...LEAD_CLOSERS })) {
    for (const [tail, tpos] of Object.entries(TAIL_OPENERS)) {
      add({
        key: lead + tail,
        cellCount: 1,
        note: '申论方格纸约定：点号/闭符号 + 开符号共占一格',
        glyphs: [glyph(0, 1, 0, lpos), glyph(1, 2, 0, tpos)],
      })
    }
  }

  // P2/P3 点号 + 闭符号：  。”   ！”   ，”   ；）
  for (const [lead, lpos] of Object.entries(LEAD_DOTS)) {
    for (const [tail, tpos] of Object.entries(TAIL_CLOSERS)) {
      add({
        key: lead + tail,
        cellCount: 1,
        note: '申论方格纸约定：点号 + 闭符号共占一格',
        glyphs: [glyph(0, 1, 0, lpos), glyph(1, 2, 0, tpos)],
      })
    }
  }

  // P4 闭符号 + 点号：  ”。   ”，   》、
  for (const [lead, lpos] of Object.entries(LEAD_CLOSERS)) {
    for (const [tail, tpos] of Object.entries(TAIL_DOTS)) {
      add({
        key: lead + tail,
        cellCount: 1,
        note: '申论方格纸约定：闭符号 + 点号共占一格（点号后到，移到右下）',
        glyphs: [glyph(0, 1, 0, lpos), glyph(1, 2, 0, tpos)],
      })
    }
  }

  // P5 问号 / 叹号叠用 —— GB/T 15834-2011 §5.1.2：两个叠用占 1 格
  for (const key of ['？？', '！！', '？！', '！？']) {
    add({
      key,
      cellCount: 1,
      note: 'GB/T 15834-2011 §5.1.2：两个点号叠用占一个字位置',
      glyphs: [glyph(0, 1, 0, { x: 0.25, y: 0.5 }, 0.92), glyph(1, 2, 0, { x: 0.73, y: 0.5 }, 0.92)],
    })
  }

  // P6 三个叠用 —— GB/T 15834-2011 §5.1.2：占 2 格（明文，禁止外推为 1.5 格）
  for (const key of ['？？？', '！！！']) {
    add({
      key,
      cellCount: 2,
      note: 'GB/T 15834-2011 §5.1.2：三个点号叠用占两个字位置',
      glyphs: [
        glyph(0, 1, 0, { x: 0.25, y: 0.5 }, 0.9),
        glyph(1, 2, 0, { x: 0.75, y: 0.5 }, 0.9),
        glyph(2, 3, 1, { x: 0.33, y: 0.5 }, 0.9),
      ],
    })
  }

  // P7 叠用点号 + 闭标号： ？！”   ！！”   ？？） —— 一格三个字形
  // 真实作答里「他喊道：真的吗？！”」这种连写很常见，行末挤占时就是「正文 + 三个标点」。
  // 渲染层专门为这一格做了布局（见 components/cellGlyphs.ts 的行末共格布局）。
  for (const pair of ['？！', '！？', '？？', '！！']) {
    for (const [tail, tpos] of Object.entries(TAIL_CLOSERS)) {
      add({
        key: pair + tail,
        cellCount: 1,
        note: '叠用点号 + 闭标号共占一格（一格三个字形）',
        glyphs: [
          glyph(0, 1, 0, { x: 0.2, y: 0.72 }, 0.8),
          glyph(1, 2, 0, { x: 0.48, y: 0.62 }, 0.8),
          glyph(2, 3, 0, tpos, 0.76),
        ],
      })
    }
  }

  cachedCompoundRules = rules
  return rules
}

/**
 * 宽松变体（默认关闭）：省略号 / 破折号 与后随闭符号共格。
 * 开启会把 `……”` 从 3 格压成 2 格，属于培训机构的「省格」写法，不是主流。
 */
export function buildWideSqueezeRules(): Record<string, CompoundRule> {
  const rules: Record<string, CompoundRule> = {}
  for (const tail of Object.keys(TAIL_CLOSERS)) {
    rules['……' + tail] = labelGlyphs({
      key: '……' + tail,
      cellCount: 2,
      note: '宽松变体：省略号占两格，闭符号挤入第 2 格',
      glyphs: [glyph(0, 2, 0, { x: 0.5, y: 0.5 }, 1), glyph(2, 3, 1, { x: 0.78, y: 0.2 }, 0.78)],
    })
    rules['——' + tail] = labelGlyphs({
      key: '——' + tail,
      cellCount: 2,
      note: '宽松变体：破折号占两格，闭符号挤入第 2 格',
      glyphs: [glyph(0, 2, 0, { x: 0.5, y: 0.5 }, 1), glyph(2, 3, 1, { x: 0.78, y: 0.2 }, 0.78)],
    })
  }
  return rules
}

/**
 * 括号序号：（1）（一）（12）…… 整组连括号共占一格。
 *
 * GB/T 15834—2011 B.3.4：**加括号的序次语后面不用任何点号** ——
 * 括号本身就是标点，所以这一组自己就是完整的序号，后面不再跟收尾符号。
 * 标准原文示例：「科学家很重视下面几种才能：（1）想象力；（2）直觉的理解力……」
 *
 * 和其他复合标点不同，这个组合没法穷举（数字有无数种），所以用模式匹配，
 * 按 key 现算现缓存 —— 查表的地方统一走 resolveCompoundRule()。
 */
const BRACKET_MARKER_RE = /^[（(]([0-9０-９]{1,2}|[一二三四五六七八九十百千万亿零两壹贰叁肆伍陆柒捌玖拾])[）)]/

function bracketMarkerRuleFrom(key: string): CompoundRule | null {
  if (!BRACKET_MARKER_RE.test(key)) return null
  const bodyEnd = key.length - 1
  return labelGlyphs({
    key,
    cellCount: 1,
    asText: true,
    note: '括号序号：括号与序号共占一格（GB/T 15834 B.3.4 括号序次语后不加点号）',
    // glyphs 只作占位（asText 走整串渲染），保留是为了别的消费方能按字形取到子串
    glyphs: [
      glyph(0, 1, 0, { x: 0.24, y: 0.5 }, 0.8),
      glyph(1, bodyEnd, 0, { x: 0.5, y: 0.5 }, 0.92),
      glyph(bodyEnd, key.length, 0, { x: 0.76, y: 0.5 }, 0.8),
    ],
  })
}

/** 模式生成的复合标点按 key 缓存（表里查不到时用） */
const patternRuleCache = new Map<string, CompoundRule>()

/**
 * 按 key 取复合标点规则：先查静态表，查不到再试模式规则。
 *
 * 所有「按 compoundKey 反查规则」的地方都必须走这里 ——
 * 直接用 profile.compoundRules[key] 会漏掉模式生成的那批（括号序号）。
 */
export function resolveCompoundRule(
  table: Record<string, CompoundRule>,
  key: string,
): CompoundRule | undefined {
  const hit = table[key]
  if (hit) return hit
  const cached = patternRuleCache.get(key)
  if (cached) return cached
  const made = bracketMarkerRuleFrom(key)
  if (made) patternRuleCache.set(key, made)
  return made ?? undefined
}

const maxLenCache = new WeakMap<object, number>()

/** 组合表中最长 key 的长度，供 tokenizer 限定匹配窗口（结果按表缓存） */
export function compoundMaxLength(rules: Record<string, CompoundRule>): number {
  const cached = maxLenCache.get(rules)
  if (cached !== undefined) return cached
  let max = 0
  for (const k of Object.keys(rules)) if (k.length > max) max = k.length
  maxLenCache.set(rules, max)
  return max
}

/** 在 text[index] 处尝试匹配复合标点，最长匹配优先 */
export function matchCompound(text: string, index: number, profile: LayoutProfile): CompoundRule | null {
  if (!profile.compoundPunctuation) return null
  const rules = profile.compoundRules
  const maxLen = Math.min(compoundMaxLength(rules), text.length - index)
  for (let len = maxLen; len >= 2; len--) {
    const key = text.slice(index, index + len)
    const rule = rules[key]
    if (!rule) continue
    // 别把括号序号的开括号吞掉。
    // 「主要有三点：（1）加强学习」里那个 （ 属于序号，不属于前面的冒号；
    // 表里的「：（」组合一旦把它吃掉，后面的 1） 就散成两个格，序号就组不起来了。
    const at = key.search(/[（(]/)
    if (at >= 0 && BRACKET_MARKER_RE.test(text.slice(index + at, index + at + 4))) continue
    return rule
  }
  // 模式规则：括号序号
  const rest = text.slice(index, index + 4)
  const bracket = BRACKET_MARKER_RE.exec(rest)
  if (bracket) {
    const made = resolveCompoundRule(rules, bracket[0])
    if (made) return made
  }
  return null
}

/** 复合标点是否禁止出现在行首（首字符是点号或闭符号时禁止） */
export function compoundNoLineStart(rule: CompoundRule): boolean {
  const first = rule.key[0]
  return (
    PUNCT_END_CHARS.includes(first) ||
    PUNCT_INNER_CHARS.includes(first) ||
    CLOSE_PUNCT_CHARS.includes(first)
  )
}

/** 复合标点是否禁止出现在行尾（末字符是开符号时禁止） */
export function compoundNoLineEnd(rule: CompoundRule): boolean {
  const last = rule.key[rule.key.length - 1]
  return OPEN_PUNCT_CHARS.includes(last)
}

/**
 * 复合标点是否允许被挤占进前一格。
 * 开符号不能挤占（会被读成闭符号）；含开符号的复合标点若整体挤占，
 * 开符号部分会被压到右上角，仍可辨认，因此允许。
 */
export function compoundSqueezable(rule: CompoundRule): boolean {
  return compoundNoLineStart(rule)
}

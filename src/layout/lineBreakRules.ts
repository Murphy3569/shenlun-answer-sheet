/**
 * LineBreakRules —— 「放不下的时候怎么办」
 *
 * 把断行决策从主循环里抽出来，单独成层。主循环只按这些判定结果走分支，
 * 规则本身集中在这里，改规则不用碰循环。
 *
 * 优先级（不可调换）：
 *   ① 行尾禁则   开引号不能落在最后一格  → 移到下一行 / 挤占
 *   ② 行末压缩   破折号、省略号只剩 1 格 → 压进 1 格，绝不拆行
 *   ③ 行首禁则   点号、闭符号不能起行    → 挤占 → 避头下拉 → 兜底允许
 *   ④ 按配置拆分 keepNumberIntact=false 时允许在格边界拆开
 *   ⑤ 强制拆分   比一整行还宽的 Token    → 只能拆
 */

import { compoundNoLineEnd, compoundNoLineStart, resolveCompoundRule } from './punctuationRules'
import type { LayoutProfile, Token } from './types'

interface TokenLineRules {
  noLineStart: boolean
  noLineEnd: boolean
  squeezable: boolean
}

export function lineRulesOf(token: Token, profile: LayoutProfile): TokenLineRules {
  if (token.type === 'COMPOUND_PUNCT' && token.compoundKey) {
    const rule = resolveCompoundRule(profile.compoundRules, token.compoundKey)
    if (rule) {
      return {
        noLineStart: compoundNoLineStart(rule),
        noLineEnd: compoundNoLineEnd(rule),
        squeezable: true,
      }
    }
  }
  const spec = profile.punctuation[token.rawText]
  if (spec && token.type !== 'NUMBER' && token.type !== 'ENGLISH') {
    return {
      noLineStart: spec.noLineStart,
      noLineEnd: spec.noLineEnd,
      squeezable: spec.squeezableAtLineEnd,
    }
  }
  return { noLineStart: false, noLineEnd: false, squeezable: false }
}

/** 该 Token 是否会正好落在本行最后一格 */
export function landsOnLastColumn(column: number, width: number, columns: number): boolean {
  return column + width === columns
}

/** ① 行尾禁则：开符号（或含开符号的复合标点）不能收尾 */
export function mustAvoidLineEnd(token: Token, rules: TokenLineRules, profile: LayoutProfile): boolean {
  return profile.preventOpeningPunctuationAtLineEnd && rules.noLineEnd && token.cellWidth === 1
}

/** ① 的例外：既不能行首也不能行尾（如 ：“），只能挤占前一格 */
export function canOnlySqueeze(rules: TokenLineRules, profile: LayoutProfile): boolean {
  return rules.noLineStart || !profile.allowOpeningPunctuationAtLineStart
}

/** ② 行末压缩：破折号 / 省略号只剩 1 格时整体压进 1 格 */
export function isCompressibleWideToken(token: Token, remaining: number, profile: LayoutProfile): boolean {
  return (
    remaining === 1 &&
    token.cellWidth === 2 &&
    (token.type === 'DASH' || token.type === 'ELLIPSIS') &&
    profile.compressWideTokenAtLineEnd
  )
}

/** ③ 行首禁则：点号 / 闭符号落在满行之后必须避让 */
export function mustAvoidLineStart(token: Token, rules: TokenLineRules, profile: LayoutProfile): boolean {
  if (!rules.noLineStart) return false
  // 允许闭符号起行时，这一条对它失效
  if (token.type === 'CLOSE_PUNCT' && !profile.preventClosingPunctuationAtLineStart) return false
  return true
}

/** ④ 配置允许拆分的 Token（keepNumberIntact / keepEnglishIntact 关掉时） */
export function canSplitFreely(token: Token, remaining: number): boolean {
  return !token.unbreakable && remaining > 0
}

/** ⑤ 比一整行还宽的 Token，不拆就没法排 */
export function isWiderThanLine(token: Token, columns: number): boolean {
  return token.cellWidth > columns
}

export type { TokenLineRules }


// ---------------------------------------------------------------------------
// 序号共格
// ---------------------------------------------------------------------------

/** 中文数词：能当序号用的那些字 */
const CN_NUMERAL_CHARS = '一二三四五六七八九十百千万亿零两壹贰叁肆伍陆柒捌玖拾'

/** 序号体后面那个「收尾符号」：1. 一. 1、 一、 1) 1） */
const LIST_MARKER_TAILS = '.．、)）'

/**
 * 这是不是序号的收尾符号。
 * 只认这五种，且必须是单独一个字符 —— `……`、`——` 这类多字符标号不参与。
 */
export function isListMarkerTail(token: Token): boolean {
  if (token.rawText.length !== 1) return false
  if (token.type !== 'PUNCT' && token.type !== 'CLOSE_PUNCT') return false
  return LIST_MARKER_TAILS.includes(token.rawText)
}

/**
 * 这是不是「序号体」。
 *
 * 只认两种情况，且都必须只占一格：
 *   · 阿拉伯数字串，占 1 格 → 1~2 位（两位数字按两两成组规则正好占一格）
 *   · 单个中文数词 → 一 / 二 / … / 十
 *
 * 限制在 1 格内是为了不改变数字本身的分组方式：
 * 「2026.」这种既不像序号、也会让 2026 被硬塞进一格，直接不认。
 */
export function isListMarkerBody(token: Token): boolean {
  if (token.type === 'NUMBER') return token.cellWidth === 1
  if (token.type === 'CHAR') return token.rawText.length === 1 && CN_NUMERAL_CHARS.includes(token.rawText)
  return false
}


/**
 * 这个 offset 是不是「句首」—— 序号不一定在第一行的开头，
 * 申论里更多时候是接着上一句写的：「……取得了明显成效。1、加强学习」。
 *
 * 判据是紧挨着它的前一个字符：句末点号 / 冒号 / 省略号之后，都算句首。
 * 故意**不**收分号和逗号：像「分别为1、2；3、4」这种并列枚举，
 * 后面那个 3 前面就是分号，但它是数据不是序号。
 */
const SENTENCE_BOUNDARY_CHARS = '。！？：…！？!?:'

export function isSentenceStart(text: string, offset: number): boolean {
  if (offset <= 0) return true
  return SENTENCE_BOUNDARY_CHARS.includes(text[offset - 1])
}

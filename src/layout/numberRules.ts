/**
 * 数字 / 英文占格规则
 *
 * 申论方格纸训练约定（**不是**国标规定）：
 *   · 连续阿拉伯数字「两个数字占一个格」
 *       2026  → [20][26]
 *       2011  → [20][11]
 *       10000 → [10][00][0]     ← 奇数长度：前面的两两成组，末尾单个独占一格
 *   · 连续英文字母同样两两成组
 *       ISO9001 → [IS][O9][00][1]
 *
 * 之所以是「前面的两两成组」，等价于：把 L 个字符尽量平均分配到 W 个格，
 * 余数优先分给靠前的格。这个分配函数对汉字（1→1）、数字、英文都成立。
 */

import type { LayoutProfile } from './types'

/** 数字串占几格 */
export function measureDigits(charCount: number, profile: LayoutProfile): number {
  if (!profile.pairArabicDigits) return charCount
  const per = Math.max(1, profile.arabicDigitsPerCell)
  return Math.ceil(charCount / per)
}

/** 英文串占几格 */
export function measureEnglish(charCount: number, profile: LayoutProfile): number {
  const per = Math.max(1, profile.englishCharsPerCell)
  return Math.ceil(charCount / per)
}

export interface Slice {
  start: number
  end: number
}

/**
 * 把长度为 charCount 的字符串切成 cellWidth 份。
 * 余数优先给靠前的格 —— 这样 5 个数字切 3 格得到 [2,2,1]，符合申论书写习惯。
 */
export function splitIntoCellSlices(charCount: number, cellWidth: number): Slice[] {
  const w = Math.max(1, cellWidth)
  if (charCount <= 0) return []

  // 字符比格还少（例如配置成「一个普通标点占两格」）：把最后一个字符重复占满剩余格，
  // 绝不留下没有内容的空格子。
  if (charCount < w) {
    const slices: Slice[] = []
    let cursor = 0
    for (let i = 0; i < w; i++) {
      if (cursor < charCount - 1) {
        slices.push({ start: cursor, end: cursor + 1 })
        cursor += 1
      } else {
        slices.push({ start: charCount - 1, end: charCount })
      }
    }
    return slices
  }

  const base = Math.floor(charCount / w)
  const rem = charCount % w
  const slices: Slice[] = []
  let cursor = 0
  for (let i = 0; i < w; i++) {
    const size = base + (i < rem ? 1 : 0)
    if (size <= 0) continue
    slices.push({ start: cursor, end: cursor + size })
    cursor += size
  }
  return slices
}

/** 数字分组的可读形式，用于测试与调试面板 */
export function groupDigits(digits: string, profile: LayoutProfile): string[] {
  const width = measureDigits(digits.length, profile)
  return splitIntoCellSlices(digits.length, width).map((s) => digits.slice(s.start, s.end))
}

// ---------------------------------------------------------------------------
// 带连接符 / 单位符号的数字串
// ---------------------------------------------------------------------------

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/**
 * 把一条数字串切成若干格。
 *
 * 比单纯的「两两分组」更聪明：
 *   · 纯数字：两位一格，奇数末位独占一格右半留空
 *       2026    → ['20','26']
 *       10000   → ['10','00','0']
 *   · 数字中间的小数点 / 日期连接号跟着数字走
 *       3.5     → ['3.','5']
 *       2026-09 → ['20','26','-0','9']
 *   · 结尾的百分号 / 摄氏度等单位符号，能塞进最后一格就塞，塞不下另起一格
 *       5%      → ['5%']
 *       50%     → ['50','%']
 *
 * 返回的数组长度即为该 Token 的占格数。
 */
export function sliceNumberToken(
  raw: string,
  digitsPerCell: number,
  trailingUnits: string,
  innerJoiners: string,
): string[] {
  const cells: string[] = []
  let current = ''

  const flush = () => {
    if (current.length > 0) cells.push(current)
    current = ''
  }

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (isAsciiDigit(ch)) {
      if (current.length >= digitsPerCell) flush()
      current += ch
      continue
    }
    if (trailingUnits.includes(ch)) {
      // 单位符号：能贴就贴，贴不下另起一格
      if (current.length > 0 && current.length < digitsPerCell) current += ch
      else {
        flush()
        current = ch
      }
      continue
    }
    if (innerJoiners.includes(ch)) {
      const nextIsDigit = i + 1 < raw.length && isAsciiDigit(raw[i + 1])
      if (nextIsDigit && current.length > 0 && current.length < digitsPerCell) {
        current += ch
      } else if (nextIsDigit) {
        flush()
        current = ch
      } else {
        // 末尾连接符：单独一格
        if (current.length > 0) flush()
        current = ch
        flush()
      }
      continue
    }
    // 其他字符（理论上不会出现在 NUMBER token 里）：另起一格
    flush()
    current = ch
    flush()
  }
  flush()
  return cells.length > 0 ? cells : [raw]
}

/** 英文分组的可读形式 */
export function groupEnglish(word: string, profile: LayoutProfile): string[] {
  const width = measureEnglish(word.length, profile)
  return splitIntoCellSlices(word.length, width).map((s) => word.slice(s.start, s.end))
}

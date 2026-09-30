/**
 * Tokenizer —— 逻辑文本 → Token 序列
 *
 * Token 是「逻辑单位」，不是「格子」。一个 Token 可能：
 *   · 占 1 格（汉字、普通标点）
 *   · 占 2 格（破折号 ——、省略号 ……）
 *   · 占 2 格但显示 2 个字符（数字 2026 → [20][26]）
 *   · 与其它字符共格（复合标点 ：“ 占 1 格）
 *
 * 匹配顺序（重要）：
 *   换行 → 空白 → 复合标点 → 数字 → 英文 → 省略号 → 破折号 → 单字符
 * 复合标点必须排在省略号/破折号之前，否则 "……”" 会被拆成两个 Token。
 */

import { measureEnglish, sliceNumberToken } from './numberRules'
import {
  classifyChar,
  isDashChar,
  isDigit,
  isSingleDashChar,
  isEllipsisChar,
  isLatin,
  isSpaceChar,
  isAstral,
  matchCompound,
  NUMBER_INNER_JOINERS,
  NUMBER_TRAILING_UNITS,
} from './punctuationRules'
import type { CharClass, LayoutProfile, Token, TokenType } from './types'

/** 归一化输入文本：统一换行、去掉零宽字符 */
export function normalizeText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      .replace(/[​-‏‪-‮﻿]/g, '')
      // 各种 Unicode 空白统一成普通空格。
      // 从网页 / PDF 复制材料时最常带进 U+00A0（不换行空格）：它看起来就是个空格、
      // 屏幕上一点异常都没有，但内置字体没有这个字形，导出 PDF 前会被判成「生僻字」，
      // 于是整篇作答退回打印版 —— 用户只会看到「导 PDF 怎么变成打印对话框了」。
      // 全角空格 U+3000 保留：字体有它，而且在方格纸上是有意义的宽度。
      // 用「替换」而不是「删除」，字符数不变，光标 offset 不会被挪动。
      .replace(/[   -   ]/g, ' ')
  )
}

interface TokenDraft {
  type: TokenType
  charClass: CharClass
  rawText: string
  sourceStart: number
  sourceEnd: number
  cellWidth: number
  unbreakable: boolean
  caretAtomic: boolean
  compoundKey?: string
  slices?: Array<{ start: number; end: number }>
}

export function tokenize(text: string, profile: LayoutProfile): Token[] {
  const tokens: Token[] = []
  const n = text.length
  let i = 0
  let id = 0

  const push = (draft: TokenDraft) => {
    tokens.push({ ...draft, id: id++ })
  }

  while (i < n) {
    const ch = text[i]

    // ---- 换行 ----
    if (ch === '\n') {
      push({
        type: 'LINE_BREAK',
        charClass: 'LINE_BREAK',
        rawText: '\n',
        sourceStart: i,
        sourceEnd: i + 1,
        cellWidth: 0,
        unbreakable: true,
        caretAtomic: false,
      })
      i += 1
      continue
    }

    // ---- 空白（一个空格一个 Token，绝不让浏览器合并） ----
    if (isSpaceChar(ch)) {
      push({
        type: 'SPACE',
        charClass: 'SPACE',
        rawText: ch,
        sourceStart: i,
        sourceEnd: i + 1,
        cellWidth: profile.spaceWidth,
        unbreakable: false,
        caretAtomic: false,
      })
      i += 1
      continue
    }

    // ---- 复合标点（最长匹配优先） ----
    const compound = matchCompound(text, i, profile)
    if (compound) {
      const len = compound.key.length
      push({
        type: 'COMPOUND_PUNCT',
        charClass: classifyChar(compound.key[0]),
        rawText: text.slice(i, i + len),
        sourceStart: i,
        sourceEnd: i + len,
        cellWidth: compound.cellCount,
        unbreakable: true,
        // 光标与删除都是**逐字符**的：先打句号再打引号，退格就先删引号、再删句号。
        // 复合标点只是「视觉上并进一格」，逻辑上仍是两个字符，删除时不该一次带走两个。
        caretAtomic: false,
        compoundKey: compound.key,
      })
      i += len
      continue
    }

    // ---- 阿拉伯数字串（含小数/日期连接符与百分号等单位符号） ----
    if (isDigit(ch)) {
      let j = i + 1
      while (j < n) {
        const c = text[j]
        if (isDigit(c)) {
          j += 1
          continue
        }
        // 数字中间的小数点 / 日期连接号：两侧都是数字才吸收
        if (NUMBER_INNER_JOINERS.includes(c) && j + 1 < n && isDigit(text[j + 1])) {
          j += 1
          continue
        }
        // 结尾的 % ‰ ° ℃ ℉：紧贴数字，整体不可分割
        if (NUMBER_TRAILING_UNITS.includes(c)) {
          j += 1
          break
        }
        break
      }
      const raw = text.slice(i, j)
      const cells = sliceNumberToken(
        raw,
        profile.pairArabicDigits ? Math.max(1, profile.arabicDigitsPerCell) : 1,
        NUMBER_TRAILING_UNITS,
        NUMBER_INNER_JOINERS,
      )
      let cursor = 0
      const slices = cells.map((c) => {
        const s = { start: cursor, end: cursor + c.length }
        cursor += c.length
        return s
      })
      push({
        type: 'NUMBER',
        charClass: 'DIGIT',
        rawText: raw,
        sourceStart: i,
        sourceEnd: j,
        cellWidth: slices.length,
        unbreakable: profile.keepNumberIntact,
        caretAtomic: false,
        slices,
      })
      i = j
      continue
    }

    // ---- 英文串（允许内部连接符 e.g. / COVID-19 / ISO9001） ----
    if (isLatin(ch)) {
      let j = i + 1
      while (j < n) {
        const c = text[j]
        if (isLatin(c) || isDigit(c)) {
          j += 1
          continue
        }
        const isConnector = c === '.' || c === '-' || c === '_' || c === '/' || c === '&' || c === "'"
        if (isConnector && j + 1 < n && (isLatin(text[j + 1]) || isDigit(text[j + 1]))) {
          j += 2
          continue
        }
        break
      }
      const raw = text.slice(i, j)
      push({
        type: 'ENGLISH',
        charClass: 'LATIN',
        rawText: raw,
        sourceStart: i,
        sourceEnd: j,
        cellWidth: measureEnglish(raw.length, profile),
        unbreakable: profile.keepEnglishIntact,
        caretAtomic: false,
      })
      i = j
      continue
    }

    // ---- 省略号 ----
    if (isEllipsisChar(ch) || ch === profile.ellipsisChar) {
      let j = i
      while (j < n && (isEllipsisChar(text[j]) || text[j] === profile.ellipsisChar)) j += 1
      let cursor = i
      // 每两个省略号字符组成一个标准省略号 Token（占 ellipsisWidth 格）
      while (j - cursor >= 2) {
        push({
          type: 'ELLIPSIS',
          charClass: 'ELLIPSIS',
          rawText: text.slice(cursor, cursor + 2),
          sourceStart: cursor,
          sourceEnd: cursor + 2,
          cellWidth: profile.ellipsisWidth,
          unbreakable: true,
          caretAtomic: true,
        })
        cursor += 2
      }
      if (j - cursor === 1) {
        push({
          type: 'ELLIPSIS',
          charClass: 'ELLIPSIS',
          rawText: text.slice(cursor, cursor + 1),
          sourceStart: cursor,
          sourceEnd: cursor + 1,
          cellWidth: 1,
          unbreakable: true,
          caretAtomic: true,
        })
        cursor += 1
      }
      i = j
      continue
    }

    // ---- 单字符破折号（U+2E3A，本身就等于一个破折号）----
    if (isSingleDashChar(ch)) {
      // 一个字符占两个格：两个格都显示这个字形（它本身就是一个跨两格的长横）
      push({
        type: 'DASH',
        charClass: 'DASH',
        rawText: ch,
        sourceStart: i,
        sourceEnd: i + 1,
        cellWidth: profile.dashWidth,
        unbreakable: true,
        caretAtomic: true,
        slices: Array.from({ length: profile.dashWidth }, () => ({ start: 0, end: 1 })),
      })
      i += 1
      continue
    }

    // ---- 破折号 ----
    if (isDashChar(ch) || ch === profile.dashChar) {
      let j = i
      // 内层循环必须和上面的判定条件一致：profile.dashChar 可能不是 DASH_CHARS 里的字符，
      // 漏掉它会让 j 停在原地、i 不推进 —— 排版引擎直接死循环，编辑区永久卡死。
      while (j < n && (isDashChar(text[j]) || text[j] === profile.dashChar)) j += 1
      let cursor = i
      while (j - cursor >= 2) {
        push({
          type: 'DASH',
          charClass: 'DASH',
          rawText: text.slice(cursor, cursor + 2),
          sourceStart: cursor,
          sourceEnd: cursor + 2,
          cellWidth: profile.dashWidth,
          unbreakable: true,
          caretAtomic: true,
        })
        cursor += 2
      }
      if (j - cursor === 1) {
        // 单个 — 是连接号，占一格
        push({
          type: 'PUNCT',
          charClass: 'PUNCT_OTHER',
          rawText: text.slice(cursor, cursor + 1),
          sourceStart: cursor,
          sourceEnd: cursor + 1,
          cellWidth: 1,
          unbreakable: true,
          caretAtomic: true,
        })
        cursor += 1
      }
      i = j
      continue
    }

    // ---- 单字符 ----
    const cp = text.codePointAt(i)!
    const size = cp > 0xffff ? 2 : 1
    const raw = text.slice(i, i + size)
    const charClass = classifyChar(raw)
    const spec = profile.punctuation[raw]

    let type: TokenType
    if (spec) {
      if (spec.charClass === 'OPEN_PUNCT') type = 'OPEN_PUNCT'
      else if (spec.charClass === 'CLOSE_PUNCT') type = 'CLOSE_PUNCT'
      else type = 'PUNCT'
    } else if (charClass === 'CJK') {
      type = 'CHAR'
    } else {
      type = 'OTHER'
    }

    // 普通中文标点的占格数由 profile.normalPunctuationWidth 控制，
    // 开闭标号各自有自己的规格（它们不是「普通标点」）。
    const width =
      type === 'PUNCT' ? profile.normalPunctuationWidth : spec ? spec.cellWidth : profile.chineseCharWidth

    push({
      type,
      charClass,
      rawText: raw,
      sourceStart: i,
      sourceEnd: i + size,
      cellWidth: width,
      unbreakable: isAstral(raw),
      caretAtomic: isAstral(raw),
    })
    i += size
  }

  return tokens
}

/** 逻辑字符数（按码点，不含换行） */
export function countLogicalChars(text: string): number {
  let count = 0
  for (const ch of text) {
    if (ch !== '\n' && ch !== '\r') count += 1
  }
  return count
}

/** Token 序列的视觉占格总数 */
export function totalCellWidth(tokens: Token[]): number {
  let sum = 0
  for (const t of tokens) {
    if (t.type === 'LINE_BREAK') continue
    sum += t.cellWidth
  }
  return sum
}

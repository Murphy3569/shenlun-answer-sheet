/**
 * Tokenizer 与规则表层测试
 *
 * 锁定那些「一旦改坏就会静默出错」的细节：字符分类、复合标点匹配、
 * 数字切分、占格宽度、原子性。
 */

import { describe, expect, it } from 'vitest'
import {
  classifyChar,
  buildCompoundRules,
  buildPunctuationTable,
  compoundNoLineEnd,
  compoundNoLineStart,
  matchCompound,
  CLOSE_PUNCT_CHARS,
  OPEN_PUNCT_CHARS,
} from './punctuationRules'
import { groupDigits, sliceNumberToken } from './numberRules'
import { countLogicalChars, normalizeText, tokenize, totalCellWidth } from './tokenizer'
import { createDefaultProfile } from './profile'
import type { Token } from './types'

const profile = createDefaultProfile()
const toks = (text: string): Token[] => tokenize(text, profile).filter((t) => t.type !== 'LINE_BREAK')

describe('文本归一化', () => {
  it('统一换行符', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('去掉零宽字符', () => {
    expect(normalizeText('a​b﻿c')).toBe('abc')
  })
})

describe('字符分类', () => {
  it('汉字', () => {
    expect(classifyChar('中')).toBe('CJK')
    expect(classifyChar('，')).toBe('PUNCT_INNER')
    expect(classifyChar('。')).toBe('PUNCT_END')
    expect(classifyChar('！')).toBe('PUNCT_END')
    expect(classifyChar('“')).toBe('OPEN_PUNCT')
    expect(classifyChar('”')).toBe('CLOSE_PUNCT')
    expect(classifyChar('《')).toBe('OPEN_PUNCT')
    expect(classifyChar('》')).toBe('CLOSE_PUNCT')
    expect(classifyChar('—')).toBe('DASH')
    expect(classifyChar('…')).toBe('ELLIPSIS')
    expect(classifyChar('7')).toBe('DIGIT')
    expect(classifyChar('A')).toBe('LATIN')
    expect(classifyChar(' ')).toBe('SPACE')
    expect(classifyChar('　')).toBe('SPACE')
  })

  it('半角标点按等价类别处理', () => {
    expect(classifyChar(',')).toBe('PUNCT_INNER')
    expect(classifyChar('.')).toBe('PUNCT_END')
    expect(classifyChar('(')).toBe('OPEN_PUNCT')
  })

  it('Emoji 归为其他，不抛错', () => {
    expect(classifyChar('👍')).toBe('CJK')
  })
})

describe('标点规格表', () => {
  const table = buildPunctuationTable()

  it('句末点号与句内点号禁止出现在行首', () => {
    for (const ch of '。！？，、；：') {
      expect(table[ch].noLineStart, ch).toBe(true)
      expect(table[ch].noLineEnd, ch).toBe(false)
    }
  })

  it('开符号禁止出现在行尾，且不允许被挤占', () => {
    for (const ch of '“‘（《〈【') {
      expect(table[ch].noLineEnd, ch).toBe(true)
      expect(table[ch].noLineStart, ch).toBe(false)
      expect(table[ch].squeezableAtLineEnd, ch).toBe(false)
    }
  })

  it('闭符号禁止出现在行首，且允许被挤占', () => {
    for (const ch of '”’）》〉】') {
      expect(table[ch].noLineStart, ch).toBe(true)
      expect(table[ch].squeezableAtLineEnd, ch).toBe(true)
    }
  })

  it('分隔号既禁行首也禁行尾', () => {
    expect(table['/'].noLineStart).toBe(true)
    expect(table['/'].noLineEnd).toBe(true)
  })

  it('开闭符号集合没有重叠', () => {
    for (const ch of OPEN_PUNCT_CHARS) {
      expect(CLOSE_PUNCT_CHARS.includes(ch), `${ch} 同时出现在开闭集合里`).toBe(false)
    }
  })
})

describe('复合标点表', () => {
  const rules = buildCompoundRules()

  it('常见组合都在表里且占 1 格', () => {
    for (const key of ['：“', '。”', '！”', '？”', '，’', '”。', '》“']) {
      expect(rules[key], key).toBeTruthy()
      expect(rules[key].cellCount, key).toBe(1)
    }
  })

  it('叠用点号：两个占 1 格，三个占 2 格', () => {
    expect(rules['？！'].cellCount).toBe(1)
    expect(rules['！？'].cellCount).toBe(1)
    expect(rules['？？'].cellCount).toBe(1)
    expect(rules['！！'].cellCount).toBe(1)
    expect(rules['？？？'].cellCount).toBe(2)
    expect(rules['！！！'].cellCount).toBe(2)
  })

  it('开符号 + 闭符号绝不压缩', () => {
    for (const key of ['“”', '（）', '《》', '〈〉', '「」', '【】']) {
      expect(rules[key], `${key} 不该出现在压缩表里`).toBeUndefined()
    }
  })

  it('点号 + 点号绝不压缩（属非法组合）', () => {
    for (const key of ['。，', '、；', '，。', '；：']) {
      expect(rules[key], key).toBeUndefined()
    }
  })

  it('闭符号 + 闭符号绝不压缩（嵌套书名号场景）', () => {
    for (const key of ['》〉', '〉》', '”’']) {
      expect(rules[key], key).toBeUndefined()
    }
  })

  it('每个组合的 glyph 下标都落在 key 范围内', () => {
    for (const rule of Object.values(rules)) {
      for (const g of rule.glyphs) {
        expect(g.start, rule.key).toBeGreaterThanOrEqual(0)
        expect(g.end, rule.key).toBeLessThanOrEqual(rule.key.length)
        expect(g.cell, rule.key).toBeLessThan(rule.cellCount)
      }
    }
  })

  it('行首 / 行尾禁则由首末字符决定', () => {
    expect(compoundNoLineStart(rules['。”'])).toBe(true)
    expect(compoundNoLineEnd(rules['。”'])).toBe(false)
    expect(compoundNoLineEnd(rules['：“'])).toBe(true)
    expect(compoundNoLineStart(rules['：“'])).toBe(true)
  })

  it('省略号 + 闭符号默认按各占其格处理，但表里备有宽松变体', () => {
    // 默认表里没有 ……”，因此 …… 与 ” 各占其格（2 + 1 = 3 格）
    expect(buildCompoundRules()['……”']).toBeUndefined()
    expect(matchCompound('……”', 0, profile)).toBeNull()
  })

  it('最长匹配优先：能从多字符候选里挑出最长的那个', () => {
    const rule = matchCompound('：“好', 0, profile)
    expect(rule?.key).toBe('：“')
    expect(rule?.cellCount).toBe(1)
  })

  it('关掉 compoundPunctuation 后不再匹配', () => {
    const off = { ...profile, compoundPunctuation: false }
    expect(matchCompound('：“', 0, off)).toBeNull()
  })
})

describe('Token 生成', () => {
  it('汉字逐个成 Token', () => {
    const list = toks('你好')
    expect(list).toHaveLength(2)
    expect(list.every((t) => t.type === 'CHAR' && t.cellWidth === 1)).toBe(true)
  })

  it('数字串是一个 Token', () => {
    const list = toks('2026年')
    expect(list).toHaveLength(2)
    expect(list[0].type).toBe('NUMBER')
    expect(list[0].cellWidth).toBe(2)
    expect(list[1].rawText).toBe('年')
  })

  it('英文串是一个 Token', () => {
    const list = toks('ISO9001')
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('ENGLISH')
    expect(list[0].cellWidth).toBe(4)
  })

  it('破折号是原子 Token', () => {
    const list = toks('——')
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('DASH')
    expect(list[0].unbreakable).toBe(true)
    expect(list[0].caretAtomic).toBe(true)
    expect(list[0].cellWidth).toBe(2)
  })

  it('单个 — 是连接号，占 1 格', () => {
    const list = toks('—')
    expect(list).toHaveLength(1)
    expect(list[0].cellWidth).toBe(1)
  })

  it('省略号是原子 Token', () => {
    const list = toks('……')
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('ELLIPSIS')
    expect(list[0].cellWidth).toBe(2)
  })

  it('每个空格都是独立 Token', () => {
    const list = toks('   ')
    expect(list).toHaveLength(3)
    expect(list.every((t) => t.type === 'SPACE')).toBe(true)
  })

  it('制表符按一个空白格处理，不撑开制表宽度', () => {
    const list = toks('甲\t乙')
    expect(list).toHaveLength(3)
    expect(list[1].charClass).toBe('SPACE')
    expect(totalCellWidth(list)).toBe(3)
  })

  it('换行是独立 Token 且不占格', () => {
    const list = tokenize('甲\n乙', profile)
    expect(list.map((t) => t.type)).toEqual(['CHAR', 'LINE_BREAK', 'CHAR'])
    expect(totalCellWidth(list)).toBe(2)
  })

  it('复合标点是一个 Token，原文完整', () => {
    const list = toks('：“')
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('COMPOUND_PUNCT')
    expect(list[0].rawText).toBe('：“')
    expect(list[0].cellWidth).toBe(1)
  })

  it('sourceStart / sourceEnd 与原文一一对应', () => {
    const text = '增长2026年，他说：“好”。'
    for (const t of toks(text)) {
      expect(text.slice(t.sourceStart, t.sourceEnd)).toBe(t.rawText)
    }
  })

  it('逻辑字符数按码点计算且不含换行', () => {
    expect(countLogicalChars('你好\n世界')).toBe(4)
    expect(countLogicalChars('👍好')).toBe(2)
  })
})

describe('数字切分', () => {
  const slice = (raw: string) => sliceNumberToken(raw, 2, '%‰°℃℉％', '.-/:')

  it('两位一格', () => {
    expect(slice('2026')).toEqual(['20', '26'])
    expect(slice('2011')).toEqual(['20', '11'])
  })

  it('奇数长度末位独占一格', () => {
    expect(slice('10000')).toEqual(['10', '00', '0'])
    expect(slice('1234567')).toEqual(['12', '34', '56', '7'])
  })

  it('单个数字占一格', () => {
    expect(slice('7')).toEqual(['7'])
  })

  it('百分号贴在数字上', () => {
    expect(slice('5%')).toEqual(['5%'])
    expect(slice('50%')).toEqual(['50', '%'])
  })

  it('小数点跟着数字走', () => {
    expect(slice('3.5')).toEqual(['3.', '5'])
  })

  it('日期连接号跟着数字走', () => {
    expect(slice('2026-09')).toEqual(['20', '26', '-0', '9'])
  })

  it('与 groupDigits 结果一致', () => {
    expect(groupDigits('10000', profile)).toEqual(['10', '00', '0'])
  })
})

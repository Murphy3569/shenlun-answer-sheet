/**
 * 排版配置（LayoutProfile）
 *
 * 所有会影响排版的规则都在这里，引擎本身不含任何写死的规则数值。
 * 换省份 / 换年份 / 换答题卡，只改 profile。
 */

import { buildCompoundRules, buildPunctuationTable } from './punctuationRules'
import type { LayoutProfile } from './types'

/** 申论标准答题卡（默认）—— 国标基础层 + 申论方格纸适配层 */
export function createDefaultProfile(): LayoutProfile {
  return {
    // 网格
    columns: 20,
    rowsPerPanel: 24,
    milestoneStep: 100,

    // 占格宽度
    chineseCharWidth: 1,
    normalPunctuationWidth: 1,
    dashWidth: 2,
    ellipsisWidth: 2,
    arabicDigitsPerCell: 2,
    englishCharsPerCell: 2,
    spaceWidth: 1,

    // 行首 / 行尾
    endOfLinePunctuationCompression: true,
    allowOpeningPunctuationAtLineStart: true,
    preventClosingPunctuationAtLineStart: true,
    preventOpeningPunctuationAtLineEnd: true,
    lineEndStrategy: 'squeeze',
    compressWideTokenAtLineEnd: true,
    pairListMarker: true,

    // 复合标点
    compoundPunctuation: true,

    // 数字 / 英文
    pairArabicDigits: true,
    keepNumberIntact: true,
    keepEnglishIntact: true,

    // 段落
    defaultIndentCells: 2,
    autoIndentFirstLine: true,

    // 表
    punctuation: buildPunctuationTable(),
    compoundRules: buildCompoundRules(),
    dashChar: '—',
    ellipsisChar: '…',
  }
}

/** 严格国标：不做任何方格纸压缩，标点一律独立占格 */
export function createStrictGbProfile(): LayoutProfile {
  return {
    ...createDefaultProfile(),
    compoundPunctuation: false,
    endOfLinePunctuationCompression: false,
    lineEndStrategy: 'allow',
    compressWideTokenAtLineEnd: false,
    pairArabicDigits: false,
    englishCharsPerCell: 1,
    // 「不做任何方格纸压缩」——序号共格也是压缩的一种，关掉
    pairListMarker: true,
    autoIndentFirstLine: true,
  }
}

/** 不缩进、不配对数字的「原样」配置，便于对比测试 */
export function createPlainProfile(): LayoutProfile {
  return {
    ...createDefaultProfile(),
    compoundPunctuation: false,
    endOfLinePunctuationCompression: false,
    lineEndStrategy: 'allow',
    pairArabicDigits: false,
    // 「原样排布」就该一个字符一格。漏了这句会让同一套预设里
    // 数字 1 字 1 格、字母却 2 字 1 格，也和预设说明自相矛盾。
    englishCharsPerCell: 1,
    pairListMarker: true,
    autoIndentFirstLine: false,
  }
}

export const LAYOUT_PRESETS: Record<string, { label: string; description: string; build: () => LayoutProfile }> = {
  shenlun: {
    label: '申论标准答题卡',
    description: '国标标点规则 + 申论方格纸书写约定（数字两两成组、连续标点同格、行末标点挤占）',
    build: createDefaultProfile,
  },
  strictGb: {
    label: '严格国标横排',
    description: '只遵循 GB/T 15834-2011，不做任何方格纸压缩，标点一律独立占格',
    build: createStrictGbProfile,
  },
  plain: {
    label: '原样排布',
    description: '一个字符一个格，不缩进、不配对数字、不压缩标点',
    build: createPlainProfile,
  },
}

/** 合并覆盖项，返回新 profile（不可变更新） */
export function withProfile(base: LayoutProfile, overrides: Partial<LayoutProfile>): LayoutProfile {
  return { ...base, ...overrides }
}

/** profile 合法性校验，返回问题列表（空数组 = 合法） */
export function validateProfile(profile: LayoutProfile): string[] {
  const problems: string[] = []
  if (!Number.isInteger(profile.columns) || profile.columns < 1) problems.push('columns 必须是 >= 1 的整数')
  if (!Number.isInteger(profile.rowsPerPanel) || profile.rowsPerPanel < 1) problems.push('rowsPerPanel 必须是 >= 1 的整数')
  if (profile.arabicDigitsPerCell < 1) problems.push('arabicDigitsPerCell 必须 >= 1')
  if (profile.englishCharsPerCell < 1) problems.push('englishCharsPerCell 必须 >= 1')
  if (profile.dashWidth < 1) problems.push('dashWidth 必须 >= 1')
  if (profile.ellipsisWidth < 1) problems.push('ellipsisWidth 必须 >= 1')
  if (profile.defaultIndentCells < 0) problems.push('defaultIndentCells 必须 >= 0')
  if (profile.defaultIndentCells >= profile.columns) problems.push('defaultIndentCells 必须小于 columns')
  return problems
}

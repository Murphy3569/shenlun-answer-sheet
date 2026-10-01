/**
 * ShenLunLayoutRuleEngine —— 申论方格答题卡排版规则引擎
 *
 * 纯 TypeScript，零依赖，零 DOM。可独立于 UI 测试与替换。
 *
 *   tokenize(text)          → Token[]
 *   layoutBlock(input)      → 行 / 格 / Token 映射
 *   paginateBlocks(blocks)  → 面板 / 页面
 *   layoutDocument(inputs)  → 整卷排版
 */

export * from './types'
export {
  tokenize,
  normalizeText,
  countLogicalChars,
  totalCellWidth,
} from './tokenizer'
export {
  buildPunctuationTable,
  buildCompoundRules,
  buildWideSqueezeRules,
  matchCompound,
  classifyChar,
  isWideChar,
  isAstral,
  isDigit,
  isLatin,
  isSpaceChar,
  isDashChar,
  isEllipsisChar,
  getPunctSpec,
  compoundMaxLength,
  compoundNoLineStart,
  compoundNoLineEnd,
  compoundSqueezable,
  PUNCT_END_CHARS,
  PUNCT_INNER_CHARS,
  OPEN_PUNCT_CHARS,
  CLOSE_PUNCT_CHARS,
  SEPARATOR_CHARS,
  NUMBER_TRAILING_UNITS,
  NUMBER_INNER_JOINERS,
  resolveCompoundRule,
} from './punctuationRules'
export {
  measureDigits,
  measureEnglish,
  splitIntoCellSlices,
  sliceNumberToken,
  groupDigits,
  groupEnglish,
} from './numberRules'
export type { Slice } from './numberRules'
export {
  lineRulesOf,
  landsOnLastColumn,
  mustAvoidLineEnd,
  mustAvoidLineStart,
  canOnlySqueeze,
  isCompressibleWideToken,
  canSplitFreely,
  isWiderThanLine,
  isSentenceStart,
  isListMarkerBody,
  isListMarkerTail,
} from './lineBreakRules'
export type { TokenLineRules } from './lineBreakRules'
export {
  emptyCell,
  fillCells,
  flushRow,
  startRow,
  pushEvent,
  placeToken,
  placeCompressed,
  squeezeInto,
  pullDown,
  splitTokenAt,
} from './cellAllocator'
export type { BuilderState } from './cellAllocator'
export {
  createDefaultProfile,
  createStrictGbProfile,
  createPlainProfile,
  withProfile,
  validateProfile,
  LAYOUT_PRESETS,
} from './profile'
export {
  layoutBlock,
  layoutDocument,
  paginateBlocks,
  resolveParagraphMeta,
} from './layoutEngine'
export type { BlockLayoutResult, PaginationOptions } from './layoutEngine'
export {
  caretPositionFor,
  offsetForCellPoint,
  prevStop,
  nextStop,
  snapOffset,
  backspaceRange,
  deleteRange,
} from './caret'
export type { CaretPosition } from './caret'

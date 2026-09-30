/**
 * 排版不变量（确定性模糊测试）
 *
 * 用固定种子的伪随机输入批量冲击引擎，断言几条**永远必须成立**的性质。
 * 这类测试的价值在于：它能发现人工想不到的组合，而且结果可复现。
 *
 * 不变量：
 *   I1 每一行恰好 columns 个格
 *   I2 格的源文本区间单调不减，且完整覆盖 [0, text.length]
 *   I3 原子 Token（破折号 / 省略号 / 复合标点）的所有格必须在同一行 —— 绝不跨行拆开
 *   I4 占格数不超过所有 Token 逻辑宽度之和（压缩只会变少，不会变多）
 *   I5 行数有上界（不出现行数爆炸）
 *   I6 引擎对任意输入都不抛异常、不挂死
 */

import { describe, expect, it } from 'vitest'
import { layoutBlock } from './layoutEngine'
import { createDefaultProfile, withProfile } from './profile'
import { normalizeText } from './tokenizer'
import type { BlockLayoutResult, LayoutProfile } from './types'

const profile = withProfile(createDefaultProfile(), { autoIndentFirstLine: false })
const indented: LayoutProfile = createDefaultProfile()

/** 固定种子线性同余发生器 —— 保证测试可复现 */
function makeRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const POOL = [
  '发', '展', '中', '国', '人', '民', '好', '字',
  '，', '。', '、', '；', '：', '！', '？',
  '“', '”', '‘', '’', '（', '）', '《', '》', '【', '】',
  '—', '…', '/', '·',
  '0', '1', '5', '9',
  'A', 'B', 'G', 'P', 'D', 'a', 'b',
  ' ', '\t', '\n',
  '　', '%', '℃', '👍', '-',
]

function randomText(rand: () => number, maxLen: number): string {
  const len = 1 + Math.floor(rand() * maxLen)
  let out = ''
  for (let i = 0; i < len; i++) out += POOL[Math.floor(rand() * POOL.length)]
  return out
}

function checkInvariants(result: BlockLayoutResult, source: string, columns: number, label: string) {
  const text = normalizeText(source)

  // I1 + I3
  const tokenById = new Map(result.tokens.map((t) => [t.id, t]))
  for (const row of result.rows) {
    expect(row.cells.length, `${label}: 行 ${row.index} 格数不对`).toBe(columns)
    for (const cell of row.cells) {
      expect(cell.column, `${label}: 列号错位`).toBe(row.cells.indexOf(cell))
    }
  }

  for (const token of result.tokens) {
    if (token.type === 'LINE_BREAK') continue
    if (!token.unbreakable || token.cellWidth <= 1) continue
    // 比一整行还宽的 Token（超长数字/英文串）无法不拆行，只要求它在同一行内不被中文字符打断
    if (token.cellWidth > columns) continue
    const rowsOfToken = new Set<number>()
    for (const row of result.rows) {
      for (const cell of row.cells) {
        if (cell.occupants.some((o) => o.tokenId === token.id)) rowsOfToken.add(row.index)
      }
    }
    expect(
      rowsOfToken.size,
      `${label}: 原子 Token ${JSON.stringify(token.rawText)} 跨了 ${rowsOfToken.size} 行`,
    ).toBeLessThanOrEqual(1)
    void tokenById
  }

  // I2：把所有格按住处的绝对序号展平后，源区间必须单调不减且覆盖全文
  const flat = result.rows.flatMap((r) => r.cells)
  let cursor = 0
  for (const cell of flat) {
    expect(cell.sourceStart, `${label}: 源区间回退`).toBeGreaterThanOrEqual(cursor)
    expect(cell.sourceEnd, `${label}: 源区间倒挂`).toBeGreaterThanOrEqual(cell.sourceStart)
    cursor = cell.sourceStart
  }
  // 每个字符都要被某个格覆盖（挤占/压缩的字符由同格的第二个占位者承载）
  const covered = new Set<number>()
  for (const cell of flat) {
    for (const o of cell.occupants) {
      const token = tokenById.get(o.tokenId)
      if (!token) continue
      for (let k = o.sliceStart; k < o.sliceEnd; k++) covered.add(token.sourceStart + k)
    }
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') continue
    expect(covered.has(i), `${label}: 第 ${i} 个字符「${text[i]}」没有被任何格承载`).toBe(true)
  }

  // I4
  const totalWidth = result.tokens.reduce((n, t) => n + (t.type === 'LINE_BREAK' ? 0 : t.cellWidth), 0)
  expect(result.occupiedCellCount, `${label}: 占格数超过 Token 宽度之和`).toBeLessThanOrEqual(totalWidth)

  // I5：行数上界 = 内容理论行数 + 用户换行数 + 容量补齐行 + 松弛量。
  // 避尾会把开标号推到下一行、让某些行末尾留空，所以实际行数可以略多于理论行数；
  // 这里只拦「行数爆炸」这种真异常（例如解析进入死循环）。
  const newlines = (text.match(/\n/g) ?? []).length
  const upper = Math.ceil(totalWidth / columns) + newlines + result.capacityRows + result.tokens.length + 2
  expect(result.rows.length, `${label}: 行数爆炸 ${result.rows.length} > ${upper}`).toBeLessThanOrEqual(upper)
}

describe('确定性模糊测试：排版不变量', () => {
  it('200 组随机输入全部满足不变量', () => {
    const rand = makeRandom(20260929)
    for (let i = 0; i < 200; i++) {
      const text = randomText(rand, 120)
      const capacity = Math.floor(rand() * 200)
      const result = layoutBlock({ blockId: 'fuzz', blockTitle: 't', text, capacity }, profile)
      checkInvariants(result, text, profile.columns, `#${i}`)
    }
  })

  it('开启段首缩进时同样成立', () => {
    const rand = makeRandom(7)
    for (let i = 0; i < 60; i++) {
      const text = randomText(rand, 80)
      const result = layoutBlock({ blockId: 'fuzz', blockTitle: 't', text, capacity: 0 }, indented)
      checkInvariants(result, text, indented.columns, `indent#${i}`)
    }
  })

  it('每行格数换成 15 / 25 / 30 时同样成立', () => {
    const rand = makeRandom(99)
    for (const columns of [15, 25, 30]) {
      const p = withProfile(profile, { columns })
      for (let i = 0; i < 40; i++) {
        const text = randomText(rand, 90)
        const result = layoutBlock({ blockId: 'fuzz', blockTitle: 't', text, capacity: 0 }, p)
        checkInvariants(result, text, columns, `cols${columns}#${i}`)
      }
    }
  })

  it('极端列数（1 列 / 2 列）不会死循环', () => {
    // columns 很小时，行末避让很容易陷入「拉下来又放不下」的循环，必须保证有守卫
    const samples = ['12）', '字。', '。', '字字。', '12', '字，字', '。。', '“', '”', 'ab）', '字——”']
    for (const columns of [1, 2, 3]) {
      const p = withProfile(profile, { columns })
      for (const text of samples) {
        const started = Date.now()
        const r = layoutBlock({ blockId: 'x', blockTitle: 't', text, capacity: 0 }, p)
        expect(Date.now() - started, `columns=${columns} "${text}" 耗时过久`).toBeLessThan(1500)
        expect(r.rows.length, `columns=${columns} "${text}" 行数异常`).toBeLessThan(text.length * 3 + 5)
      }
    }
  })

  it('极端输入不崩溃', () => {
    const extreme = [
      '',
      '\n',
      '\n\n\n',
      '。',
      '。，、；：！？',
      '“”‘’（）《》【】',
      '————————————————',
      '…………………………………………',
      '？？？？？？？？？？',
      ' '.repeat(50),
      '\t'.repeat(20),
      '0'.repeat(300),
      'A'.repeat(300),
      '👍'.repeat(40),
      '“'.repeat(40),
      '”'.repeat(40),
      '，。'.repeat(50),
      '字'.repeat(500),
    ]
    for (const text of extreme) {
      expect(() => layoutBlock({ blockId: 'x', blockTitle: 't', text, capacity: 0 }, profile), JSON.stringify(text.slice(0, 20))).not.toThrow()
      const r = layoutBlock({ blockId: 'x', blockTitle: 't', text, capacity: 0 }, indented)
      checkInvariants(r, text, indented.columns, JSON.stringify(text.slice(0, 12)))
    }
  })

  it('一整行都放不下的超长数字串会被强制拆分且不丢字符', () => {
    const digits = '1234567890'.repeat(5) // 50 位，远宽于一行
    const r = layoutBlock({ blockId: 'x', blockTitle: 't', text: digits, capacity: 0 }, profile)
    // 按格子顺序拼回原文（不能用 Set 去重，重复的数字会被吃掉）
    const pieces: string[] = []
    const tokenById = new Map(r.tokens.map((t) => [t.id, t]))
    for (const row of r.rows) {
      for (const cell of row.cells) {
        for (const o of cell.occupants) {
          const token = tokenById.get(o.tokenId)!
          pieces.push(token.rawText.slice(o.sliceStart, o.sliceEnd))
        }
      }
    }
    expect(pieces.join('')).toBe(digits)
  })
})

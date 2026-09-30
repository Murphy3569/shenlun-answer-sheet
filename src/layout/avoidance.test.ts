/**
 * 避让链 / 容量口径 / 配置健壮性
 *
 * 这里的每一项都对应一个**真实发生过的缺陷**，全部来自对抗式验证工作流：
 *   B1 容量口径与溢出判定口径打架（写满目标字数却被判超容量）
 *   B2 容量不是每行整数倍时，空白补齐格被误标成溢出
 *   B3 行末被「两位数字切片」或「压缩标号」占满时，句末点号被甩到下一行行首
 *   B4 避头下拉只会搬「单格 Token」，遇到多格 Token 直接放弃，救济链断了一环
 *   死循环  自定义 dashChar 不在 DASH_CHARS 里时，tokenizer 原地打转
 */

import { describe, expect, it } from 'vitest'
import { cellText, firstUsedColumn, rowCount, usedColumns, run } from './testUtils'
import { createDefaultProfile, withProfile } from './profile'
import { tokenize } from './tokenizer'
import { layoutBlock } from './layoutEngine'
import type { LayoutProfile } from './types'

const indented = createDefaultProfile()
const plain: LayoutProfile = withProfile(indented, { autoIndentFirstLine: false })

// ---------------------------------------------------------------------------
// B1 / B2：容量口径
// ---------------------------------------------------------------------------

describe('容量口径：算「内容格」，不算缩进占位格与空白补齐格', () => {
  it('开着段首缩进写满目标字数，不报超容量', () => {
    const exactly = run('字'.repeat(300), { indent: true, capacity: 300 })
    expect(exactly.occupiedCellCount).toBe(300)
    expect(exactly.overflow).toBe(false)
    expect(exactly.overflowCells).toBe(0)

    const under = run('字'.repeat(299), { indent: true, capacity: 300 })
    expect(under.overflow).toBe(false)
  })

  it('真的写超了才报，且溢出格数准确', () => {
    const over = run('字'.repeat(305), { indent: true, capacity: 300 })
    expect(over.overflow).toBe(true)
    expect(over.overflowCells).toBe(5)
  })

  it('容量不是每行格数整数倍时，多出来的空白补齐格不算溢出', () => {
    const empty = run('', { indent: true, capacity: 150 }) // 8 行 = 160 格
    expect(empty.rows.flatMap((r) => r.cells).filter((c) => c.overflow)).toHaveLength(0)
    expect(empty.overflow).toBe(false)
  })

  it('溢出标记只落在有内容的格上', () => {
    const r = run('字'.repeat(45), { indent: true, capacity: 40 })
    const marked = r.rows.flatMap((row) => row.cells).filter((c) => c.overflow)
    expect(marked.every((c) => !c.empty)).toBe(true)
    expect(marked).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// B3 / B4：行末避让链
// ---------------------------------------------------------------------------

describe('行末避让链：挤占 → 避头下拉 → 兜底', () => {
  const cases: Array<[string, string]> = [
    ['四位数字之后', '字'.repeat(18) + '2026' + '。'],
    ['数字 + 逗号', '字'.repeat(18) + '2026' + '，'],
    ['英文串之后', '字'.repeat(17) + 'GDPXYZ' + '”'],
    ['压缩破折号之后', '字'.repeat(19) + '——' + '。'],
    ['压缩省略号之后', '字'.repeat(19) + '……' + '。'],
    ['五位数字未满一行时', '字'.repeat(18) + '10000' + '。'],
  ]

  it.each(cases)('%s：句末标点不落到下一行行首', (_label, text) => {
    const r = layoutBlock({ blockId: 'b', blockTitle: 't', text, capacity: 0 }, plain)
    const secondRowStart = r.rows[1] ? firstUsedColumn(r, 1) : -1
    expect(secondRowStart === 0 ? cellText(r, 1, 0) : '').not.toMatch(/^[。，、；：！？”’）》]/)
  })

  it('标点确实被挤进了前面那一格（而不是整行下移）', () => {
    const r = layoutBlock({ blockId: 'b', blockTitle: 't', text: '字'.repeat(18) + '2026' + '。', capacity: 0 }, plain)
    expect(rowCount(r)).toBe(1)
    expect(usedColumns(r, 0)).toBe(20)
    const lastCell = r.rows[0].cells[19]
    expect(lastCell.occupants.map((o) => o.render)).toEqual(['normal', 'squeezed'])
    expect(lastCell.display).toBe('26。')
  })

  it('挤进「压缩破折号」那一格时同样成立', () => {
    const r = layoutBlock({ blockId: 'b', blockTitle: 't', text: '字'.repeat(19) + '——' + '。', capacity: 0 }, plain)
    const lastCell = r.rows[0].cells[19]
    expect(lastCell.occupants.map((o) => o.render)).toEqual(['compressed', 'squeezed'])
    expect(lastCell.display).toBe('——。')
  })

  it('复合标点占的格不会再被塞第三个字形', () => {
    const r = layoutBlock({ blockId: 'b', blockTitle: 't', text: '字'.repeat(18) + '，”' + '。”', capacity: 0 }, plain)
    const cell = r.rows[0].cells[19]
    expect(cell.occupants).toHaveLength(1)
    expect(cell.occupants[0].sliceEnd - cell.occupants[0].sliceStart).toBe(2)
  })

  it('真实申论标点密度下，行首禁则 0 违规（8000+ 行）', () => {
    let seed = 20260929
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const WORDS = ['发展', '改革', '建设', '社会', '治理', '推进', '加强', '提高', '保障', '民生', '经济', '文化', '生态', '创新', '协调', '共享', '现代化', '高质量']
    const PUNCT = ['。', '，', '、', '；', '：', '“', '”']
    let lines = 0
    let violations = 0
    for (let round = 0; round < 200; round++) {
      let text = ''
      while (text.length < 400) {
        text += WORDS[Math.floor(rand() * WORDS.length)]
        if (rand() < 0.08) text += PUNCT[Math.floor(rand() * PUNCT.length)]
        if (rand() < 0.02) text += '2026'
        if (rand() < 0.01) text += '\n'
      }
      const r = layoutBlock({ blockId: 'b', blockTitle: 't', text, capacity: 0 }, plain)
      lines += r.rows.length
      for (const e of r.rules) {
        if (e.type !== 'line-start-punct-allowed') continue
        // 段落开头的标点属于脏输入，没有别的排法，不算违规
        if (e.offset !== 0 && text[e.offset - 1] !== '\n') violations += 1
      }
    }
    expect(lines).toBeGreaterThan(3000)
    expect(violations, `共 ${lines} 行出现 ${violations} 次避让失败`).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 配置健壮性：任何配置都不能让引擎卡死
// ---------------------------------------------------------------------------

describe('自定义破折号 / 省略号字符不能卡死引擎', () => {
  it('dashChar 设成不在默认字符集里的字符时，分词正常返回', () => {
    const p = withProfile(indented, { dashChar: '～' })
    const started = Date.now()
    const tokens = tokenize('甲～～乙', p)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(tokens.map((t) => t.rawText).join('')).toBe('甲～～乙')
    expect(tokens.find((t) => t.type === 'DASH')?.cellWidth).toBe(2)
  })

  it('dashChar 设成普通字母也不会死循环', () => {
    const p = withProfile(indented, { dashChar: 'x' })
    const started = Date.now()
    const r = layoutBlock({ blockId: 'b', blockTitle: 't', text: 'axxb', capacity: 0 }, p)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.text).toBe('axxb')
  })

  it('ellipsisChar 自定义同样安全', () => {
    const p = withProfile(indented, { ellipsisChar: '。' })
    const started = Date.now()
    const tokens = tokenize('甲。。乙', p)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(tokens.map((t) => t.rawText).join('')).toBe('甲。。乙')
  })
})

// ---------------------------------------------------------------------------
// 性能
// ---------------------------------------------------------------------------

describe('性能', () => {
  const sample = '当前，我国经济社会发展进入新阶段，必须完整、准确、全面贯彻新发展理念，加快构建新发展格局，着力推动高质量发展。'

  function timeFor(text: string, rounds = 30): number {
    const input = { blockId: 'b', blockTitle: 't', text, capacity: text.length }
    layoutBlock(input, indented)
    const t0 = performance.now()
    for (let i = 0; i < rounds; i++) layoutBlock(input, indented)
    return (performance.now() - t0) / rounds
  }

  it('1500 字排版在 50ms 以内（实测约 1ms）', () => {
    const ms = timeFor(sample.repeat(30).slice(0, 1500))
    expect(ms, `1500 字排版耗时 ${ms.toFixed(2)}ms`).toBeLessThan(50)
  })

  it('排版耗时随字数近似线性，没有爆炸', () => {
    const small = timeFor(sample.repeat(6).slice(0, 300))
    const large = timeFor(sample.repeat(30).slice(0, 1500))
    // 5 倍文本量，耗时不应超过 20 倍
    expect(large).toBeLessThan(Math.max(small * 20, 20))
  })
})

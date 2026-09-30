/**
 * 规则引擎验收测试
 *
 * 对应需求文档「四十四、必须写自动化测试」的 TEST 1 ~ TEST 19，
 * 以及规则规格书的边界情况清单。
 */

import { describe, expect, it } from 'vitest'
import {
  cellText,
  firstUsedColumn,
  rowContent,
  rowCount,
  rowText,
  rowTokens,
  run,
  tokenTexts,
  usedColumns,
} from './testUtils'
import { createDefaultProfile, withProfile } from './profile'
import { buildWideSqueezeRules } from './punctuationRules'

const FILLER = '字'.repeat(19)
const FULL = '字'.repeat(20)

// ---------------------------------------------------------------------------
// TEST 1 ~ TEST 5：基础占格
// ---------------------------------------------------------------------------

describe('TEST 1 汉字：一个汉字一格', () => {
  it('“你好” 占 2 个汉字格', () => {
    const r = run('你好')
    expect(rowContent(r, 0)).toEqual(['你', '好'])
    expect(usedColumns(r, 0)).toBe(2)
    expect(r.occupiedCellCount).toBe(2)
    expect(r.logicalCharCount).toBe(2)
  })
})

describe('TEST 2 汉字 + 标点：正确分格', () => {
  it('“你好，世界。” 六个格，标点各占一格', () => {
    const r = run('你好，世界。')
    expect(rowContent(r, 0)).toEqual(['你', '好', '，', '世', '界', '。'])
    expect(usedColumns(r, 0)).toBe(6)
  })
})

describe('TEST 3 / 4 / 5 阿拉伯数字：两个数字一格', () => {
  it('2026 → [20][26]', () => {
    const r = run('2026')
    expect(rowContent(r, 0)).toEqual(['20', '26'])
    expect(usedColumns(r, 0)).toBe(2)
  })

  it('2011 → [20][11]', () => {
    expect(rowContent(run('2011'), 0)).toEqual(['20', '11'])
  })

  it('10000 → [10][00][0]（奇数长度末位独占一格）', () => {
    const r = run('10000')
    expect(rowContent(r, 0)).toEqual(['10', '00', '0'])
    expect(usedColumns(r, 0)).toBe(3)
  })

  it('数字与汉字相邻不改变配对：2026年 → [20][26][年]', () => {
    expect(rowContent(run('2026年'), 0)).toEqual(['20', '26', '年'])
  })

  it('数字是原子 Token：断行时不被中文字符打断', () => {
    // 19 个汉字 + 4 位数字 = 19 + 2 = 21 格，数字整体落到下一行
    const r = run(FILLER + '2026')
    expect(usedColumns(r, 0)).toBe(19)
    expect(rowContent(r, 1)).toEqual(['20', '26'])
    expect(r.tokens.find((t) => t.type === 'NUMBER')!.unbreakable).toBe(true)
  })

  it('百分号跟随数字：5% 占 1 格，50% 占 2 格', () => {
    expect(rowContent(run('增长5%'), 0)).toEqual(['增', '长', '5%'])
    expect(rowContent(run('增长50%'), 0)).toEqual(['增', '长', '50', '%'])
  })
})

// ---------------------------------------------------------------------------
// TEST 6 ~ TEST 8：原子 Token 与复合标点
// ---------------------------------------------------------------------------

describe('TEST 6 破折号 —— 占 2 格且不可拆行', () => {
  it('正常位置占 2 格', () => {
    const r = run('发展——进步')
    // 破折号横跨两个格，每格显示一半
    expect(rowContent(r, 0)).toEqual(['发', '展', '—', '—', '进', '步'])
    expect(usedColumns(r, 0)).toBe(6)
    expect(rowTokens(r, 0)).toContain('——')
  })

  it('行末只剩 1 格时压进 1 格，不拆行', () => {
    const r = run(FILLER + '——')
    // 第 20 格显示被压缩的破折号
    expect(rowText(r, 0).endsWith('——#')).toBe(true)
    expect(usedColumns(r, 0)).toBe(20)
    // 破折号没有跑到第二行
    expect(rowContent(r, 1)).toEqual([])
  })

  it('逻辑文本里破折号仍然是两个字符', () => {
    const r = run(FILLER + '——')
    const dash = r.tokens.find((t) => t.type === 'DASH')!
    expect(dash.rawText).toBe('——')
    expect(dash.cellWidth).toBe(2)
    expect(dash.unbreakable).toBe(true)
  })
})

describe('TEST 7 省略号 …… 占 2 格且不可拆行', () => {
  it('正常位置占 2 格', () => {
    const r = run('等等……')
    expect(rowContent(r, 0)).toEqual(['等', '等', '…', '…'])
    expect(usedColumns(r, 0)).toBe(4)
    expect(rowTokens(r, 0)).toContain('……')
  })

  it('行末只剩 1 格时压进 1 格，不拆行', () => {
    const r = run(FILLER + '……')
    expect(rowText(r, 0).endsWith('……#')).toBe(true)
    expect(rowContent(r, 1)).toEqual([])
  })

  it('单字符 … 只占 1 格', () => {
    expect(rowContent(run('嗯…'), 0)).toEqual(['嗯', '…'])
  })
})

describe('TEST 8 问号叹号叠用按 GB/T 15834-2011 处理', () => {
  it('？！ 占 1 格', () => {
    const r = run('什么？！')
    expect(rowContent(r, 0)).toEqual(['什', '么', '？！'])
    expect(usedColumns(r, 0)).toBe(3)
  })

  it('？？ 占 1 格', () => {
    expect(rowContent(run('什么？？'), 0)).toEqual(['什', '么', '？？'])
  })

  it('！！！ 占 2 格（国标明文，不外推为 1.5 格）', () => {
    const r = run('好！！！')
    expect(rowTokens(r, 0)).toEqual(['好', '！！！'])
    expect(usedColumns(r, 0)).toBe(3)
  })

  it('四个问号 = ？？？ + ？', () => {
    const r = run('什么？？？？')
    expect(rowTokens(r, 0)).toEqual(['什', '么', '？？？', '？'])
    expect(usedColumns(r, 0)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// TEST 9 ~ TEST 11：行首 / 行尾禁则
// ---------------------------------------------------------------------------

describe('TEST 9 行末恰好写满时遇到句末点号：挤占而非换行', () => {
  it('一整行 + 。 → 句号与前字共格', () => {
    const r = run(FULL + '。')
    expect(usedColumns(r, 0)).toBe(20)
    expect(rowText(r, 0).endsWith('字+。~')).toBe(true)
    // 句号没有跑到下一行行首
    expect(firstUsedColumn(r, 1)).toBe(-1)
  })

  it('挤占后逻辑文本完全不受影响', () => {
    const text = FULL + '。'
    const r = run(text)
    expect(r.text).toBe(text)
    expect(r.logicalCharCount).toBe(21)
    expect(r.occupiedCellCount).toBe(20) // 21 个字符挤进 20 个格
  })

  it('逗号、顿号、分号、冒号、问号、叹号、闭引号都适用', () => {
    for (const p of ['，', '、', '；', '：', '？', '！', '”', '）', '》']) {
      const r = run(FULL + p)
      expect(usedColumns(r, 0), `标点 ${p} 应挤占同一格`).toBe(20)
      expect(rowContent(r, 1)).toEqual([])
    }
  })

  it('记录 line-end-squeeze 规则事件', () => {
    const r = run(FULL + '。')
    expect(r.rules.some((e) => e.type === 'line-end-squeeze')).toBe(true)
  })
})

describe('TEST 10 开引号不能落在行尾', () => {
  it('第 19 字后遇到 “ → 开引号移到下一行行首', () => {
    const r = run(FILLER + '“你好”')
    expect(usedColumns(r, 0)).toBe(19)
    expect(firstUsedColumn(r, 1)).toBe(0)
    expect(cellText(r, 1, 0)).toBe('“')
  })

  it('记录 open-punct-moved-from-line-end 规则事件', () => {
    const r = run(FILLER + '“你好”')
    expect(r.rules.some((e) => e.type === 'open-punct-moved-from-line-end')).toBe(true)
  })

  it('（ 《 同样不能落在行尾', () => {
    for (const p of ['（', '《', '【']) {
      const r = run(FILLER + p + '内容')
      expect(usedColumns(r, 0), `开符号 ${p} 不应留在行尾`).toBe(19)
      expect(cellText(r, 1, 0)).toBe(p)
    }
  })
})

describe('TEST 11 闭引号不能单独出现在行首', () => {
  it('一整行后遇到 ” → 挤进最后一格', () => {
    const r = run(FULL + '”')
    expect(usedColumns(r, 0)).toBe(20)
    expect(rowText(r, 0).endsWith('字+”~')).toBe(true)
    expect(firstUsedColumn(r, 1)).toBe(-1)
  })

  it('句号 + 闭引号 作为复合标点整体挤占', () => {
    const r = run(FILLER + '。”')
    expect(usedColumns(r, 0)).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// TEST 12 ~ TEST 14：空格 / 换行 / 自动换行
// ---------------------------------------------------------------------------

describe('TEST 12 空格：一个空格一个空白格，绝不合并', () => {
  it('两个空格 = 两个空白格', () => {
    const r = run('  第一段')
    expect(usedColumns(r, 0)).toBe(5)
    const cells = r.rows[0].cells.slice(0, 5)
    expect(cells[0].empty).toBe(false)
    expect(cells[1].empty).toBe(false)
    expect(cells[0].occupants).toHaveLength(1)
    expect(cells[1].occupants).toHaveLength(1)
    expect(r.tokens.filter((t) => t.type === 'SPACE')).toHaveLength(2)
  })

  it('四个空格 = 四个空白格', () => {
    const r = run('    内容')
    expect(usedColumns(r, 0)).toBe(6)
    expect(r.tokens.filter((t) => t.type === 'SPACE')).toHaveLength(4)
  })

  it('中英文之间的空格也占格：GDP 增长', () => {
    const r = run('GDP 增长')
    // GD | P 两格 + 空格 1 格 + 增长 2 格
    expect(usedColumns(r, 0)).toBe(5)
    expect(r.tokens.filter((t) => t.type === 'SPACE')).toHaveLength(1)
  })
})

describe('TEST 13 真实 Enter 产生真实换行', () => {
  it('一段换行 → 两行', () => {
    const r = run('第一段\n第二段')
    expect(rowCount(r)).toBe(2)
    expect(rowContent(r, 0)).toEqual(['第', '一', '段'])
    expect(rowContent(r, 1)).toEqual(['第', '二', '段'])
  })

  it('连续两个 Enter 产生一整行空白答题区', () => {
    const r = run('第一段\n\n第二段')
    expect(rowCount(r)).toBe(3)
    expect(rowContent(r, 1)).toEqual([])
    expect(firstUsedColumn(r, 1)).toBe(-1)
  })

  it('行尾的 Enter 留下一行空行供光标落点', () => {
    const r = run('内容\n')
    expect(rowCount(r)).toBe(2)
    expect(rowContent(r, 1)).toEqual([])
  })

  it('换行不计入逻辑字数', () => {
    expect(run('第一段\n第二段').logicalCharCount).toBe(6)
  })
})

describe('TEST 14 自动换行不改变原始文本', () => {
  it('一长串无 Enter 的文字自动折行，文本保持原样', () => {
    const text = '字'.repeat(45)
    const r = run(text)
    expect(rowCount(r)).toBe(3)
    expect(r.text).toBe(text)
    expect(r.text.includes('\n')).toBe(false)
    expect(usedColumns(r, 2)).toBe(5)
  })

  it('自动换行与用户换行互不干扰', () => {
    const text = '字'.repeat(25) + '\n' + '字'.repeat(3)
    const r = run(text)
    expect(rowCount(r)).toBe(3)
    expect(r.text).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// 复合标点
// ---------------------------------------------------------------------------

describe('复合标点组合', () => {
  it('：“ 共占一格', () => {
    const r = run('他说：“好”')
    expect(rowTokens(r, 0)).toEqual(['他', '说', '：“', '好', '”'])
    expect(usedColumns(r, 0)).toBe(5)
  })

  it('。” 共占一格', () => {
    const r = run('好。”')
    // 好(1) + 。”(1) = 2 格；”，句号与闭引号合占一格
    expect(usedColumns(r, 0)).toBe(2)
    expect(rowTokens(r, 0)).toEqual(['好', '。”'])
  })

  it('”。 （闭符号 + 点号）共占一格', () => {
    const r = run('“好”。')
    // “(1) + 好(1) + ”。(1) = 3 格
    expect(usedColumns(r, 0)).toBe(3)
    expect(rowTokens(r, 0)).toEqual(['“', '好', '”。'])
  })

  it('开符号 + 闭符号绝不压缩：“” 占 2 格', () => {
    const r = run('“”')
    expect(usedColumns(r, 0)).toBe(2)
    expect(rowContent(r, 0)).toEqual(['“', '”'])
  })

  it('点号 + 点号 不压缩：。， 占 2 格', () => {
    const r = run('。，')
    expect(usedColumns(r, 0)).toBe(2)
  })

  it('复合标点在逻辑文本里仍是两个字符', () => {
    const r = run('他说：“好”')
    const compound = r.tokens.find((t) => t.type === 'COMPOUND_PUNCT')!
    expect(compound.rawText).toBe('：“')
    expect(compound.cellWidth).toBe(1)
  })

  it('省略号 + 闭引号默认不压缩（……” 占 3 格）', () => {
    const r = run('他说：“走吧……”')
    // 他(1) 说(1) ：”(1) 走(1) 吧(1) ……(2) ”(1) = 8 格
    expect(usedColumns(r, 0)).toBe(8)
    expect(rowTokens(r, 0)).toEqual(['他', '说', '：“', '走', '吧', '……', '”'])
  })

  it('开启宽松变体后 ……” 压成 2 格', () => {
    const base = createDefaultProfile()
    const profile = withProfile(base, {
      compoundRules: { ...base.compoundRules, ...buildWideSqueezeRules() },
    })
    const r = run('走吧……”', { profile })
    // 走(1) 吧(1) ……”(2) = 4 格（比默认少 1 格）
    expect(usedColumns(r, 0)).toBe(4)
  })

  it('综合：他说：“我们要加快建设……” 的完整排布', () => {
    const r = run('他说：“我们要加快建设……”')
    expect(rowTokens(r, 0)).toEqual([
      '他',
      '说',
      '：“',
      '我',
      '们',
      '要',
      '加',
      '快',
      '建',
      '设',
      '……',
      '”',
    ])
    // 他(1) 说(1) ：”(1) 我们要加快建设(7) ……(2) ”(1) = 13 格
    expect(usedColumns(r, 0)).toBe(13)
    expect(tokenTexts(r)).toEqual([
      '他',
      '说',
      '：“',
      '我',
      '们',
      '要',
      '加',
      '快',
      '建',
      '设',
      '……',
      '”',
    ])
  })
})

// ---------------------------------------------------------------------------
// TEST 18 / TEST 19：标题与段首缩进
// ---------------------------------------------------------------------------

describe('TEST 18 标题居中', () => {
  it('主标题居中排布，其余格留白', () => {
    const r = run('推动乡村振兴', {
      paragraphs: [{ kind: 'title', align: 'center', indentCells: 0 }],
    })
    // 6 个字，20 格 → 前置 (20-6)/2 = 7 格空白
    expect(firstUsedColumn(r, 0)).toBe(7)
    expect(rowContent(r, 0).join('')).toBe('推动乡村振兴')
    expect(r.rows[0].align).toBe('center')
    expect(r.rows[0].kind).toBe('title')
  })

  it('副标题同样居中', () => {
    const r = run('——建设宜居宜业和美乡村', {
      paragraphs: [{ kind: 'subtitle', align: 'center', indentCells: 0 }],
    })
    expect(r.rows[0].kind).toBe('subtitle')
    expect(firstUsedColumn(r, 0)).toBeGreaterThan(0)
  })

  it('超长标题超过一行时退回左对齐自动折行', () => {
    const long = '字'.repeat(25)
    const r = run(long, { paragraphs: [{ kind: 'title', align: 'center', indentCells: 0 }] })
    expect(firstUsedColumn(r, 0)).toBe(0)
    expect(rowCount(r)).toBe(2)
  })
})

describe('TEST 19 段首缩进', () => {
  it('默认正文段首缩进 2 格', () => {
    const r = run('第一段内容', { indent: true })
    expect(firstUsedColumn(r, 0)).toBe(2)
    expect(rowContent(r, 0).join('')).toBe('第一段内容')
  })

  it('缩进不写入逻辑文本（可导出为真正的首行缩进）', () => {
    const r = run('第一段内容', { indent: true })
    expect(r.text).toBe('第一段内容')
    expect(r.logicalCharCount).toBe(5)
  })

  it('题目类型可切换：小题顶格不缩进', () => {
    const r = run('第一段内容', { paragraphs: [{ kind: 'normal', align: 'left', indentCells: 0 }] })
    expect(firstUsedColumn(r, 0)).toBe(0)
  })

  it('关闭 autoIndentFirstLine 后不缩进', () => {
    const r = run('第一段内容')
    expect(firstUsedColumn(r, 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 容量与溢出
// ---------------------------------------------------------------------------

describe('段首缩进的边界情况', () => {
  it('首个 Token 比整行还宽时，缩进保留、不产生空白行、不误报超容量', () => {
    // 60 位数字 = 30 格，宽过一整行；缩进 2 格后只剩 18 格
    const r = run('1'.repeat(60), { indent: true, capacity: 40 })
    expect(r.rows[0].isBlankLine).toBe(false)
    expect(rowCount(r)).toBe(2)
    // 缩进仍然在
    expect(r.rows[0].cells[0].empty).toBe(true)
    expect(r.rows[0].cells[1].empty).toBe(true)
    expect(r.rows[0].cells[2].empty).toBe(false)
    // 只用了 30 格，容量 40 格不该报溢出
    expect(r.occupiedCellCount).toBe(30)
    expect(r.overflow).toBe(false)
  })

  it('首个 Token 放得进整行、只是塞不进缩进后的剩余格时，整块挪到行首且不被拆开', () => {
    // 38 位数字 = 19 格，缩进后只剩 18 格
    const r = run('1'.repeat(38), { indent: true })
    expect(rowCount(r)).toBe(1)
    expect(r.rows[0].isBlankLine).toBe(false)
    expect(usedColumns(r, 0)).toBe(19)
  })

  it('长英文串同样不会白占一行', () => {
    const r = run('www.example.com/very/long/path/to/resource', { indent: true })
    expect(r.rows[0].isBlankLine).toBe(false)
    // 41 个字符 = 21 格，宽过一整行 → 保留缩进后再拆
    expect(r.rows[0].cells[0].empty).toBe(true)
    expect(r.rows[0].cells[2].empty).toBe(false)
  })

  it('没有缩进时行为完全不变', () => {
    const r = run('1'.repeat(60))
    expect(rowCount(r)).toBe(2)
    expect(usedColumns(r, 0)).toBe(20)
    expect(usedColumns(r, 1)).toBe(10)
  })

  it('空段落仍然产生一整行空白答题区（与上面区分开）', () => {
    const r = run('第一段\n\n第二段', { indent: true })
    expect(rowCount(r)).toBe(3)
    expect(r.rows[1].isBlankLine).toBe(true)
  })
})

describe('容量与溢出', () => {
  it('150 字容量 → 8 行（20 格/行）', () => {
    const r = run('', { capacity: 150 })
    expect(r.capacityRows).toBe(8)
    expect(rowCount(r)).toBe(8)
  })

  it('超出容量不截断文本，只做溢出标记', () => {
    const text = '字'.repeat(45)
    const r = run(text, { capacity: 40 })
    expect(r.overflow).toBe(true)
    expect(r.text).toBe(text)
    expect(r.rows[2].overflow).toBe(true)
    expect(r.rows[1].overflow).toBe(false)
    expect(r.overflowCells).toBe(5)
  })

  it('溢出格数按实际占用格计算，不按字符数', () => {
    // 30 个数字 = 15 格；容量 10 格 → 第 11~15 格溢出
    const r = run('1'.repeat(30), { capacity: 10 })
    expect(r.occupiedCellCount).toBe(15)
    expect(r.overflowCells).toBe(5)
    expect(r.rows[0].cells[9].overflow).toBe(false)
    expect(r.rows[0].cells[10].overflow).toBe(true)
    expect(r.rows[0].cells[10].empty).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 稳定性 / 混合输入
// ---------------------------------------------------------------------------

describe('混合输入与稳定性', () => {
  it('中文 + 数字 + 英文 + 标点 + 空格 + 换行', () => {
    const text = '当前 GDP 增长5%，2026年目标：\n\n“稳中求进”。'
    const r = run(text)
    expect(r.text).toBe(text)
    expect(rowCount(r)).toBeGreaterThanOrEqual(3)
    expect(r.overflow).toBe(false)
  })

  it('删除再输入后重新排版结果一致（幂等）', () => {
    const a = run('他说：“我们要加快建设……”')
    const b = run('他说：“我们要加快建设……”')
    expect(rowText(a, 0)).toBe(rowText(b, 0))
  })

  it('emoji 与生僻字符按 1 格处理且不抛错', () => {
    const r = run('好👍')
    expect(usedColumns(r, 0)).toBe(2)
    expect(rowContent(r, 0)).toEqual(['好', '👍'])
  })

  it('空文本产生一行空白答题区', () => {
    const r = run('')
    expect(rowCount(r)).toBe(1)
    expect(firstUsedColumn(r, 0)).toBe(-1)
  })

  it('自动换行后内容接着排，行首不出现被挤下来的标点', () => {
    // 19 字 + 逗号刚好 20 格；内容从下一行行首继续
    const r = run('字'.repeat(19) + '，' + '内容')
    expect(usedColumns(r, 0)).toBe(20)
    expect(cellText(r, 0, 19)).toBe('，')
    expect(rowContent(r, 1)).toEqual(['内', '容'])
  })

  it('一行写满后继续输入，标点不会落在下一行行首', () => {
    const r = run(FULL + '，' + '内容')
    expect(usedColumns(r, 0)).toBe(20)
    expect(rowContent(r, 1)).toEqual(['内', '容'])
  })

  it('行末标点在行内不被拉到下一行（挤占优先于下拉）', () => {
    const r = run(FULL + '。')
    expect(r.rules.some((e) => e.type === 'line-end-pull-down')).toBe(false)
  })

  it('lineEndStrategy=allow 时不挤占，标点落到下一行行首', () => {
    const r = run(FULL + '。', { profile: { lineEndStrategy: 'allow', endOfLinePunctuationCompression: false } })
    expect(usedColumns(r, 0)).toBe(20)
    expect(cellText(r, 1, 0)).toBe('。')
  })

  it('lineEndStrategy=pull-down 时把前一格拉下来', () => {
    const r = run(FULL + '。', {
      profile: { lineEndStrategy: 'pull-down', endOfLinePunctuationCompression: false },
    })
    expect(usedColumns(r, 0)).toBe(19)
    expect(rowContent(r, 1)).toEqual(['字', '。'])
  })

  it('严格国标配置下不做任何压缩', () => {
    const r = run('他说：“好。”', {
      profile: {
        compoundPunctuation: false,
        endOfLinePunctuationCompression: false,
        lineEndStrategy: 'allow',
        pairArabicDigits: true,
      },
    })
    expect(rowContent(r, 0)).toEqual(['他', '说', '：', '“', '好', '。', '”'])
  })

  it('每行格数可配置：columns=25', () => {
    const r = run('字'.repeat(30), { columns: 25 })
    expect(usedColumns(r, 0)).toBe(25)
    expect(usedColumns(r, 1)).toBe(5)
  })
})

describe('规则可观测性', () => {
  it('每一次挤占 / 压缩都留下规则事件', () => {
    const r = run('字'.repeat(19) + '——' + FULL + '。')
    const types = r.rules.map((e) => e.type)
    expect(types).toContain('line-end-compress')
    expect(types).toContain('line-end-squeeze')
  })

  it('规则事件带上触发位置的文本 offset', () => {
    const r = run(FULL + '。')
    const ev = r.rules.find((e) => e.type === 'line-end-squeeze')!
    expect(ev.offset).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// 视觉结构抽检
// ---------------------------------------------------------------------------

describe('视觉结构', () => {
  it('每行永远是 columns 个格（含空白补齐格）', () => {
    const r = run('你好', { capacity: 60 })
    for (const row of r.rows) {
      expect(row.cells).toHaveLength(20)
    }
  })

  it('空白补齐行不影响占格统计', () => {
    const r = run('你好', { capacity: 60 })
    expect(r.occupiedCellCount).toBe(2)
    expect(rowCount(r)).toBe(3)
  })

  it('挤占格同时保留主字与标点两个占位者（逻辑 Token 不被吞掉）', () => {
    const r = run(FULL + '。')
    const lastCell = r.rows[0].cells[19]
    expect(lastCell.occupants).toHaveLength(2)
    expect(lastCell.occupants[0].render).toBe('normal')
    expect(lastCell.occupants[1].render).toBe('squeezed')
    // 两个 Token 都还在
    expect(r.tokens.some((t) => t.rawText === '。')).toBe(true)
  })
})

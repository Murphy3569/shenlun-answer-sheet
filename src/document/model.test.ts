/**
 * 文档模型测试：段落样式迁移、纯文本导出
 */

import { describe, expect, it } from 'vitest'
import {
  blockToPlainText,
  createBlock,
  createFullPaper,
  defaultParagraphStyle,
  reconcileParagraphStyles,
  sheetToPlainText,
  splitParagraphs,
  createSheet,
} from './model'
import type { ParagraphStyle } from './model'

const normal: ParagraphStyle = { kind: 'normal', align: 'left', indentCells: 2 }
const title: ParagraphStyle = { kind: 'title', align: 'center', indentCells: 0 }

describe('段落拆分', () => {
  it('按真实换行拆分段落', () => {
    expect(splitParagraphs('第一段\n第二段')).toEqual(['第一段', '第二段'])
  })

  it('CRLF 归一化成 LF', () => {
    expect(splitParagraphs('第一段\r\n第二段')).toEqual(['第一段', '第二段'])
  })

  it('连续换行产生空段落', () => {
    expect(splitParagraphs('第一段\n\n第二段')).toEqual(['第一段', '', '第二段'])
  })
})

describe('段落样式迁移', () => {
  it('文本不变时样式原样保留', () => {
    const styles = [title, normal]
    expect(reconcileParagraphStyles('标题\n正文', styles, '标题\n正文', true)).toEqual(styles)
  })

  it('在正文后面追加新段落时，旧样式不丢', () => {
    const next = reconcileParagraphStyles('标题\n正文', [title, normal], '标题\n正文\n新增段', true)
    expect(next[0]).toEqual(title)
    expect(next[1]).toEqual(normal)
    // 新段落继承前一段
    expect(next[2]).toEqual(normal)
  })

  it('在中间插入段落时样式不错位', () => {
    const next = reconcileParagraphStyles('标题\n正文', [title, normal], '标题\n插入\n正文', true)
    expect(next[0]).toEqual(title)
    expect(next[2]).toEqual(normal)
  })

  it('删除段落时样式跟着消失', () => {
    const next = reconcileParagraphStyles('标题\n正文\n结尾', [title, normal, normal], '标题\n结尾', true)
    expect(next).toHaveLength(2)
    expect(next[0]).toEqual(title)
  })

  it('在正文段中间插字，标题段与正文段的样式都不会错位', () => {
    const oldText = '推动乡村振兴\n当前，我国经济社会发展进入新阶段。'
    const newText = '推动乡村振兴\n当前，我国经济社会发展进入新的阶段。'
    const next = reconcileParagraphStyles(oldText, [title, normal], newText, true)
    expect(next[0]).toEqual(title)
    expect(next[1]).toEqual(normal)
  })

  it('删掉段首一个字也不会把样式让给邻段', () => {
    const oldText = '推动乡村振兴\n当前，我国发展进入新阶段。'
    const newText = '推动乡村振兴\n前，我国发展进入新阶段。'
    const next = reconcileParagraphStyles(oldText, [title, normal], newText, true)
    expect(next[0]).toEqual(title)
    expect(next[1]).toEqual(normal)
  })

  it('段落数变化时，中间被改写的段落仍能认出是同一段', () => {
    const oldText = '标题\n正文甲\n正文乙'
    const newText = '标题\n正文甲改\n新增段\n正文乙'
    const next = reconcileParagraphStyles(oldText, [title, normal, normal], newText, true)
    expect(next[0]).toEqual(title)
    expect(next[1]).toEqual(normal)
    expect(next[3]).toEqual(normal)
  })

  it('标题行内继续打字不会丢掉标题样式', () => {
    const next = reconcileParagraphStyles('标题', [title], '标题文字', true)
    expect(next[0]).toEqual(title)
  })

  it('新建空文档时得到默认段落样式', () => {
    expect(reconcileParagraphStyles('', [], '', true)).toEqual([defaultParagraphStyle(true)])
  })
})

describe('纯文本导出', () => {
  it('只输出用户原文，不含方格或页码', () => {
    const block = createBlock('第（一）大题', 300)
    block.text = '当前，我国经济社会发展进入新阶段。'
    expect(blockToPlainText(block)).toBe('当前，我国经济社会发展进入新阶段。')
  })

  it('保留用户真实换行', () => {
    const block = createBlock('第（一）大题', 300)
    block.text = '第一段\n第二段'
    expect(blockToPlainText(block)).toBe('第一段\n第二段')
  })

  it('段首缩进不写入文本（缩进是排版属性，不是空格字符）', () => {
    const block = createBlock('第（一）大题', 300, true)
    block.text = '第一段内容'
    expect(blockToPlainText(block)).toBe('第一段内容')
    expect(blockToPlainText(block).startsWith(' ')).toBe(false)
  })

  it('整卷导出时带上题号，各题之间空一行', () => {
    const sheet = createSheet('full')
    sheet.blocks[0].text = '甲的答案'
    sheet.blocks[1].text = '乙的答案'
    const text = sheetToPlainText(sheet)
    expect(text.startsWith('【第一题】\n甲的答案\n\n【第二题】\n乙的答案')).toBe(true)
    // 没作答的题目也要保留题号，方便对照
    expect(text).toContain('【第五题】')
  })

  it('只有一道题时不加题号，保持纯净', () => {
    const sheet = createSheet('single')
    sheet.blocks[0].text = '就这一题的答案'
    expect(sheetToPlainText(sheet)).toBe('就这一题的答案')
  })

  it('整卷模式的题目结构与参考答题卡一致', () => {
    const blocks = createFullPaper()
    expect(blocks.map((b) => b.capacity)).toEqual([200, 200, 300, 400, 1000])
    expect(blocks[0].title).toBe('第一题')
  })
})

describe('题目缩进策略', () => {
  it('小题默认顶格，大作文默认缩进两格', () => {
    const single = createSheet('single')
    expect(single.blocks[0].indentFirstLine).toBe(true)

    const full = createFullPaper()
    expect(full[0].indentFirstLine).toBe(false) // 归纳概括类小题
    expect(full[4].indentFirstLine).toBe(true) // 大作文
  })
})

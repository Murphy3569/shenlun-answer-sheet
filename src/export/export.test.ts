/**
 * 导出测试
 *
 * 验收重点（需求 TEST 16 / TEST 17 / TEST 18 / TEST 19）：
 *   · Word / PDF 产物里**绝不能出现答题格**
 *   · 标题居中、段首缩进、真实换行必须保留
 *   · 中文字体必须显式写入 eastAsia，否则 Word 里会掉回默认字体
 */

import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createBlock, createSheet } from '../document/model'
import type { AnswerSheet } from '../document/model'
import { buildDocxBlob } from './exportDocx'
import { buildPrintHtml } from './exportPdf'

function makeSheet(): AnswerSheet {
  const sheet = createSheet('single', 300)
  const block = sheet.blocks[0]
  block.text = '推动乡村振兴\n第一段正文内容，这里有标点。\n第二段正文内容……'
  block.paragraphStyles = [
    { kind: 'title', align: 'center', indentCells: 0 },
    { kind: 'normal', align: 'left', indentCells: 2 },
    { kind: 'normal', align: 'left', indentCells: 2 },
  ]
  return sheet
}

async function documentXml(sheet: AnswerSheet): Promise<string> {
  const blob = await buildDocxBlob(sheet, { keepIndent: true })
  const buffer = new Uint8Array(await blob.arrayBuffer())
  // zip 魔数校验：产物必须是合法 docx 包
  expect(buffer[0]).toBe(0x50)
  expect(buffer[1]).toBe(0x4b)
  const zip = await JSZip.loadAsync(buffer)
  const file = zip.file('word/document.xml')
  expect(file).not.toBeNull()
  return file!.async('string')
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

describe('TEST 16 Word 导出：不含任何网格', () => {
  it('产物里没有表格（答题格只能用表格模拟，没有表格就没有格子）', async () => {
    const xml = await documentXml(makeSheet())
    expect(xml).not.toContain('<w:tbl>')
    expect(xml).not.toContain('<w:tblPr>')
  })

  it('没有边框定义，不会画出可见线框', async () => {
    const xml = await documentXml(makeSheet())
    expect(xml).not.toContain('<w:tblBorders>')
  })

  it('用户文本逐字保留', async () => {
    const xml = await documentXml(makeSheet())
    expect(xml).toContain('推动乡村振兴')
    expect(xml).toContain('第一段正文内容，这里有标点。')
    expect(xml).toContain('第二段正文内容')
  })
})

describe('TEST 18 / 19 Word 导出：标题居中与段首缩进', () => {
  it('标题段落居中', async () => {
    const xml = await documentXml(makeSheet())
    expect(xml).toContain('w:jc w:val="center"')
  })

  it('正文首行缩进用字符单位（firstLineChars=200 即两个字符）', async () => {
    const xml = await documentXml(makeSheet())
    expect(xml).toContain('w:firstLineChars="200"')
    expect(xml).not.toContain('w:firstLine="200"')
  })

  it('关闭缩进后不写 firstLineChars', async () => {
    const blob = await buildDocxBlob(makeSheet(), { keepIndent: false })
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).not.toContain('firstLineChars')
  })
})

describe('Word 中文字体', () => {
  it('正文与标题都显式指定了 eastAsia 字体', async () => {
    const xml = await documentXml(makeSheet())
    expect(xml).toContain('w:eastAsia="仿宋_GB2312"')
    expect(xml).toContain('w:eastAsia="方正小标宋简体"')
  })
})

describe('Word 换行处理', () => {
  it('段落本身用 Paragraph 分隔，不产生多余的软换行', async () => {
    const xml = await documentXml(makeSheet())
    expect(xml).not.toContain('<w:br/>')
  })

  it('段落内部的真实换行转成 <w:br/>', async () => {
    const sheet = createSheet('single', 300)
    sheet.blocks[0].text = '段落内的软换行'
    sheet.blocks[0].paragraphStyles = [{ kind: 'normal', align: 'left', indentCells: 0 }]
    // 人为构造一个段内含换行的文本（粘贴场景）。
    // 这里用 U+000B 而不是 \n：\n 在更上层就被 splitParagraphs 拆成两段了，
    // 到不了 textToRuns 的换行分支。U+000B 正是 Word 里 Shift+Enter 手动换行
    // 落到纯文本剪贴板上的样子，也是最真实的触发路径。
    sheet.blocks[0].text = '第一行\u000b第二行'
    const blob = await buildDocxBlob(sheet)
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:br/>')
    expect(xml).toContain('第一行')
    expect(xml).toContain('第二行')
  })

  it('C0 控制字符不会让 document.xml 变成非法 XML', async () => {
    // Word 里 Shift+Enter 的手动换行，落到纯文本剪贴板就是 U+000B；从 PDF 复制常带 U+000C；
    // U+0000 之类的垃圾字符也可能混进来。XML 1.0 只允许 \t \n \r 三个控制字符，
    // 其余原样写进去，Word 会判定「文件已损坏」直接打不开。
    const sheet = createSheet('single', 300)
    sheet.blocks[0].paragraphStyles = [{ kind: 'normal', align: 'left', indentCells: 0 }]
    sheet.blocks[0].text = '第一行\u000b第二行\u0000第三行\u000c第四行'
    const blob = await buildDocxBlob(sheet)
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()))
    const xml = await zip.file('word/document.xml')!.async('string')

    const illegal = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]')
    expect(illegal.test(xml), '生成的 XML 里仍有非法控制字符').toBe(false)

    // U+000B / U+000C 在 Word 里本来就代表换行/分页，按换行处理；U+0000 直接丢掉
    expect(xml).toContain('第一行')
    expect(xml).toContain('第二行')
    expect(xml).toContain('第四行')
  })

  it('连续空格原样保留', async () => {
    const sheet = createSheet('single', 300)
    sheet.blocks[0].text = '  前面有两个空格'
    sheet.blocks[0].paragraphStyles = [{ kind: 'normal', align: 'left', indentCells: 0 }]
    const blob = await buildDocxBlob(sheet)
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('xml:space="preserve"')
    expect(xml).toContain('  前面有两个空格')
  })
})

// ---------------------------------------------------------------------------
// PDF（打印版）
// ---------------------------------------------------------------------------

describe('TEST 17 PDF 导出：不含任何网格', () => {
  it('产物是纯文本段落，没有任何格子 / 答题卡模板标记', () => {
    const html = buildPrintHtml(makeSheet(), { keepIndent: true })
    expect(html).not.toContain('class="cell')
    expect(html).not.toContain('grid-row')
    expect(html).not.toContain('sheet-page')
    expect(html).not.toContain('申论答题卡')
    expect(html).not.toContain('全卷到此结束')
    expect(html).not.toContain('第 1 页')
    expect(html).not.toContain('缺考')
  })

  it('用户文本完整保留', () => {
    const html = buildPrintHtml(makeSheet(), { keepIndent: true })
    expect(html).toContain('推动乡村振兴')
    expect(html).toContain('第一段正文内容，这里有标点。')
    expect(html).toContain('第二段正文内容')
  })

  it('标题居中', () => {
    const html = buildPrintHtml(makeSheet(), { keepIndent: true })
    expect(html).toContain('class="pdf-title"')
  })

  it('段首缩进用 text-indent（不是空格字符）', () => {
    const html = buildPrintHtml(makeSheet(), { keepIndent: true })
    expect(html).toContain('text-indent:2em')
    expect(html).not.toContain('&nbsp;&nbsp;第一段')
  })

  it('HTML 转义：用户输入的尖括号不会破坏结构', () => {
    const sheet = createSheet('single', 300)
    sheet.blocks[0].text = '<script>alert(1)</script>'
    sheet.blocks[0].paragraphStyles = [{ kind: 'normal', align: 'left', indentCells: 0 }]
    const html = buildPrintHtml(sheet)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert')
  })

  it('连续空格转成 &nbsp; 不被浏览器折叠', () => {
    const sheet = createSheet('single', 300)
    sheet.blocks[0].text = '甲    乙'
    sheet.blocks[0].paragraphStyles = [{ kind: 'normal', align: 'left', indentCells: 0 }]
    const html = buildPrintHtml(sheet)
    expect(html).toContain('&nbsp;&nbsp;&nbsp;&nbsp;')
  })

  it('整卷模式导出时带上各题标题', () => {
    const sheet = createSheet('full')
    sheet.blocks[0].text = '第一题作答'
    const html = buildPrintHtml(sheet)
    expect(html).toContain('第一题')
    expect(html).toContain('第一题作答')
  })
})

// ---------------------------------------------------------------------------
// 导出内容 = 逻辑原文
// ---------------------------------------------------------------------------

describe('导出内容与网页显示的关系', () => {
  it('自动换行不进入导出结果（导出用的是逻辑文本，不是行布局）', async () => {
    const sheet = createSheet('single', 300)
    const block = createBlock('题目', 300, false)
    block.text = '字'.repeat(45) // 屏幕上会折成 3 行
    sheet.blocks = [block]

    const xml = await (async () => {
      const blob = await buildDocxBlob(sheet)
      const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()))
      return zip.file('word/document.xml')!.async('string')
    })()
    expect(xml).toContain('字'.repeat(45))
    expect(xml).not.toContain('<w:br/>')
  })
})

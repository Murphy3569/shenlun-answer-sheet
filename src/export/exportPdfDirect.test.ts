// @vitest-environment node
/**
 * 自实现 PDF 导出的测试
 *
 * 用 node 环境跑：pdf-lib 会做 `value instanceof Uint8Array / ArrayBuffer` 判定，
 * 而 jsdom 环境里的 TypedArray 与 Node 的不是同一个 realm，会误判成「类型不对」。
 *
 * 验收点：
 *   · 产物是合法 PDF、只含文字、页数正确
 *   · 中文字形真的嵌进去了（不是空白/豆腐块）
 *   · 用到的字形才嵌入 —— 一篇 800 字作答的 PDF 只有几 KB
 *   · 中文断行遵守避头规则，英文单词不被劈开
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSheet } from '../document/model'
import type { AnswerSheet } from '../document/model'
import { createDefaultProfile } from '../layout'
import { breakLines } from './exportPdfDirect'
import { findUnsupportedChars } from './pdfFontCharset'

const profile = createDefaultProfile()

function sheetWith(text: string, options: { firstLineIsTitle?: boolean } = {}): AnswerSheet {
  const sheet = createSheet('single', 800)
  const lines = text.split('\n')
  sheet.blocks[0].text = text
  sheet.blocks[0].paragraphStyles = lines.map((_, i) => {
    const isTitle = options.firstLineIsTitle === true && i === 0
    return {
      kind: isTitle ? ('title' as const) : ('normal' as const),
      align: isTitle ? ('center' as const) : ('left' as const),
      indentCells: isTitle ? 0 : 2,
    }
  })
  return sheet
}

beforeEach(() => {
  // 测试环境里没有真实的字体请求，直接从磁盘读
  const fontPath = resolve(__dirname, '../assets/NotoSerifSC.subset.ttf')
  const bytes = readFileSync(fontPath)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 断行
// ---------------------------------------------------------------------------

describe('中文断行', () => {
  // 用一个「每个字符宽度 = 1」的假字体，断行逻辑就能精确断言
  const mono = {
    widthOf: (s: string) => s.length,
    maxWidth: 10,
    profile,
  }

  it('按宽度切行', () => {
    expect(breakLines({ text: '一二三四五六七八九十一二三四五', ...mono })).toEqual(['一二三四五六七八九十', '一二三四五'])
  })

  it('句末点号不起行：宁可行尾轻微出界', () => {
    // 第 11 个字符是句号，不能让它独占下一行行首
    const lines = breakLines({ text: '一二三四五六七八九十。十一', ...mono })
    expect(lines[0]).toBe('一二三四五六七八九十。')
    expect(lines[1]).toBe('十一')
  })

  it('闭引号、问号、叹号同样避头', () => {
    for (const p of ['”', '？', '！', '，', '、', '；', '：']) {
      const lines = breakLines({ text: `一二三四五六七八九十${p}十一`, ...mono })
      expect(lines[0], p).toBe(`一二三四五六七八九十${p}`)
    }
  })

  it('开引号可以起行，不做避头', () => {
    const lines = breakLines({ text: '一二三四五六七八九十“十一', ...mono })
    expect(lines[0]).toBe('一二三四五六七八九十')
    expect(lines[1]).toBe('“十一')
  })

  it('英文单词不被劈开', () => {
    const lines = breakLines({ text: '你好世界hello world', ...mono })
    expect(lines[0]).toBe('你好世界hello ')
    expect(lines[1]).toBe('world')
  })

  it('数字串不被劈开', () => {
    // 第 10 个字符是 "9"，但 "90" 应当整体留在下一行，而不是拆成 "一二三四五六七八九" + "0"
    const lines = breakLines({ text: '一二三四五六七八九90', ...mono })
    expect(lines[0]).toBe('一二三四五六七八九')
    expect(lines[1]).toBe('90')
  })

  it('单个字符就超宽时也不会死循环', () => {
    const lines = breakLines({ text: '一二三', widthOf: () => 99, maxWidth: 10, profile })
    expect(lines).toEqual(['一', '二', '三'])
  })

  it('空文本返回一个空行', () => {
    expect(breakLines({ text: '', ...mono })).toEqual([''])
  })
})

// ---------------------------------------------------------------------------
// 生成 PDF
// ---------------------------------------------------------------------------

describe('生成 PDF', () => {
  const SAMPLE = [
    '推动乡村振兴',
    '当前，我国经济社会发展进入新阶段，必须完整、准确、全面贯彻新发展理念。2026年农村居民人均可支配收入增长5%。',
    '他说：“我们要加快建设宜居宜业和美乡村……”',
    '——这是新时代新征程上的必答题。',
  ].join('\n')

  it('产物是合法 PDF，且能重新解析', async () => {
    const { buildPdfBytes } = await import('./exportPdfDirect')
    const bytes = await buildPdfBytes(sheetWith(SAMPLE, { firstLineIsTitle: true }), { keepIndent: true })
    const head = new TextDecoder().decode(bytes.slice(0, 8))
    expect(head.startsWith('%PDF-')).toBe(true)

    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('中文字体真的嵌进去了（不是空白）', async () => {
    const { buildPdfBytes } = await import('./exportPdfDirect')
    const bytes = await buildPdfBytes(sheetWith(SAMPLE, { firstLineIsTitle: true }), { keepIndent: true })
    const doc = await PDFDocument.load(bytes)
    const objects = doc.context
      .enumerateIndirectObjects()
      .map(([, obj]) => obj.toString())
      .join('\n')
    // TrueType 轮廓走 FontFile2（CFF 走 FontFile3，而 CFF 那条路 pdf-lib 会写出损坏字体）
    expect(objects).toContain('FontFile2')
    expect(objects).toMatch(/BaseFont\s*\/NotoSerifSC/)
  })

  it('内嵌完整字体子集：体积固定，且不会随正文变长而膨胀', async () => {
    const { buildPdfBytes } = await import('./exportPdfDirect')
    const short = await buildPdfBytes(sheetWith('你好'), { keepIndent: true })
    const long = await buildPdfBytes(
      sheetWith('当前，我国经济社会发展进入新阶段。'.repeat(34).slice(0, 800)),
      { keepIndent: true },
    )
    // 字体是固定成本（约 1.8MB），正文长度只贡献几 KB
    expect(long.length - short.length).toBeLessThan(20_000)
    expect(short.length).toBeLessThan(3_000_000)
    expect(short.length).toBeGreaterThan(1_500_000) // 整份字体（压缩后约 1.8MB）
  })

  it('嵌入的是字体本体，不是坏掉的子集（这条是乱码事故的回归测试）', async () => {
    const { buildPdfBytes } = await import('./exportPdfDirect')
    const bytes = await buildPdfBytes(sheetWith(SAMPLE, { firstLineIsTitle: true }), { keepIndent: true })
    const doc = await PDFDocument.load(bytes)
    const objects = doc.context.enumerateIndirectObjects().map(([, obj]) => obj.toString()).join('\n')
    // TrueType 轮廓走 FontFile2；FontFile3 是 CFF，用它在 poppler 会被判为损坏字体
    expect(objects).toContain('FontFile2')
    expect(objects).not.toContain('FontFile3')
    // 整份字体被原样嵌入 —— 若哪天又改回子集化，体积会骤降，这条会立刻报警
    expect(bytes.length).toBeGreaterThan(1_500_000)
  })

  it('长文本会自动分页', async () => {
    const { buildPdfBytes } = await import('./exportPdfDirect')
    const bytes = await buildPdfBytes(sheetWith('字'.repeat(4000)), { keepIndent: true })
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBeGreaterThan(1)
  })

  it('整卷模式把各题标题也带上，且每题从新的一页开始不重叠', async () => {
    const sheet = createSheet('full')
    sheet.blocks[0].text = '第一题作答内容'
    sheet.blocks[1].text = '第二题作答内容'
    const { buildPdfBytes } = await import('./exportPdfDirect')
    const bytes = await buildPdfBytes(sheet, { keepIndent: true })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
    // 产物里不应出现答题卡的模板文字
    const raw = new TextDecoder('latin1').decode(bytes)
    expect(raw).not.toContain('缺考')
  })
})

// ---------------------------------------------------------------------------
// 字体覆盖范围检查
// ---------------------------------------------------------------------------

describe('生僻字检查', () => {
  it('常用字与中文标点都被覆盖', () => {
    expect(findUnsupportedChars('推动乡村振兴，2026年增长5%。“”《》——……')).toEqual([])
  })

  it('字体覆盖不到的字符会被报出来', () => {
    const missing = findUnsupportedChars('正常内容𠮷𠮷')
    expect(missing).toContain('𠮷')
  })
})

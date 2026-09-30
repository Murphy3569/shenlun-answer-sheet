/**
 * PDF 导出（自实现，一键下载）
 *
 * 之前走的是浏览器打印管线 —— 排版最省事，但必然弹打印对话框、还要用户手动取消页眉页脚。
 * 这里改成自己生成 PDF：pdf-lib + 一份随包分发的**中文字体子集**。
 *
 * 字体问题的实情：浏览器里导出中文 PDF，绕不开「必须自带字体」这件事 ——
 * 系统字体拿不到、PDF 标准 14 字体没有中文。解决办法是把一份 OFL 许可的
 * Noto Serif SC 子集（GB2312 全集 + ASCII + 中文标点，2.9MB）放进包里。
 *
 * ⚠️ 为什么是「整份嵌入」而不是「只嵌用到的字形」：
 * pdf-lib 自带的二次子集化（`subset: true`）对 CJK 字体不可靠 —— 实测会产出
 * 损坏的字体（CFF 版本 poppler 直接报 Embedded font file may be invalid；
 * TrueType 版本则是大面积汉字在渲染时丢失），而 CJK 字体又是最容易踩中的。
 * 这些问题在「文本抽取」时看不出来（抽取走 ToUnicode），只有把 PDF 渲染成图才暴露。
 * 所以这里选择 `subset: false`：产物固定多出约 1.8MB，但排版与字形 100% 正确。
 * 字体只在第一次导出时下载一次，之后走浏览器缓存。
 *
 * 自动换行也自己做：中文可以在任意字之间断行，但不能让句末点号起行（避头），
 * 也不能把英文单词/数字串从中间劈开。断行规则直接复用 layout 引擎里那份标点表。
 */

import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import fontUrl from '../assets/NotoSerifSC.subset.ttf?url'
import { splitParagraphs } from '../document/model'
import type { AnswerBlock, AnswerSheet, ParagraphStyle } from '../document/model'
import { createDefaultProfile, tokenize } from '../layout'
import { lineRulesOf } from '../layout'
import type { LayoutProfile } from '../layout'
import { findUnsupportedChars } from './pdfFontCharset'

// ---------------------------------------------------------------------------
// 版面参数（单位 pt，1mm ≈ 2.8346pt）
// ---------------------------------------------------------------------------

const A4_WIDTH = 595.28
const A4_HEIGHT = 841.89
const MARGIN = 56.7 // 20mm
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2

const BODY_SIZE = 14 // 正文（约小四）
const TITLE_SIZE = 20 // 主标题
const SUBTITLE_SIZE = 15
const BLOCK_TITLE_SIZE = 14
const LINE_HEIGHT = 26
const TITLE_GAP = 14
const BLOCK_GAP = 10

const INK = rgb(0, 0, 0)

export interface PdfDirectOptions {
  title?: string
  keepIndent?: boolean
  blocks?: AnswerBlock[]
}

/** 文本里是否含有内置字体覆盖不到的字符 */
export function collectUnsupportedChars(sheet: AnswerSheet, blocks?: AnswerBlock[]): string[] {
  const target = blocks ?? sheet.blocks
  return findUnsupportedChars(target.map((b) => b.text).join(''))
}

// ---------------------------------------------------------------------------
// 字体：只加载一次，缓存在模块里
// ---------------------------------------------------------------------------

let fontBytesPromise: Promise<ArrayBuffer> | null = null

function loadFontBytes(): Promise<ArrayBuffer> {
  if (!fontBytesPromise) {
    fontBytesPromise = fetch(fontUrl).then((res) => {
      if (!res.ok) throw new Error(`字体加载失败：HTTP ${res.status}`)
      return res.arrayBuffer()
    })
  }
  return fontBytesPromise
}

// ---------------------------------------------------------------------------
// 中文断行
// ---------------------------------------------------------------------------

interface BreakInput {
  text: string
  widthOf: (s: string) => number
  maxWidth: number
  profile: LayoutProfile
  /** 首行右侧要留出的空白（段首缩进的宽度）。首行可用宽度 = maxWidth - 这个值 */
  firstLineIndent?: number
}

/**
 * 把一个段落切成若干行。
 *
 * 直接复用排版引擎的 tokenizer 与标点表，而不是逐字符切 ——
 * 这样「省略号 / 破折号不可拆」「数字与英文串保持完整」「句末点号不起行」
 * 与屏幕上的方格排版用的是同一套规则，不会出现「纸上和屏幕不一样」。
 */
export function breakLines({ text, widthOf, maxWidth, profile, firstLineIndent = 0 }: BreakInput): string[] {
  const tokens = tokenize(text, profile).filter((t) => t.type !== 'LINE_BREAK')
  if (tokens.length === 0) return ['']

  const lines: string[] = []
  let line = ''
  let width = 0
  let lineStart = 0
  // 首行要缩进时，可用宽度必须扣掉缩进 —— 否则首行会比其它行多伸出一截、戳进右边距。
  // 原来的写法所有行都按整版心宽度折，缩进只是把首行整体右移，右端就冒出去了。
  let lineMax = maxWidth - firstLineIndent

  const pushLine = (upTo: number) => {
    lines.push(line)
    line = ''
    width = 0
    lineStart = upTo
    lineMax = maxWidth
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const tokenWidth = widthOf(token.rawText)

    // 单个 Token 就比一整行还宽（超长英文串 / 长数字）→ 只能逐字符拆。
    // 注意不能只在它恰好落在行首时才拆：落在行中时若整段塞进一行，
    // 这一行会有一两千 pt 宽，直接画到纸外，内容静默丢失（屏幕上方格视图可是逐格折行的）。
    if (tokenWidth > maxWidth) {
      if (line.length > 0) pushLine(i)
      for (const ch of token.rawText) {
        const w = widthOf(ch)
        if (width + w > lineMax && line.length > 0) pushLine(i)
        line += ch
        width += w
      }
      continue
    }

    if (width + tokenWidth <= lineMax || i === lineStart) {
      line += token.rawText
      width += tokenWidth
      continue
    }

    // 避头：句末点号、闭标号、破折号（按配置）不能起行 → 挂在当前行行尾
    if (lineRulesOf(token, profile).noLineStart) {
      line += token.rawText
      width += tokenWidth
      continue
    }

    pushLine(i)
    line = token.rawText
    width = tokenWidth
  }

  if (line.length > 0) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

// ---------------------------------------------------------------------------
// 生成 PDF
// ---------------------------------------------------------------------------

export async function buildPdfBytes(sheet: AnswerSheet, options: PdfDirectOptions = {}): Promise<Uint8Array> {
  const blocks = options.blocks ?? sheet.blocks
  const keepIndent = options.keepIndent ?? true
  const profile = createDefaultProfile()

  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  // subset: false —— 见文件头说明，pdf-lib 的子集化对 CJK 字体会产出坏字体
  const font = await doc.embedFont(await loadFontBytes(), { subset: false })

  const widthOf = (s: string, size: number) => font.widthOfTextAtSize(s, size)

  let page = doc.addPage([A4_WIDTH, A4_HEIGHT])
  let y = A4_HEIGHT - MARGIN

  /** 需要换页时补一页 */
  const ensureRoom = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([A4_WIDTH, A4_HEIGHT])
      y = A4_HEIGHT - MARGIN
    }
  }

  const drawCentered = (text: string, size: number) => {
    // 标题同样要折行：超长标题不能画成一行冲出页面
    const lines = breakLines({ text, widthOf: (s) => widthOf(s, size), maxWidth: CONTENT_WIDTH, profile })
    for (const lineText of lines) {
      ensureRoom(size + 8)
      const w = widthOf(lineText, size)
      page.drawText(lineText, { x: (A4_WIDTH - w) / 2, y: y - size, size, font, color: INK })
      y -= size + 8
    }
    y -= TITLE_GAP - 8
  }

  const drawParagraph = (text: string, style: ParagraphStyle, size: number) => {
    const isHeading = style.kind === 'title' || style.kind === 'subtitle'
    if (isHeading) {
      drawCentered(text, style.kind === 'title' ? TITLE_SIZE : SUBTITLE_SIZE)
      return
    }
    if (text.length === 0) {
      // 空段落：只占一行高度
      ensureRoom(LINE_HEIGHT)
      y -= LINE_HEIGHT
      return
    }

    const indent = keepIndent && style.indentCells > 0 ? style.indentCells * size : 0
    const lines = breakLines({
      text,
      widthOf: (s) => widthOf(s, size),
      maxWidth: CONTENT_WIDTH,
      profile,
      firstLineIndent: indent,
    })

    lines.forEach((lineText, index) => {
      ensureRoom(LINE_HEIGHT)
      const x = style.align === 'center' ? (A4_WIDTH - widthOf(lineText, size)) / 2 : MARGIN + (index === 0 ? indent : 0)
      page.drawText(lineText, { x, y: y - size, size, font, color: INK })
      y -= LINE_HEIGHT
    })
  }

  if (options.title && options.title.trim().length > 0) {
    drawCentered(options.title.trim(), TITLE_SIZE)
    y -= 6
  }

  blocks.forEach((block, blockIndex) => {
    if (blocks.length > 1) {
      if (blockIndex > 0) y -= BLOCK_GAP
      ensureRoom(BLOCK_TITLE_SIZE + BLOCK_GAP)
      page.drawText(`【${block.title}】`, { x: MARGIN, y: y - BLOCK_TITLE_SIZE, size: BLOCK_TITLE_SIZE, font, color: INK })
      y -= BLOCK_TITLE_SIZE + BLOCK_GAP
    }
    const paragraphs = splitParagraphs(block.text)
    paragraphs.forEach((text, i) => {
      const style: ParagraphStyle = block.paragraphStyles[i] ?? { kind: 'normal', align: 'left', indentCells: 0 }
      drawParagraph(text, style, BODY_SIZE)
    })
  })

  return doc.save()
}

/** 生成并触发下载 */
export async function exportPdfDirect(sheet: AnswerSheet, options: PdfDirectOptions = {}): Promise<void> {
  const bytes = await buildPdfBytes(sheet, options)
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `申论作答-${timestamp()}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

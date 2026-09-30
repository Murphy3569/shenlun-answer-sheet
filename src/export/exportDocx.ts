/**
 * Word 导出 —— 只导出用户真正输入的内容，绝不带任何方格。
 *
 * 关键坑（都已处理）：
 *   1. 中文字体必须显式写 eastAsia。只写 font: 'SimSun' 字符串形式没问题，
 *      但对象形式必须点明 eastAsia，否则会落到主题字体（等线），也就是「变回默认字体」。
 *   2. TextRun 里的 "\n" **不会**被 Word 换行，必须手工插入 new TextRun({ break: 1 })。
 *   3. "\t" 同理，必须用 new TextRun({ children: [new Tab()] })。
 *   4. 首行缩进用 firstLineChars（字符单位），不要用 firstLine（twip），
 *      否则改字号后缩进就不等于两个字符了。
 *   5. 不设置任何 border，避免出现可见线框。
 */

import {
  AlignmentType,
  Document,
  LineRuleType,
  Packer,
  Paragraph,
  Tab,
  TextRun,
  convertMillimetersToTwip,
} from 'docx'
import { splitParagraphs } from '../document/model'
import type { AnswerBlock, AnswerSheet, ParagraphStyle } from '../document/model'

/** 正文：仿宋_GB2312 三号（size 单位是半磅，32 = 16pt = 三号） */
const FONT_BODY = {
  ascii: 'Times New Roman',
  hAnsi: 'Times New Roman',
  eastAsia: '仿宋_GB2312',
}
/** 标题：方正小标宋 二号（44 = 22pt） */
const FONT_TITLE = {
  ascii: 'Times New Roman',
  hAnsi: 'Times New Roman',
  eastAsia: '方正小标宋简体',
}
const SIZE_BODY = 32
const SIZE_TITLE = 44
const SIZE_SUBTITLE = 32
/** 公文常用固定行距 28 磅 = 560 twip（EXACT 下单位是 twip） */
const LINE_TWIP = 560

export interface DocxExportOptions {
  /** 文档标题（放在最前面居中，可空） */
  title?: string
  /** 是否保留段首缩进 */
  keepIndent?: boolean
  /** 导出的答题块；缺省用整卷 */
  blocks?: AnswerBlock[]
}

/**
 * .docx 里的 word/document.xml 是 XML 1.0，只允许 \t \n \r 这三个控制字符。
 *
 * 用户的文本里却常常混进别的：从 Word 粘「Shift+Enter 的手动换行」过来是 U+000B，
 * 从 PDF 复制常带 U+000C。原样写进去，document.xml 就不是良构 XML ——
 * xmllint 会报 `PCDATA invalid Char value 11`，Word 直接判「文件已损坏」打不开，
 * 而界面上还笑眯眯地提示「已导出 Word」。
 *
 * U+000B / U+000C / U+2028 / U+2029 在 Word 里本来就是换行或分页的意思，统一按换行处理；
 * 其余 C0 控制字符没有任何排版含义，直接丢掉。
 */
function sanitizeForXml(text: string): string {
  return text
    .replace(/[\v\f\u2028\u2029]/g, '\n')
    .replace(/[\u0000-\u0008\u000E-\u001F]/g, '')
}

/** 把一段用户文本转成 TextRun 序列，正确处理真实换行与制表符 */
function textToRuns(text: string, font: Record<string, string>, size: number): TextRun[] {
  const runs: TextRun[] = []
  const lines = sanitizeForXml(text).replace(/\r\n?/g, '\n').split('\n')
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) runs.push(new TextRun({ break: 1 }))
    line.split('\t').forEach((segment, segIndex) => {
      if (segIndex > 0) runs.push(new TextRun({ children: [new Tab()] }))
      if (segment.length > 0) runs.push(new TextRun({ text: segment, font, size }))
    })
  })
  if (runs.length === 0) runs.push(new TextRun({ text: '', font, size }))
  return runs
}

function styleToDocxParagraph(
  text: string,
  style: ParagraphStyle,
  options: { keepIndent: boolean; hasHeading: boolean },
): Paragraph {
  const isHeading = style.kind === 'title' || style.kind === 'subtitle'
  const font = isHeading ? FONT_TITLE : FONT_BODY
  const size = style.kind === 'title' ? SIZE_TITLE : style.kind === 'subtitle' ? SIZE_SUBTITLE : SIZE_BODY

  const indent =
    !isHeading && options.keepIndent && style.indentCells > 0
      ? // firstLineChars: 100 = 1 个字符；200 = 2 个字符
        { firstLineChars: style.indentCells * 100 }
      : undefined

  void options.hasHeading
  return new Paragraph({
    alignment: isHeading ? AlignmentType.CENTER : alignmentOf(style.align),
    spacing: { line: LINE_TWIP, lineRule: LineRuleType.EXACT },
    children: textToRuns(text, font, size),
    ...(indent ? { indent } : {}),
  })
}

function alignmentOf(align: ParagraphStyle['align']) {
  if (align === 'center') return AlignmentType.CENTER
  if (align === 'right') return AlignmentType.RIGHT
  return AlignmentType.JUSTIFIED
}

/** 生成 .docx 的 Blob */
export async function buildDocxBlob(sheet: AnswerSheet, options: DocxExportOptions = {}): Promise<Blob> {
  const keepIndent = options.keepIndent ?? true
  const blocks = options.blocks ?? sheet.blocks
  const children: Paragraph[] = []

  if (options.title && options.title.trim().length > 0) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE_TWIP, lineRule: LineRuleType.EXACT, after: 240 },
        children: textToRuns(options.title.trim(), FONT_TITLE, SIZE_TITLE),
      }),
    )
  }

  blocks.forEach((block, blockIndex) => {
    const paragraphs = splitParagraphs(block.text)
    const styles = block.paragraphStyles
    const hasHeading = styles.some((s) => s.kind === 'title' || s.kind === 'subtitle')

    if (blocks.length > 1) {
      if (blockIndex > 0) {
        children.push(new Paragraph({ spacing: { line: LINE_TWIP, lineRule: LineRuleType.EXACT }, children: [] }))
      }
      children.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { line: LINE_TWIP, lineRule: LineRuleType.EXACT },
          children: textToRuns(`【${block.title}】`, FONT_TITLE, SIZE_BODY),
        }),
      )
    }

    paragraphs.forEach((text, i) => {
      const style: ParagraphStyle = styles[i] ?? { kind: 'normal', align: 'left', indentCells: 0 }
      children.push(styleToDocxParagraph(text, style, { keepIndent, hasHeading }))
    })
  })

  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
  }

  const doc = new Document({
    creator: '申论电脑模拟答题卡',
    description: '由申论方格答题卡导出的纯文本内容（不含答题格）',
    styles: {
      default: {
        document: {
          run: { font: FONT_BODY, size: SIZE_BODY },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertMillimetersToTwip(210),
              height: convertMillimetersToTwip(297),
            },
            margin: {
              top: convertMillimetersToTwip(37),
              bottom: convertMillimetersToTwip(35),
              left: convertMillimetersToTwip(28),
              right: convertMillimetersToTwip(26),
            },
          },
        },
        children,
      },
    ],
  })

  return Packer.toBlob(doc)
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器下载失败
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function exportDocx(sheet: AnswerSheet, options: DocxExportOptions = {}): Promise<void> {
  const blob = await buildDocxBlob(sheet, options)
  downloadBlob(blob, `申论作答-${timestamp()}.docx`)
}

export function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

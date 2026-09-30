/**
 * 构建时把第三方许可证随产物一起发出去。
 *
 * 产物里内嵌了 Noto Serif SC 的子集（SIL OFL 1.1）：
 *   · 普通构建会产出 .ttf，浏览器直接从站点上下载它；
 *   · 单文件版的字体是内联的 data URI，用户会把整个 .html 存到本地。
 *
 * OFL 第 2 条要求再分发时「随附版权声明**和**许可证本身」——
 * 光把 LICENSE / NOTICE 放在仓库根目录不算数：仓库根目录不会跟着产物走，
 * 拿到 dist/ 或那个 .html 的人根本看不到它们。
 *
 * 所以这里在构建收尾时：
 *   1. 把 LICENSE / NOTICE / LICENSES/ 拷进产物目录；
 *   2. 给单文件版在 <!doctype html> 之后插一段注释（它自成一个软件，
 *      除了注释没有别的地方能挂说明，而注释不影响渲染）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const NOTICE_FILES = ['LICENSE', 'NOTICE']
const NOTICE_DIRS = ['LICENSES']

function singleFileNotice(): string {
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf-8').trim()
  const ofl = readFileSync(join(ROOT, 'LICENSES', 'OFL-NotoSerifSC.txt'), 'utf-8').trim()
  return [`<!--`, notice, '', '-'.repeat(74), '', ofl, `-->`].join('\n')
}

export interface BundleLicensesOptions {
  /** 单文件构建：额外把说明以注释形式写进 HTML（它的字体是内联的，注释是唯一挂得住的地方） */
  singleFile?: boolean
}

export function bundleLicenses(options: BundleLicensesOptions = {}): Plugin {
  let outDir = ''
  // 显式传入，不靠 assetsInlineLimit 猜 —— 单文件插件会把它覆盖成 `() => true`，
  // 用那个值判断必然误判成「不是单文件版」。
  const isSingleFile = options.singleFile === true

  return {
    name: 'bundle-licenses',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    // 单文件版：在 HTML 写出**之前**就把说明注进去。
    // 不要放在 closeBundle 里改磁盘上的文件 —— 那样得赌单文件插件写文件的时机，
    // 实测注释会丢。
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!isSingleFile) return html
        const marker = '<!doctype html>'
        return html.includes(marker)
          ? html.replace(marker, `${marker}\n${singleFileNotice()}`)
          : `${singleFileNotice()}\n${html}`
      },
    },
    closeBundle() {
      // 两种产物都要带上许可文件本身（单文件版的字体是内联的，
      // 但用户把整个 .html 存下来时，同目录下的这几个文件是唯一完整的那份说明）
      const dest = resolve(ROOT, outDir)
      if (!existsSync(dest)) return

      for (const file of NOTICE_FILES) {
        const from = join(ROOT, file)
        if (existsSync(from)) copyFileSync(from, join(dest, file))
      }
      for (const dir of NOTICE_DIRS) {
        const from = join(ROOT, dir)
        if (!existsSync(from)) continue
        mkdirSync(join(dest, dir), { recursive: true })
        for (const file of readdirSync(from)) copyFileSync(join(from, file), join(dest, dir, file))
      }
    },
  }
}

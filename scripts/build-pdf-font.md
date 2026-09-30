# 内置 PDF 字体的构建方式

导出 PDF 时必须自带字体：浏览器拿不到系统字体文件，PDF 标准 14 字体里也没有中文。
所以本仓库随包分发一份**字体子集**，导出时整份嵌进 PDF。

- 产物：`src/assets/NotoSerifSC.subset.ttf`（约 2.9MB，7558 个字形，TrueType 轮廓）
- 来源：Noto Serif SC Regular（Google / Adobe，**SIL Open Font License 1.1**，可自由分发）
- 字符集：GB2312 全集（6763 汉字）+ ASCII + 中文标点 + 常用符号（① ㈠ Ⅰ ￥ ℃ 等）
- 覆盖范围清单同步导出在 `src/export/pdfFontCharset.ts`，导出前用它检查作答里有没有冷僻字

## 复现步骤

```bash
# 1. 取字体：必须用 TrueType 轮廓（glyf）的那份
curl -L -o /tmp/NotoSerifSC-VF.ttf \
  "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf"

# 2. 这是可变字体（wght 200~900，默认 ExtraLight），固定到 400 得到静态字重
python3 -m fontTools.varLib.instancer /tmp/NotoSerifSC-VF.ttf wght=400 -o /tmp/NotoSerifSC-400.ttf

# 3. 生成字符集：GB2312 全集 + ASCII + 常用标点符号
python3 - <<'PY'
chars = {chr(i) for i in range(0x20, 0x7f)}
for b1 in range(0xa1, 0xff):
    for b2 in range(0xa1, 0xff):
        try:
            chars.add(bytes([b1, b2]).decode('gb2312'))
        except Exception:
            pass
chars.update('　·—―…⋯‘’“”〔〕【】《》〈〉「」『』（）［］｛｝！？，、；：。％＃＆＊＋－／＝＠｜～￥①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㈠㈡㈢㈣㈤㈥㈦㈧㈨㈩ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ√×÷≈≠≤≥°℃′″￥$€£₩')
open('/tmp/subset-chars.txt', 'w', encoding='utf-8').write(''.join(sorted(chars)))
PY

# 4. 子集化（保持 glyf 轮廓，不要 --desubroutinize，那是给 CFF 用的）
pyftsubset /tmp/NotoSerifSC-400.ttf \
  --text-file=/tmp/subset-chars.txt \
  --output-file=src/assets/NotoSerifSC.subset.ttf \
  --layout-features='' --no-hinting --drop-tables+=DSIG

# 5. 同步字符集模块（src/export/pdfFontCharset.ts）里的 PDF_FONT_CHARSET 字符串
```

换字体（比如换成楷体或黑体）时替换第 1、2 步即可，其余代码不用动。

## 两个必须知道的坑

### 一、必须是 TrueType 轮廓，不能是 CFF（OTF）

`google/fonts` 仓库里这两个文件看着一样，实际不同：

| 文件 | 轮廓 | 结果 |
| --- | --- | --- |
| `Serif/SubsetOTF/SC/NotoSerifSC-Regular.otf` | CFF | pdf-lib 会用错字体子类型，poppler 报 `Mismatch between font type and embedded font file` |
| `ofl/notoserifsc/NotoSerifSC[wght].ttf` | glyf | ✅ 正确 |

### 二、不要用 pdf-lib 的二次子集化（`subset: true`）

pdf-lib 声称能只嵌入用到的字形，但对 CJK 字体不可靠：

- CFF 版本 → 产出**损坏字体**，poppler 直接报 `Embedded font file may be invalid`，阅读器回退到别的字体，**英文和标点就会花**
- TrueType 版本 → 不报错，但**大面积汉字在渲染时消失**

危险的地方在于：**这两种故障都不会影响 PDF 文本抽取**（抽取走 ToUnicode 映射），
`pdftotext` 出来的文字完全正确，只有把 PDF 渲染成图才看得出来。
所以验收 PDF 导出必须**渲染成图看一眼**，不能只看文本抽取：

```bash
pdftoppm -png -r 110 out.pdf render   # 然后肉眼看 render-1.png
```

代码里因此固定用 `subset: false`（整份嵌入）。

## 体积

| 产物 | 大小 |
| --- | --- |
| 随包分发的字体子集 | 2.9MB（只在第一次导出 PDF 时才下载，之后走浏览器缓存） |
| 导出的 PDF | 约 1.8MB（字体是固定成本，正文长度只贡献几 KB；多页也只嵌一次） |

如果哪天要压到几十 KB，需要一个能正确子集化 CJK 的库 ——
`harfbuzzjs` 的 subset 构建（`harfbuzz-subset.wasm`）是正路，但要把 wasm 接进来并处理它的
Emscripten 接口，属于另一件事了。

# 帧编码格式：RGB / YUV / YCbCr

这篇文章只讨论**解码后或送入编码器前的一帧像素如何表示**，不是 H.264、H.265、AV1
这类压缩 codec。项目中的典型链路是：

```text
RGB / Canvas / PixiJS 合成结果
  -> VideoFrame
  -> WebCodecs VideoEncoder
  -> H.264 / AAC MP4
```

而用户导入的视频通常来自另一条链路：

```text
摄像头或剪辑软件
  -> RGB 转 YCbCr
  -> 色度降采样，常见为 4:2:0
  -> H.264 / H.265 / AV1 / VP9 编码
```

核心结论：

- **RGB 更接近显示设备**：R、G、B 三个分量都同时包含亮度和颜色信息，适合屏幕发光、
  Canvas 绘制、UI 合成和逐像素特效。
- **YCbCr 更接近视频编码**：把亮度和色度分开，让亮度完整保存，让色度可以降采样。
- **视频里常说的 YUV 多数是在口语化指 YCbCr**：严格说，YUV 来自模拟电视；数字视频和
  JPEG、H.264、H.265、AV1、VP9 常用的是 YCbCr。
- **4:2:0 先天就比 RGB24 少一半数据**：8-bit RGB24 是 24 bpp，8-bit YCbCr 4:2:0 是
  12 bpp，还没有进入 codec 压缩就已经少存很多颜色细节。

## 1. RGB：给屏幕和绘制管线使用

RGB 把一个像素拆成红、绿、蓝三个通道：

```text
pixel = R + G + B
8-bit RGB = 8 + 8 + 8 = 24 bits per pixel
8-bit RGBA = 8 + 8 + 8 + 8 = 32 bits per pixel
```

RGB 的直觉很强：屏幕子像素就是红、绿、蓝发光；Canvas `ImageData`、WebGL 纹理、
PixiJS 合成、截图比对也经常使用 RGB/RGBA 形态。

但 RGB 的问题是三个通道都混有亮度和颜色信息。人眼对亮度细节更敏感，对颜色细节没那么敏感；
RGB 本身无法自然表达“亮度保留全分辨率，颜色降低分辨率”这个视频压缩前提。

## 2. YCbCr：数字视频里的亮度和色差

YCbCr 把图像拆成一个亮度相关分量和两个色差分量：

| 分量 | 含义 | 直觉理解 |
| --- | --- | --- |
| `Y` | Luma，亮度信号 | 画面明暗和大部分清晰度 |
| `Cb` | Blue-difference Chroma | 蓝色相对亮度的差值 |
| `Cr` | Red-difference Chroma | 红色相对亮度的差值 |

可以粗略理解为：

```text
Y  = 亮度
Cb = Blue minus Luma
Cr = Red minus Luma
```

这里的 `Y` 是 **luma**，不是严格物理亮度。它通常来自经过 gamma / transfer function
处理后的 RGB 信号，再按 BT.601、BT.709、BT.2020 等矩阵转换出来。真实工程里还要同时关心：

- color primaries：色域，例如 BT.709、BT.2020。
- transfer characteristics：传输曲线，例如 SDR gamma、PQ、HLG。
- matrix coefficients：RGB 和 YCbCr 之间怎么换算。
- range：limited range 还是 full range。

这些信息会进入容器元数据、codec 参数或 `VideoFrame.colorSpace`。如果矩阵或范围解释错，
常见结果是画面发灰、过曝、偏色或黑位不对。

## 3. YUV：历史名词和工程口语

严格区分时：

| 名称 | 场景 | 说明 |
| --- | --- | --- |
| `YUV` | 模拟电视 | Y 是亮度，U/V 是两个色度信号 |
| `YCbCr` | 数字视频和图像 | Y 是 luma，Cb/Cr 是蓝色色差和红色色差 |

但在很多 API、像素格式名和工程讨论中，`YUV420`、`YUV422`、`YUV444` 会被直接用来描述
数字视频的 YCbCr 采样格式。阅读代码和文档时要看上下文：多数浏览器、FFmpeg、播放器和硬件
解码器讨论的“YUV”实际是在说数字 YCbCr 像素数据。

## 4. 色度降采样：4:4:4 / 4:2:2 / 4:2:0

色度降采样的目标是：**Y 保留完整分辨率，Cb/Cr 降低采样密度**。这样清晰度主要由亮度保证，
颜色细节少存一些，人眼通常不容易察觉。

| 采样 | Y 分辨率 | Cb/Cr 分辨率 | 8-bit bpp | 常见用途 |
| --- | --- | --- | ---: | --- |
| `4:4:4` | 全分辨率 | 水平/垂直都全分辨率 | 24 | 高质量中间格式、专业后期、屏幕内容 |
| `4:2:2` | 全分辨率 | 水平减半、垂直不减 | 16 | 广播、采集卡、部分专业编码 |
| `4:2:0` | 全分辨率 | 水平减半、垂直减半 | 12 | H.264/H.265/AV1/VP9 的常见分发格式 |

以 2×2 像素块为例：

```text
RGB24:
4 个像素 * (R8 + G8 + B8) = 4 * 24 = 96 bits

YCbCr 4:2:0:
4 个 Y 样本 + 1 个 Cb 样本 + 1 个 Cr 样本
= 4 * 8 + 1 * 8 + 1 * 8 = 48 bits
= 平均 12 bits per pixel
```

所以 8-bit RGB24 和 8-bit YCbCr 4:2:0 的基础数据量是：

```text
RGB24      = 24 bpp
YCbCr420  = 12 bpp
```

还没开始 H.264、H.265 或 AV1 压缩，4:2:0 已经省了一半数据量。视频编码器后续再利用时间预测、
运动补偿、变换量化、熵编码继续压缩。

## 5. 平面格式：I420、NV12、RGBA

采样比例说明“每个分量存多少”，平面格式说明“这些分量在内存里怎么排”。

| 格式 | 类型 | 内存直觉 | 说明 |
| --- | --- | --- | --- |
| `RGBA` | packed RGB | `R G B A R G B A ...` | 适合 Canvas/WebGL/PixiJS 上传和读回 |
| `I420` | planar 4:2:0 | `YYYY... UUUU... VVVV...` | 也常叫 YUV420p，三块平面分开存 |
| `NV12` | semi-planar 4:2:0 | `YYYY... UVUV...` | 硬件解码器和系统视频管线常见 |
| `I422` | planar 4:2:2 | `YYYY... U... V...` | 色度只做水平降采样 |
| `I444` | planar 4:4:4 | `YYYY... U... V...` | 不做色度降采样 |

WebCodecs 的 `VideoFrame.format` 可能暴露 `"I420"`、`"NV12"`、`"RGBA"` 等值。项目不把这些
帧对象塞进 Redux；`VideoFrame` 只在 Worker、预览和导出运行时流转，用完必须关闭。

## 6. 为什么视频编码通常不是 RGB

主流视频编码通常选择：

```text
RGB
  -> 转成 YCbCr
  -> 色度降采样，常见 4:2:0
  -> codec 编码压缩
  -> 容器 mux 成 MP4/WebM
```

原因有三类：

1. 人眼模型：亮度更敏感，颜色细节可以少存。
2. 码率收益：8-bit 4:2:0 是 12 bpp，比 RGB24 的 24 bpp 少一半基础数据。
3. 标准生态：H.264、H.265/HEVC、AV1、VP9、硬件解码器、摄像头、播放器和显示管线长期围绕
   YCbCr 4:2:0 做优化。

RGB 仍然很重要。编辑器做文字、滤镜、合成、截图、Canvas 或 WebGL 绘制时，RGB/RGBA 更自然；
但最终进入视频分发编码时，通常会回到 YCbCr 4:2:0。

## 7. 和本项目的关系

本项目的实践边界是：

- 导入探测只保存容器、轨道、codec、关键帧和尺寸等 JSON 元数据。
- 预览 Worker 从 MP4 demux 出 sample，再通过 WebCodecs/Mediabunny 得到 `VideoFrame`。
- PixiJS/Canvas 负责把 `VideoFrame`、文字、滤镜和变换合成到画布。
- 导出时把合成帧交给 `VideoEncoder`，浏览器按 H.264 配置完成编码，再由 Mediabunny mux 回 MP4。

因此文档里看到的 `VideoFrame` 是“运行时帧对象”，它可能背后是 YCbCr 硬件帧，也可能在渲染时
被转换为 RGB/RGBA 纹理。项目代码不依赖手写 RGB 和 YCbCr 转换矩阵，而是把 codec 和系统色彩
转换交给浏览器媒体栈。

## 源码证据

- VideoFrame 字段和生命周期：[Mediabunny 与 WebCodecs 数据流](/pipeline/mediabunny-webcodecs#videoframe-数据格式)
- Preview Worker 解码帧：[apps/editor/src/preview/preview.worker.ts](/source/apps/editor/src/preview/preview.worker.ts.txt)
- PixiJS 渲染 VideoFrame：[packages/preview-runtime/src/pixi-renderer.ts](/source/packages/preview-runtime/src/pixi-renderer.ts.txt)
- 导出 VideoEncoder 配置：[apps/editor/src/export/export-pipeline.ts](/source/apps/editor/src/export/export-pipeline.ts.txt)

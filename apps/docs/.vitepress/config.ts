import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    base: process.env.VITEPRESS_BASE ?? "/",
    lang: "zh-CN",
    title: "浏览器音视频编辑学习 Demo",
    description: "从真实源码、测试和日志理解浏览器视频编辑器",
    lastUpdated: true,
    mermaid: {
      theme: "dark",
    },
    cleanUrls: true,
    themeConfig: {
      nav: [
        { text: "快速开始", link: "/" },
        { text: "架构", link: "/architecture/overview" },
        { text: "媒体管线", link: "/pipeline/media" },
        { text: "实验与验证", link: "/experiments/assets" },
      ],
      sidebar: [
        {
          text: "开始",
          items: [
            { text: "快速开始", link: "/" },
            { text: "功能导览与目录", link: "/guide/tour" },
            { text: "浏览器能力检测", link: "/capabilities" },
          ],
        },
        {
          text: "状态与架构",
          items: [
            { text: "总体架构与线程", link: "/architecture/overview" },
            {
              text: "Project / Redux / Command / Undo",
              link: "/architecture/project-state",
            },
            {
              text: "多轨道编辑",
              link: "/architecture/multitrack-editing",
            },
            { text: "MobX 隔离对照", link: "/architecture/mobx" },
            { text: "ECS 与 PixiJS", link: "/architecture/ecs-pixi" },
          ],
        },
        {
          text: "调度与数据",
          items: [
            { text: "RxJS Seek / Export", link: "/pipeline/rxjs" },
            { text: "Worker 协议生命周期", link: "/pipeline/worker" },
            { text: "二进制与共享内存", link: "/internals/binary" },
            { text: "Rust WASM ABI 实测", link: "/internals/wasm" },
          ],
        },
        {
          text: "媒体管线",
          items: [
            { text: "Demux / Decode / Encode / Mux", link: "/pipeline/media" },
            {
              text: "Mediabunny 与 WebCodecs 数据流",
              link: "/pipeline/mediabunny-webcodecs",
            },
            {
              text: "预览 Worker 解码链路",
              link: "/pipeline/preview-worker-decode",
            },
            {
              text: "帧编码格式 RGB / YUV / YCbCr",
              link: "/pipeline/frame-formats",
            },
            {
              text: "MP4 文件格式详解",
              link: "/pipeline/mp4-format",
            },
            { text: "代理 / OPFS / 缩略图 / 波形", link: "/pipeline/proxy" },
            {
              text: "长视频 Proxy 性能策略",
              link: "/pipeline/long-video-proxy",
            },
            {
              text: "预处理为什么让预览流畅",
              link: "/pipeline/preprocess-smooth-preview",
            },
            { text: "音频主时钟同步", link: "/pipeline/av-sync" },
            { text: "原素材高质量导出", link: "/pipeline/export" },
          ],
        },
        {
          text: "观测与验证",
          items: [
            { text: "统一日志与 requestId", link: "/observability/logging" },
            { text: "三个素材逐步实验", link: "/experiments/assets" },
            { text: "自动测试、性能与内存", link: "/testing/verification" },
            { text: "兼容性与故障排查", link: "/troubleshooting" },
            { text: "参考实践与边界", link: "/references/boundaries" },
          ],
        },
      ],
      search: {
        provider: "local",
      },
      socialLinks: [],
    },
  }),
);

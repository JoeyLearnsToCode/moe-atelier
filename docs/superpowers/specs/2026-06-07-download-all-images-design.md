# 下载全部图片 - 设计文档

日期：2026-06-07
项目：萌图工坊 (moe-atelier)

## 目标

在 Header 添加一个「下载全部」按钮，一键打包下载全部生成图（任务结果 + 收纳盒中的生成图），不下载上传参考图，最终以 zip 文件下载到本地。

## 范围

### 包含

- 任务结果图：**任务下方结果区的画廊**（`taskState.generatedImages`，每张已生成图片的历史记录），**不是顶部的并发卡片**（`taskState.results`）
- 收纳盒生成图：`collectedItems` 中既非 `collection:upload:*` 也非 `collection:result:*` 之外的项（实际上看 `isUploadCollectionKey`）

### 排除（明确不下载）

- 收纳盒中的上传参考图（`isUploadCollectionKey(item.id) || isUploadCollectionKey(item.localKey)` 为 true）
- 任务顶部的并发卡片（`taskState.results`）—— 这些只是当前运行槽位，不算"已生成的图"
- 没有 `localKey` 也没有可用 `sourceUrl` 的项
- 已经在任务生成图中下载过的 localKey（去重）

## 架构

### 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `package.json` | 修改 | 新增 `jszip` 依赖 |
| `src/utils/batchDownload.ts` | 新增 | 批量下载核心逻辑 |
| `src/App.tsx` | 修改 | Header 添加按钮 + handler |

### 流程

```
[点击按钮]
   ↓
[收集可下载图]
   ├─ 遍历 tasks → loadTaskState → 收集 results 中 success 的 localKey
   └─ 遍历 collectedItems → 收集非上传的 localKey（去重）
   ↓
[逐图获取 Blob]
   ├─ IndexedDB 读 localKey
   ├─ 失败则 fetch sourceUrl（http/https/data:）
   └─ 失败则跳过 + warn
   ↓
[按时间倒序排序]
   ↓
[JSZip.addFile + 命名]
   ↓
[zip.generateAsync({ type: 'blob' })]
   ↓
[触发 <a download> 下载]
   ↓
[message 反馈结果]
```

## 数据契约

### 输入

```typescript
interface BatchDownloadOptions {
  tasks: TaskConfig[];           // App.tsx 的 tasks
  collectedItems: CollectionItem[]; // App.tsx 的 collectedItems
  onProgress?: (current: number, total: number) => void;
}

interface DownloadResult {
  success: number;
  failed: number;
  total: number;
  zipBlob?: Blob;
  errors: string[];
}
```

### 命名规则

- 内部文件名：`{timestamp}_{source}_{idx}.{ext}`
  - `timestamp`: 13 位毫秒时间戳
  - `source`: `task-{id前6位}` 或 `collection`
  - `idx`: 同 source 内的顺序号（从 1 开始）
  - `ext`: 从 blob.type 推断（png/jpg/webp/gif），默认 png
- 排序：timestamp 倒序
- 例子：
  ```
  1717800000000_task-abc123_1.png
  1717795000000_task-abc123_2.webp
  1717790000000_collection_1.png
  ```
- zip 文件名：`moe-atelier-images-{YYYYMMDD-HHmmss}.zip`

## UI 行为

### 按钮位置

Header 中，位于「广场」和「系统配置」之间。icon = `DownloadOutlined`。

### 状态

| 状态 | 条件 | UI |
|---|---|---|
| 空闲 | 无下载中 | 文本「下载全部」 |
| Loading | 正在收集/打包 | 文本「打包中 N/M」+ Spin 图标 |
| Disabled | 0 张可下载图 | 灰色，Tooltip「暂无可下载图片」 |
| 完成 | 全部完成 | 恢复空闲，message 提示 |
| 部分失败 | 部分图失败 | 恢复空闲，warning 提示 |
| 全失败 | 全部失败 | 恢复空闲，error 提示 |

### 反馈文案

- 成功：`已下载 N 张图片`
- 部分失败：`已下载 N 张，M 张失败`
- 全失败：`打包失败：{error}`
- 0 张：按钮 disabled（不显示 toast）

## 错误处理

| 错误源 | 处理 |
|---|---|
| IndexedDB 读失败 | 回退 fetch sourceUrl |
| fetch 失败 | 跳过该图，记录到 errors，不中断 |
| 单图 sourceUrl 缺失 | 跳过该图 |
| jszip 生成失败 | 全批失败，message.error |
| 0 张可下载 | 按钮 disabled，不调用 handler |

## 测试要点

| 场景 | 期望 |
|---|---|
| 0 张可下载 | 按钮 disabled |
| 1 张任务结果 | 成功，zip 含 1 个文件 |
| 1 张收纳盒生成图 | 成功，zip 含 1 个文件，source=collection |
| 任务+收纳盒同 localKey | 去重为 1 个文件，source=task |
| 收纳盒含上传参考图 | 不下载 |
| 任务含 error 状态 | 不下载 |
| IndexedDB 缺 + sourceUrl 可用 | 走 fetch 兜底 |
| IndexedDB 缺 + sourceUrl 也无 | 跳过该图 |
| 大量图（>50） | 一次性打包成功 |

## 兼容性

- 前端模式（默认）：完整支持
- 后端模式：图片仍在 IndexedDB 缓存中（`persistImageLocally` 总是会写），无需服务端改动

## 不在范围

- 任务提示词文件（prompts.txt）：本期不做
- 上传参考图打包选项：本期不做
- 进度条：本期用按钮文本 + message 简单反馈
- 后端打包流式下载：本期不做

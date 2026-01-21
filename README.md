<div align="center">
  <h1>Head CTA 病例筛选与浏览（本地）</h1>
  <p>🧠🩻 快速浏览 · ✅ 勾选标注 · 📊 分类统计</p>
  <p>
    <img alt="Python" src="https://img.shields.io/badge/Python-3.9%2B-3776AB?logo=python&logoColor=white" />
    <img alt="Flask" src="https://img.shields.io/badge/Flask-API-000000?logo=flask&logoColor=white" />
    <img alt="Pandas" src="https://img.shields.io/badge/Pandas-Data-150458?logo=pandas&logoColor=white" />
  </p>
</div>

一个轻量的本地 Web 小工具：从 Excel 中读取病例列表与分组信息，按条码号匹配本地 `Head_Stroke` 目录中的 `CTA.nii.gz`，支持快速浏览切片、窗位窗宽调整、勾选标注与统计。

> 适合部署在内网/服务器上，通过浏览器远程访问（无账号系统、无权限控制，默认仅建议在可信网络中使用）。

## ✨ 功能

- **按大类筛选病例**：从 `Head/数据_筛选结果.xlsx` 的 `all_with_labels` 表读取 `条码号` 与 `cta_category`
- **条码号匹配影像目录**：匹配 `Head_Stroke/<条码号>/`（大小写不敏感），自动列出其中 `CTA*.nii.gz`
- **切片浏览 + 窗位窗宽**：支持 `x/y/z` 三个方向切片、`wc/ww` 窗位窗宽
- **勾选标注**：勾选状态保存到 `Head/labels/labels.json`
- **统计**：按 `cta_category` 统计“已勾/总数”，并在下拉框中展示
- **性能优化**：后端切片 PNG 有内存缓存；前端会预取临近切片

## 📁 目录结构

```text
Head/
  backend/               # Flask 后端 + NIfTI 最小读取器
  frontend/              # 纯静态前端（index.html/app.js/style.css）
  labels/labels.json     # 勾选结果（自动生成/更新）
  数据_筛选结果.xlsx       # 病例表（Excel）
Head_Stroke/
  <条码号>/
    CTA*.nii.gz
```

## 🧰 环境依赖

- Python 3（建议 3.9+）
- 主要依赖：Flask、pandas、numpy、Pillow

> 当前工程为了便于在“无法联网安装依赖”的环境中运行，未使用 nibabel；后端内置最小 NIfTI（`.nii/.nii.gz`）读取器，支持常见 datatype。

## 🚀 快速开始

在服务器上执行：

```bash
cd /home/Head
python3 backend/app.py
```

浏览器打开（默认端口 `5008`，可用 `PORT` 覆盖）：

```text
http://<服务器IP>:5008/
```

## 🕹️ 使用说明（快捷键/交互）

- **空格**：切换“勾选”
- **← / →**：上一例 / 下一例（跳转前自动保存勾选状态）
- **滚轮**：切片滚动（更快）；**Shift + 滚轮** 平移
- **Ctrl/⌘ + 滚轮（触控板捏合）**：以鼠标位置缩放
- 右上角按钮：适应 / 1:1 / 缩放

## ⚙️ 配置（环境变量）

后端（`backend/app.py`）支持：

- `PORT`：监听端口（默认 `5008`）
- `DEBUG`：是否开启 Flask debug（默认关闭；可设 `DEBUG=1`）
- `SLICE_CACHE_MAX`：后端切片 PNG 缓存条目数（默认 `256`）
- `SLICE_ALLOW_DOWNSAMPLE`：是否允许按查询参数 `max` 下采样切片（默认关闭，保证清晰度；设 `1` 可启用“低清预览”）

## 🔌 API（简要）

- `GET /api/meta`：总数/分类列表
- `GET /api/stats`：按大类统计“已勾/总数”
- `GET /api/cases?category=...&barcode=...`：病例列表（包含 has_cta/checked）
- `GET /api/case/<barcode>`：单例详情（含默认文件/体信息/勾选时间）
- `POST /api/case/<barcode>/label`：保存勾选 `{checked: true|false}`
- `GET /api/case/<barcode>/volume_info?file=...`：体数据 shape/dtype 等
- `GET /api/case/<barcode>/slice?file=...&axis=z&index=...&wc=...&ww=...`：返回 PNG

## 🙋 常见问题

### 1) 页面空白/打不开

先看后端启动日志。默认已关闭 debug；如需调试可临时使用：

```bash
DEBUG=1 python3 backend/app.py
```

### 2) 找不到病例文件夹

确认 `Head_Stroke/<条码号>/` 是否存在（条码号不区分大小写），并且目录下存在 `CTA*.nii.gz`。

### 3) 图像不清晰

默认后端不会下采样（即使前端请求里带了 `max`），保证清晰度。如果你手动开启了 `SLICE_ALLOW_DOWNSAMPLE=1`，可能会看到“低清预览”。

# 来源与许可

本项目代码采用 GPL-3.0-only。下列上游内容保留原作者署名与原许可；根目录 GPL 不替代它们的许可。

## 原版动画与养成模块

- 项目：https://github.com/touche-s/rice-loving-whale
- 固定版本：`cd1a4c24f6432ba86324aadf3da0d09bd73904be`
- Copyright (c) 2026 deepseek-maid-whale-desktop-pet contributors
- MIT，全文见 `licenses/rice-loving-whale-MIT.txt`。
- `assets/rice/*.gif` 和 `assets/icon.png` 来自上游 `electron/assets/`，未修改。
- `vendor/nurture.cjs` 来自上游 `electron/nurture.js`，只改文件扩展名。
- `assets/rice-rendered/*.webp` 是上述 GIF 的处理副本：保留原始透明度，移除孤立的细边框残留，按固定人物比例和锚点映射到 300×300 透明画布；保留全部动画帧和每帧时长。站立互动共用倍率，其他姿势单独校准。处理脚本为 `scripts/assets/prepare-rice.py`，继续保留 MIT 署名。
- `src/domain/behavior.cjs` 的互动时序、随机表情和吃饭停留时间参考原版 `electron/renderer.js`，并增加多聊天任务恢复与逐步入睡。
- 本项目复用养成模块，独立实现 Mac 窗口、动画播放器与 Codex 事件桥；未移植 DSH 聊天、密钥管理、计费或整个控制面板。

## dsh-pet 小节目动画

- 作者及来源：https://github.com/PC2005-cloud/dsh-pet
- 固定提交：`e17e89be92aaa7b71c4f3e9e89995a23a781d725`
- 来源：上游 `dsh-pet/assets/webm/`，本地 `assets/dsh/`；下列视频均为原文件，未修改：

  | 上游文件 | 本地文件 |
  |---|---|
  | 舞狮头.webm | lion-dance.webm |
  | 蓝鲸现世.webm | blue-whale.webm |
  | 可爱宅舞.webm | cute-dance.webm |
  | 轻快摇摆舞.webm | sway-dance.webm |
  | 抽陀螺.webm | spinning-top.webm |
  | 玩游戏气急败坏.webm | gamer-rage.webm |
  | 撸猫.webm | pet-cat.webm |
  | 放烟花.webm | fireworks.webm |

- 动画素材允许开源使用、禁止商用；衍生作品在介绍、展示、分发时须附原作者仓库地址。上游 README 的许可原文保存在 `licenses/dsh-pet-ASSET-NOTICE.md`。
- 运行时仅调整显示比例和位置。这些动画不按根目录 GPL 或 rice 素材的 MIT 许可重新授权；包含这些动画的分发包须保留上述限制和署名。

本项目是非官方同人作品，与 DeepSeek、OpenAI 及其他品牌没有授权、赞助或背书关系。商标归各自权利人所有。

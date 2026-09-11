# JavDB 万能磁链提取器

Tampermonkey 油猴脚本，一键批量提取 JavDB 磁力链接，支持多模式、多标签排队与备用域名自动切换。

## 功能

- **三种抓取模式**
  - 当前列表：按页面位置 0~20 + 起始页码（默认第1页）
  - 按番号段：前缀 + 数字范围
  - 女优/组合：女优名 + 类型/标签 + 页码范围 + 抓取顺序
- **磁链优选**：优先字幕版（字幕/-C./中文），同组内体积最小，去重后导出迅雷专用 TXT
- **过滤**：自动跳过 VR 分类、时长 >150分钟、单磁链 >10GB
- **稳定**：429 限流重试、2秒页内间隔、多标签排队锁（localStorage）
- **域名高可用**：
  - 每 6 小时自动从 javdb.com / t.me/s/javdbnews / 官方App 同步最新 javdbNNN.com
  - 双写缓存 GM_*/localStorage，封禁时优先用缓存，实时多源兜底，递减备用列表
  - 面板仅显示 最新域名: javdb575.com (来源 · Xh前)
- **面板**：可拖动，显示状态/进度/日志，支持停止

## 安装

Tampermonkey → 打开以下任一链接 → 安装

- https://raw.githubusercontent.com/lijianbin2/javdb/main/javdb_scraper.user.js
- https://github.com/lijianbin2/javdb/raw/refs/heads/main/javdb_scraper.user.js

本地：`H:\Codex\javdb脚本\javdb_scraper.user.js` 拖入扩展管理

脚本头已配置 @updateURL / @downloadURL，Tampermonkey 会自动检测更新（当前 v5.12.4）。

## 使用

1. 打开任意 javdb*.com 列表/搜索页
2. 右下角面板选择模式、填写范围/页码
3. 开始抓取 → 完成后自动下载 xxx_迅雷专用.txt

## 备用域名说明

官方获取方式（无审查直接访问 javdb.com）：
1. 安装官方 App，通过“关于”查看最新网址
2. 关注 Telegram @javdbnews
3. 使用代理访问 javdb.com 查看首页公告

脚本已自动化以上三源同步，无需手动。

## 许可

MIT

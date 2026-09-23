# JavDB 万能磁链提取器

Tampermonkey 油猴脚本，一键批量提取 JavDB 磁力链接，支持多模式、多标签排队与备用域名自动切换。

## 功能

- 三种抓取模式：当前列表按位置 0~20 加起始页码，番号段按前缀加数字范围，女优组合按名称加类型标签加页码范围
- 磁链优选：优先字幕版，同组内体积最小，去重后导出迅雷专用 TXT
- 过滤：自动跳过 VR 分类、时长超过 150 分钟、单磁链超过 10GB
- 稳定：429 限流指数退避重试，页内 2 秒间隔，多标签排队锁，45 秒锁过期自动回收
- 域名高可用：每 6 小时从 javdb.com、TG 频道、官方 App 同步最新 javdbNNN.com，双写缓存，封禁时兜底
- 自动勾选记住我：登录页自动勾选记住我类选项，抓取运行时自动暂停，避免干扰
- 登录验证码需手动输入，面板可拖动，显示状态进度日志，支持停止

## 安装（推荐 Git 链接）

Tampermonkey 打开以下任一链接即可安装：

https://raw.githubusercontent.com/lijianbin2/javdb/main/javdb_scraper.user.js

https://github.com/lijianbin2/javdb/raw/refs/heads/main/javdb_scraper.user.js

本地安装：把 H:/Codex/javdb脚本/javdb_scraper.user.js 拖入 Tampermonkey 扩展管理页。

脚本头已配置 updateURL 和 downloadURL，Tampermonkey 会自动检测更新，当前 v5.13.65。

## 使用

1. 打开任意 javdb 列表或搜索页
2. 右下角面板选择模式，填写范围或页码
3. 开始抓取，完成后自动下载迅雷专用 TXT

## 近期审查优化

- v5.13.60 域名多源分批并发，16 候选分 4 批并行
- v5.13.61 域名状态栏相同内容不再重复写 DOM
- v5.13.62 切回可见标签页 60 秒内只刷 UI 不重复同步
- v5.13.63 排队等待改 500ms 分片，可中断并带锁心跳
- v5.13.64 锁心跳写节流 5 秒，减少本地存储写入
- v5.13.65 日志每 20 条修剪一次，最多保留约 400 行

## 备用域名说明

官方获取方式：装官方 App 看关于页，关注 TG 频道，用代理看 javdb.com 首页公告，脚本已自动同步，无需手动。

## 许可

MIT


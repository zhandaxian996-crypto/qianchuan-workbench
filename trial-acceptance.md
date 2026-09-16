# 私有试用包验收报告

- 包名：qianchuan-private-trial-2026-09-14-v3-readonly-r7
- 交付对象：这是由源项目生成的包副本；所有安全改写仅作用于包副本，不代表源项目生产行为已改变。
- 用途：客户 Agent 本地环境检查、空账户接入与按需只读验收。
- 试用模式：仅通过启动器、start_server.cmd 或已改写为同一启动器的 npm start 启动；固定关闭后台任务和投放写入。
- 配置：仅含通用 config.example.json；未复制 config.json、Cookie、数据库、历史、日志或缓存。
- 依赖：未打入 node_modules；解压后在 server-app 目录执行 npm install。
- 包内组件：HTTP 服务、stdio MCP、V4 工作台与静态资源已纳入，用于本轮有限只读验证。
- 未纳入：探针、测试、调试、浏览器辅助脚本、旧后台脚本输出；research 运行源码按固定清单纳入。
- 验收边界：持续后台采集、夜间任务、自动通知、投放写入、长期盯盘和客户专用策略不在本包验收范围；本地打包验收不等于客户机验收，且不发起真实上游请求。
- 构建器拒绝已有输出目录，避免脏文件混入；ZIP 生成前阻断未判定私密命中。
- 已执行：包内 JavaScript 相对导入闭包检查（185 个文件）、隔离 --check --json、HTTP /health/live、非法账户拒绝、写接口只读拒绝、MCP tools/list（22 个工具）与 setup_account status。
- 依赖说明：验证复用了本工作区已安装依赖，没有在全新客户机执行 npm install；客户机仍需安装并复验。

## 缺失但源码引用的资料

- references/discipline.md
- references/账号特征词表.md

## 脱敏扫描（只记录文件名和类别）

- references/data/district-tree.json | platform_geography_constant | allowed_platform_constant
- server-app/server/lib/browser.js | reviewed_platform_or_numeric_constant | allowed_platform_constant
- server-app/server/lib/qianchuanTabs.js | reviewed_platform_or_numeric_constant | allowed_platform_constant
- server-app/server/routes/campaignOps.js | reviewed_platform_or_numeric_constant | allowed_platform_constant
- server-app/server/routes/homeSplit.js | reviewed_platform_or_numeric_constant | allowed_platform_constant

## 客户 Agent 运行步骤

1. 解压包并进入 server-app。
2. 运行 npm install。
3. 从 config.example.json 复制 config.json，按 AGENT_START.md 在本机完成账户接入。
4. 在包根目录运行 node server-app/scripts/start-workbench.js --check --json。
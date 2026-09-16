# 退役 MHS 实现

2026-09-06：事后评分、动作胜率与自动成功经验也退出生产链路。`decisionReview.js`、`ruleStats.js`、`evaluateDecisions.js`、`extractLessons.js` 仅保留原算法供隔离测试和历史审计；它们不代表现行决策标准，不得导入服务。原 `scripts/evaluate_decisions.js` 现在只连接同场前后事实，原经验提取和胜率入口无副作用返回退役结果。旧生成文件原址保留，但不再通过经验查询提供给 Agent。

这里的评分卡和版本管理实现仅用于离线审计与旧公式测试，不注册为 HTTP 路由，不作为 Agent 的盯盘资料。

- `materialScorecards.js`：原 `server/routes/materialScorecards.js`。
- `mhsVersions.js`：原 `server/routes/mhsVersions.js`。
- 旧入口统一由 `server/routes/retiredMhs.js` 返回不可重试的退役回执。

`server/lib/mhs.js` 同时包含历史公式和 `pendingOps` 在用的参数、聚合及删除复核护栏，因此保留原址；评分函数不再进入在线座舱和夜间调度。`server/lib/mhsV3.js` 仅由离线回测和测试使用。历史库、版本文件和报告未删除。需要恢复线上评分时必须重新经过明确需求和验收，不能仅激活一个旧参数版本。

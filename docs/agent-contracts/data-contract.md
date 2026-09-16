> 交付版说明：本包仅支持只读接入和按需分析。下文的其他执行模式、写入或持续任务是完整项目的技术参考，不代表本包启用；能力以实际 MCP Schema、服务端限制和 [知识接入](../../AGENT_KNOWLEDGE.md) 为准。

# 千川 MCP 决策数据契约

本文件属于 `qianchuan-api` 技术文档，只解释 Agent 决策需要的机器字段语义。字段是否存在、参数如何提交，始终以当前 MCP Schema 和实际返回为准；平台官方定义另由 `qianchuan-ops` 核验。

2026-09-06：MHS 综合评分退出在线链路。`live-cockpit` 版本为 `2.2-evidence`，素材仅返回实际指标、样本、窗口、质量和覆盖，不返回 `mhs/confidence/tier/recommended_action/mhs_v3_shadow`；`agent-round-view` 不再取评分卡或返回 `mhs`。旧评分卡及版本入口返回 `410 / mhs_retired`，属于功能退役，不是数据服务故障。预测影子工具、流速拆分、任务限制与决策留痕保留。素材盘中表新增可空的 `net_roi_1h` 保存平台累计原值，旧行不回填复算值；当日素材差分不能冒充本场归因。

2026-09-06：事后评分、胜率和自动成功经验已退役。`outcome` 仅返回同场前后事实与证据缺失原因，不输出分数或因果判断；旧数据不改写。`get_my_scores` 已移除。自动经验查询返回 `decision_scoring_retired` 不属于服务故障。写后 `operation_id/effect_status/readback` 验真保持不变。

2026-09-06维护：本地历史导出通过 [offline-report-v1](offline-reports.md) 独立入库、按账户/报表/粒度查询；不覆盖实时数据。历史replay不再自动混入当前或近30天追投任务，本场任务归因缺失明确返回，独立历史须显式请求 `include_boost_history`。采集器与MCP文本中的未知直播状态均保留未知，不能报未开播。

追投整单调参回执增加 `readback.preservation`：未请求修改的预算、适用出价、模式和定向分别标 `unchanged/changed/unknown`，后两者不报confirmed；缺真实定向不自动补成不限地区。此检查尚不涵盖完整素材成员，相关上线限制见 [当前试用边界](../../AGENT_KNOWLEDGE.md)。主计划及追投各自冷却、权限、单变量和操作编号要求不变。

## 1. 财务口径

ROI 只允许使用以下机器可读口径：

| `roi_basis` | 含义 | 使用边界 |
|---|---|---|
| `payment` | 支付成交金额 ÷ 消耗 | 不能替代退款后或最终结算结果 |
| `platform_net_1h` | 平台剔除支付后 1 小时内退款后的净成交 ÷ 消耗 | 仍不是最终结算；1 小时后的退款尚未反映 |
| `final_settlement` | 明确最终结算窗口后的结算金额 ÷ 消耗 | 必须同时返回结算窗口和完成状态 |
| `chengfang_comprehensive` | 乘方综合收益/成本契约下的综合 ROI | 不与支付、1 小时净或最终结算 ROI 横比 |
| `unknown` | 当前接口无法确认真实口径 | 只能展示为未知；阻断 ROI 创建或修改 |

- 每个 ROI/GMV 必须附 `roi_basis`、`settlement_window`、`source_at` 和有效性。只有同账户、同场次、同窗口、同口径才可比较。
- `netGmv/netRoi/roiSettle` 是兼容字段，不根据名字推断语义。若接口标注其真实口径为 `platform_net_1h`，报告必须写“平台 1 小时净 GMV/ROI”，禁止写“最终结算”。
- `roi` 也必须服从返回的 `roi_basis`，不能仅凭旧命名猜成支付口径。
- Profile 保本线、当前计划目标与观测 ROI 必须同口径；需要换算时只展示可审计的桥接计算，不把换算值伪装成原始字段。
- `roi_basis=unknown`、用户提交口径与计划元数据不一致，或计划元数据无法识别时，ROI 写入分别以 `roi_basis_required` / `roi_basis_mismatch` 阻断。查询、详情、回读和满足自身护栏的暂停不因此被禁止。
- `spend/cost` 失败或缺失时必须为 `null`，不能补成 0。真实 0 只有在对应 `dataValid:true` 时成立。
- 平台已返回的累计 ROI 直接使用，不用金额÷消耗复算、替换或因不闭合置空；金额/消耗缺失也不抹去已返回的 ROI。ROI 本身缺失才留 `null`，真实 `0` 保留。summary 2.1 的 `financial_checks` 只保留原值、`value_source=upstream`、口径、窗口及字段有效性，不再返回 `derived_value`。口径未知或标错单独提示，不能串用支付与净口径。区间边际 ROI 是另一个衍生指标，不替代平台累计 ROI。
- 追投报表 `gmv` 为含券支付金额，`paymentGmv` 为不含券支付金额，`netGmv/settleAmount` 为平台 1 小时净成交金额；以 `metric_sources` 原始字段名追溯，不含券支付不等于净成交。

## 2. 时间与场次

- `generated_at`：服务组装响应的时间，不代表数据来源时间。
- `source_at` / `fetchedAt` / `liveCheckedAt`：上游或采集器实际取数时间。
- `age_ms` / `freshness` / `stale`：数据年龄与新鲜度。
- `session_key`：由 `accountId|roomId|startTime` 隔离的直播场次键。
- `snapshot_id`：供下一轮差分、决策留痕和后验绑定的服务端快照 ID。

同房间重新开播且 `startTime` 变化时必须进入新场。停播、陈旧或场次不明时不得继承上一场金额、订单或素材结论。

summary 2.1 的 `components` 分别标注 `live/financial/boosts/funnel/channels/short_term_tools` 的来源时间、窗口、年龄和有效性。响应时间不能刷新缓存时间；顶层 fresh 不代表所有组件 fresh。`live.is_live=null` 表示未知，不代表下播；旧的 true/false 也必须结合直播组件有效性使用。

### 核心指标快刷（2026-09-07）

在播核心指标每 10 秒独立采集，复用 `commonMetricCard` 和账户限流队列；完整大屏仍每 30 秒采集。作战室每 5 秒读取核心内存态，趋势和素材分别独立轮询。采集周期不是延迟保证：上游耗时、排队和限流仍会影响实际年龄。

- `live-dashboard.component_times` 分列核心、趋势、漏斗、渠道和三类素材模块的 `source_at/collected_at/window/dataValid`。核心 `fetchedAt` 不再使用整套模块完成时间，缓存命中也重算 `age_ms`。
- `timestamp_basis=request_started_at` 表示来源时间取请求发起点（保守包含排队耗时）；`collected_at` 为该模块返回时刻。平台未返回内部更新时间，不能声称读到了平台生成时间。MCP 的 `components.financial` 同时透出这些证据。
- 核心超过 30 秒未更新时，作战室标记延迟，API 标记 `data_stale`。成功收到旧缓存不刷新来源时间；直播状态、追投、漏斗和罗盘不借用核心时间盖章。
- 核心快读不含追投累计，`basicCost/assistCost=null`；不能用新总消耗减旧追投累计。15m 总／基础／追投流速继续读取原有独立窗口采样，不因快读而伪造拆分。
- 本次只改变读取与展示。ROI 保留平台原值；限流、写权限、调控冷却和投放规则不变。未重启服务前，不能把新采集周期视为已上线。

任务的 `daily_metrics`（今日）或 `period_metrics`（指定日期范围）与 `session_metrics` 分列。当前没有可靠的任务级本场成交归因，`session_metrics` 明确为不可用、指标为 `null`；不得扣减日累计回流数据伪造本场成交。预算进度携带范围：日期范围消耗÷预算不等于任务生命周期余额，`budget_remaining=null` 表示尚未取得累计余量，不可据此判断预算充足。

## 3. 漏斗与渠道

精简盘面的 `funnel` 结构化返回 `counts.shows/views/product_clicks/pay_orders` 与四个转化率 `rates.show_to_watch/watch_to_click/watch_to_pay/click_to_pay`，同时携带窗口、`source_at` 和 `data_valid/data_quality`（上游原始字段可为 `dataValid`）。Agent 不从缺失数反推；分母为 0 时转化率为 `null`，不是 0。

实时 `funnel` 与 Profile `funnel_baseline.stages.*.value` 的转化率统一按百分比 `0..100` 表示，例如 `12.5` 表示 `12.5%`，不得再除以或乘以 100。

诊断顺序固定为：

```text
付费进入 → 停留 → 商品点击 → 支付 → 退款/结算
```

`channels` 逐渠道分开提供原始渠道标识、看播人数 `watch_count`、成交人数 `pay_count`、成交金额 `pay_amount` 及可用占比，并携带 `window/source_at/data_valid/data_quality/baseline`。`pay_share_pct` 只表示成交人数占比；金额占比使用 `pay_amount_share_pct`。上游只有成交金额时，`pay_count/pay_share_pct` 必须为 `null`，不得用金额或订单金额反推出人数。接口不知道渠道含义时返回 `unknown`；Agent 不把未知渠道自行命名为 Feed、自然流或泛流量。渠道占比变化但可用效率正常时只记录结构变化，不自动收量。

详细断点、责任域和岗位映射读取当前账户工作区的方法卡，技术接口不自行制定经营策略。

## 4. 完整性与错误

- `dataValid=false`：核心数值不能用于决策。
- `partial=true`：主数据可用，但至少一个子项失败；必须读取 `errors[]`。
- `cookie_expired`：登录状态故障，停止写操作并请用户更新 Cookie。
- `rate_limited` / 429：上游限流，按服务契约退避，不重启 HTTP。
- `upstream_locked` / 423：上游锁定，读取锁状态，不重复强冲。
- `db_busy` / 503：数据库快速失败，下一轮重试，不把空值当成功。
- `timeout` / 504：请求有限失败；先区分 MCP、HTTP 和上游层。

MCP 失败必须表现为 `isError:true` 或结构化 `ok:false`。HTTP 200、空对象和旧缓存都不能推断为成功。

## 5. 实时边际

流速名称必须带明确口径：

- **15m总投放流速 / 小时流速**：`marginal.m15.spend_rate_hour`，近15分钟整体消耗（基础消耗+追投消耗）折算为每小时；前后端与 Agent 调控默认都使用它。它描述直播间总投放输入，不等于主计划单独流速。
- **15m基础流速**：`ΔbasicCost / 实际分钟 × 60`，用于判断主计划获量与 ROI 调控。
- **15m追投总流速**：`ΔassistCost / 实际分钟 × 60`，只描述所有追投的合计输入；每条追投还要按任务累计消耗差分单独计算流速和边际结果。
- **5m即时流速**：`marginal.m5.spend_rate_hour`，只用于尽早发现突变，不单独触发主计划 ROI 写入。
- **30m确认流速**：`marginal.m30.spend_rate_hour`，与15m窗口共同确认方向和持续性。
- **整场均速**：`session_average_flow = 本场累计消耗 / 已播真实分钟 × 60`，只用于目标进度、复盘和解释，不作为主计划调控主口径。

如果调用方没有传 `minutes`，`get_marginal_slice` 默认返回15m总投放流速。返回的 `flow_contract` 与 `flow_role` 是机器可读契约；不得把5m、15m和整场均速都简称为“当前流速”。

每轮使用真实时间跨度计算：

```text
区间消耗 = 当前消耗 - 前快照消耗
区间同口径GMV = 当前同口径GMV - 前快照同口径GMV
区间订单 = 当前订单 - 前快照订单
边际ROI = 区间同口径GMV / 区间消耗
流速 = 区间消耗 / 实际分钟数 × 60
```

区间消耗为 0 时，边际 ROI 记为不可计算而不是 0。实际 7 分钟跨度不能标成 5 分钟；前后快照 `roi_basis` 不同则整个差分无效。

## 6. 素材与计划对象

- 素材操作必须使用真实 `material_id`；动态创意开关、集合行和聚合项不是普通素材。
- 主计划、追投和素材指标必须标明同场/历史、时间窗口、来源与当前状态。
- 创建任务返回 ID 不等于已经生效；必须回读状态或实际消耗。
- `manage_boost` 的列表、详情和回读必须返回目标 ROI 口径；创建/修改时需与真实计划元数据核对。口径未知或冲突时阻断 ROI 参数，不猜测。
- 用户手动暂停、关闭或修改的对象不得被自动恢复。

任务列表与详情保留真实 `bid`（元/单）、`bid_mode`、`status_code`、`pause_reason`、`passive_stop`、`available_actions` 和 `action_limits`，不从任务名推导出价。局部列表无法证明未返回的任务不存在。

### 6.1 写前限制与回执

- 预算、出价、定向沿用本地同账户同对象每小时 3 次调参限制；查询、建议、失败、暂停、恢复不计。ROI 保持独立 30 分钟冷却，主计划与各追投按自己的对象计时。已接受但尚未确认的调参保守保留额度，避免重复写入。
- `action_limits` 是本地规则，返回计次与否、剩余次数、原因及精确解锁时间；`available_actions` 合并已知平台阻断和人工保护。`allowed=null` 表示仍需写前核验，不等于允许。服务端在同账户同对象锁内再次检查，读取不是预先授权。
- 单次写入返回 `operation_id/before/requested/actual/effect_status/readback/next_allowed_at/action_limits/timings`。只有请求字段与真实回读一致才是 `confirmed`；查到对象不等于改参生效。`unchanged` 表示没有发写请求，不创建操作编号。
- 上游接受但回读失败、超时或仍是旧值，标 `unconfirmed` 并保留真实编号；只读查证，不自动重新提交。MCP 保留同一回执，`record_watch_round` 从日志绑定，未确认操作不标为已核验动作。
- `timings` 区分请求总耗时、可测上游耗时、回读和重试；底层未提供的阶段为 `null`，不是 0。请求总耗时可能包含排队和写前取数。
- 一键控量区分已有活动任务、平台禁止创建与原因未知。当前 `stop_supported=false/can_end_early=false`：停止端点未接通，平台显示可结束也不代表本工具能撤销。

### 6.2 增量读取

完整 summary 的基线正文只在 `decision_context` 保留一份，以 `context_version` 引用。增量仅在版本变化时带正文。`live/components/plan/boosts` 等安全状态在 delta 中按完整字段替换，包含任务参数、限制和控量状态；支付指标也参与差分。所有返回的活动/受阻任务都保留，不截取前 10 条；上游不完整由 `boost_coverage.truncated` 声明。

告警按内容、对象及证据去重，读取 `alert_id`；用 `cleared_alert_ids` 移除已解除的告警，不能按相同 code 删除其他对象。2.1 快照指纹包含状态和证据，纯状态变化也产生新 ID，台账保存对应证据。旧版本或跨场次增量自动回退完整 summary。

素材处置纪律不属于 API 契约，读取当前账户工作区的方法卡与账户策略。

### 6.3 追投与本轮素材变化

`boosts` 的逐任务事实优先来自追投报表和任务列表：任务 ID、真实出价/模式、预算原始值、任务自身效果、素材关联、状态/停止原因、来源时间和可执行动作分别保留。预算周期枚举不作为对外字段；平台没有返回可核验进度时保持缺失，需要定点补读时通过 `supplement` 指明对象和缺口。任务列表不完整时，缺失任务只记为 `not_returned_not_proof_of_end`，不能判定已结束。

`material_changes` 是可选的精简投影，包含视频、直播间画面和其他已识别类型。`top` 默认只展示近期有效窗口消耗靠前对象，`exceptions` 保留增耗/增单变化、对象告警和待确认对象，`not_observed` 保留跌出采集页或尚未采到的对象；直播间画面是投放对象，不等于直播间总汇总。每条记录都带 `scope`、`query_window`、`source_at`、`data_valid`、`missing_fields`、追投关联和模块覆盖说明。前10只限制主展示，不代表只采集了前10；`coverage` 必须说明模块总消耗、已观察消耗和榜外缺口。

本轮差分只在同场、同筛选口径、可比来源时间且前后快照有效时生成。缺失不补零，退款/回补保留原始负值并标记修订，差分只描述观察到的变化，不宣称素材带来的因果增量。历史缓存需要先经历同场新快照预热；旧缓存缺少模块来源时间或筛选指纹时只能展示累计事实，窗口变化标为不可用。该投影复用现有采集结果，不新增一套大屏请求。

## 7. 扩量稀释 Shadow

盯盘 Agent 使用只读 MCP 工具 `get_expansion_dilution_shadow(account_id)` 读取当前场次信号。该工具直接复用 `get_live_cockpit.expansion_dilution_shadow`，不另行计算，结构化结果至少包含：

- `status/state/risk_level`：预测器可用状态、风险形态与等级；
- `signals`：前后 15 分钟同口径窗口、流速变化与 ROI 保留率；
- `attribution`：基础计划、追投、混合或未知责任域；
- `route_candidates`：后续应深读的对象和前置条件，不是执行指令；
- `evidence_ref`：本轮前向留证状态与编号。

`UNAVAILABLE/BASELINE/PROFIT_ARMED/HEALTHY_EXPANSION/DILUTION_WARNING/DILUTION_RISK_HIGH/DILUTION_MATERIALIZED` 是当前合法状态。不可用时必须原样报告服务端原因，禁止调用方补值或本地重算。

该信号固定为 `shadow_only:true`、`actionable:false`。它只能追加诊断和路由责任域，不能证明平台主观“注水”，也不能单独授权一键控量、主计划 ROI 或追投写操作。实际动作仍须读取账户策略，并通过数据、口径、对象、冷却、单变量、可回滚和服务端护栏。

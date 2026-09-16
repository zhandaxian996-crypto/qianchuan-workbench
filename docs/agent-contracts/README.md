> 交付版说明：本包仅支持只读接入和按需分析。下文的其他执行模式、写入或持续任务是完整项目的技术参考，不代表本包启用；能力以实际 MCP Schema、服务端限制和 [知识接入](../../AGENT_KNOWLEDGE.md) 为准。

# Agent 与千川 API 技术契约

本目录由 `qianchuan-api` 项目维护，只描述 MCP/API 字段、Profile、账户接入和受控运行边界，不保存账户操盘策略，也不冒充千川官方手册。

- `data-contract.md`：ROI、时间、场次、漏斗、渠道和流速字段语义。
- `effective-delivery.md`：有效投放接口映射及状态解释。
- `account-profile.schema.json`：账户 Profile 结构。
- `onboarding.md`：新账户接入与校准流程。
- `portable-runtime-policy.md`：无账户策略时的技术安全降级。

平台官方规则使用 `qianchuan-ops` Skill 核验；账户阈值和具体动作读取对应 Agent 工作区的现行策略。

- `offline-reports.md`：只读查询与资料缺失边界；本包未提供报表导入脚本。

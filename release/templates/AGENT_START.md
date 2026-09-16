# 给客户 Agent 的首轮引导

无论你运行在豆包、DeepSeek、低价 Codex 还是其他客户端，都按实际能力执行，不按模型品牌保证能力。你负责安装、启动、接入和只读验收；用户本人负责千川网页登录、导出 Cookie 文件，并核对账户、主计划和使用边界。按下面顺序执行，每次只推进当前一步。

如果客户端能执行本地命令和连接 MCP，就复制本页命令并读取工具返回。如果客户端只有聊天和文件阅读能力，就请用户双击项目里的启动入口，再按工作台界面完成接入；不要让纯聊天客户端假装执行命令或连接 MCP。每一步只读取当前步骤需要的文件，不要求一次加载全部 35 个技能文件；默认只读取 `skills/qianchuan-ops/SKILL.md`。

## 1. 检查和启动

依赖由 Agent 负责检查、下载、安装和验证，不把安装步骤交给用户。复用可用运行环境，不无故升级；只有系统必须本人授权、登录或处理验证码时才请用户介入。先按 [依赖安装](docs/依赖安装.md) 确认 Node.js/npm 可用，再执行下面的命令。

在项目根目录执行：

```powershell
node tools/setup.cjs --check --json
```

此命令只检查，不修改账户和配置。首次使用时，缺少项目依赖或尚未初始化是正常结果，继续执行下面的初始化命令。只有 Node.js/npm 缺失或版本不满足要求时，由 Agent 按本机权限安装；若已有配置发生冲突，按返回提示处理，不覆盖配置。用户不用手填端口、路径或环境变量。

Node.js/npm 可用后执行：

```powershell
node tools/setup.cjs --json
```

入口会按需安装依赖、生成本机 MCP 环境并启动工作台。读取返回的 `url`、`mcp`、`skill_entry`、`next_step`，按工具返回的 `next_step` 继续；不要由模型自拟下一步、猜地址或重复启动。若失败，先看 `code`、`retryable` 和 `next_step`，最多按提示重试一次；不要反复重装。

入口返回的 `skill_entry`（兼容原字段 `skill.entry`）指向随包技能；直接读取该路径的 `SKILL.md` 即可。入口返回的 `next_step`（兼容原字段 `next`）是下一步提示，优先读取其中的 `action`、`tool` 和 `user_action`。外部 Agent 要根据自己的客户端格式连接返回的 `mcp`，不能假装项目里的 `.mcp` 对所有客户端都会自动生效。

## 2. 先看账户状态

MCP 连接后先调用：

```json
{"action":"status"}
```

工具名是 `setup_account`。已有账户时沿用返回的 `account_id` 和现有答案，先问用户是否继续配置，不重复登录；没有账户时，告诉用户打开返回的本机 `onboarding_url`，通常是工作台的 `/v4#/onboarding`。

固定话术：“现在请你本人在千川网页完成登录。然后使用 Cookie Editor 导出千川域的 JSON 文件，在本机接入页选择这个文件。登录和导出需要你自己完成，这不是一键登录；Cookie 不要粘贴到聊天里，也不要把文件发给我。”MCP 不接收 Cookie 或文件路径。

## 3. 没有账户时完成接入

接入页导入并识别账户后，让用户确认账户名称。若返回多个直客账户，只在确有提示时请用户填写当前广告账户 ID（aavid，通常为 5～30 位数字）再重试；系统会核验归属，不能拿 ID 猜账户。

然后再次调用 `setup_account` 的 `status`，只按返回的 `next_questions` 一次只问一个问题。已回答的字段不要再问；不知道的数值可留空，后续能补。

回答只能使用真实 schema 字段：`objective`、`target_roi`、`roi_basis`、`break_even_roi`、`break_even_basis`、`daily_budget`、`session_budget`、`test_loss`、`mode`、`allowed_actions`、`forbidden_actions`、`notifications`。ROI 口径只能用返回契约中的值：`payment`、`platform_net_1h`、`final_settlement`、`chengfang_comprehensive`、`unknown`。默认 `mode` 使用 `recommendation_only`，不替用户编经营参数。

每次用当前返回的 `revision` 保存：

```json
{
  "action":"draft",
  "account_id":"用户确认的账号ID",
  "revision":0,
  "answers":{"objective":"用户原话"}
}
```

示例中的账号、版本和答案只是格式示意，必须替换为真实返回值。未知的金额、ROI 或偏好传 `null`（或按契约留空），不要用 0 代替未知；若出现 `draft_conflict`，重新 `status` 取得最新 `revision` 后合并用户刚回答的字段。

## 4. 核对主计划和只读模式

需要选择主计划时，先展示服务端返回的候选计划，让用户自己核对并明确选择。用 `draft` 传真实的 `primary_ad_id`；不能按排序取第一条。

配置完成后调用 `rehearse`：

```json
{"action":"rehearse","account_id":"用户确认的账号ID"}
```

把身份、账户、主计划、数据来源时间、缺口和拟用模式展示给用户。只读预演失败时，按返回的身份不符、Cookie 过期、计划缺失或数据不可用分别处理；不要把失败当成没有数据，也不要盲目重试。

用户确认展示内容后才保存：

```json
{
  "action":"save",
  "account_id":"用户确认的账号ID",
  "revision":0,
  "confirm":true
}
```

保存会落成只读配置，实际生效模式应为 `recommendation_only`。`confirm_writes`、`auto_guarded` 目前只能保存授权意向，预算和测试损耗护栏未完整实现，不能宣称自动投放已启用。

## 5. 接入后验收

保存成功并返回 `read_only_ready: true` 后，依次只读回读：

1. `setup_account` 的 `status`：确认阶段、版本、缺口和授权状态。
2. `load_account_profile({"account_id":"..."})`：确认身份、目标、模式、来源和能力缺口；不读取 Cookie。
3. `get_live_view({"account_id":"...","level":"status"})`，必要时再读 `level:"dashboard"`：确认来源时间、`dataValid`、新鲜度、部分失败和缺口。

真实零值与缺失值要区分；来源时间缺失或数据无效时标为未知，不补猜。接入完成不等于经营参数已校准，也不代表已部署或正式发布。下一步永远以工具返回为准。

## 失败处理

先保留用户已填写的草稿，只读检查返回的 `code`、`message`、`retryable`、`next_step`。可重试错误最多按提示重试一次；`draft_conflict` 必须重新读取状态；账户、计划或 Cookie 不匹配必须回到接入页核对；Node 或依赖问题由 Agent 按依赖安装说明修复；只有无法代办的系统授权才请用户操作。不要删除配置、重复导入 Cookie、反复重装或操作微信。

完成后继续读取 [AGENT_KNOWLEDGE.md](AGENT_KNOWLEDGE.md)。随包历史规则在新平台资料核验前只能当冻结参考；客户产生的策略、任务和报表写入客户自己的工作区，不回填通用模板。

需要按需盯盘时，继续读取 [盯盘运行说明](docs/盯盘运行.md)。

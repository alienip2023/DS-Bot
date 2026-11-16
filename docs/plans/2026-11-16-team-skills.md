# 用户批准的团队技能复用

## 行为

- 保留主机现有 capability library。其他本地 Bot 通过 `list_capabilities` 发现技能，选择 `attach_capability`，由自己的 Agent skills 服务加载正文；群聊同样使用该 Bot 的启用列表。
- 学习审批卡片和 Capabilities 的技能表单新增「团队可复用（包括已连接节点）」选项，默认不选。用户明确选中并批准后，技能标记 `teamReusable`，分配稳定、不含身份信息的 UUID `sharedId`。
- Bot 不能自行授予跨机共享；Bot 改变已共享正文或说明后撤销导出，须由用户重新审阅。用户已批准的学习更新按用户编辑处理，即使其他 Bot 已启用该技能也可更新；普通 Bot 自行改写仍受原有权限限制。远端导入项只在来源主机修改或撤销。
- `node/roster` / `peer/roster` 使用可选的 `skills: {version: 1, items: [{id, name, description, content}]}` 快照。节点上报本机批准项；主控下发本机项及节点导入项，使一个节点的经验可以送到另一个节点。peer roster 的显示开关不代替用户对技能共享的选择。
- 导入的能力名附 UUID 的哈希后缀，以免覆盖同名本地能力。原样快照重复接收不会重复注册；源端快照去掉的技能会移除其导入项、Bot attachment 和 pack 引用。断线时保留最后可用的文本，重连后的快照更新它。

## 边界

- 仅同步用户审阅过的独立技能文本。两端检查密钥样式、已保存密钥、绝对路径、对话记录标记及长度；不用静默删字的方式改变正文。说明至多 300 字符、正文至多 8000 字符、快照至多 64 项及 256 KiB。
- 快照字段按白名单重新组装，不传 env、headers、命令、本机路径、提案理由、会话或 memoryCache。用户仍须审阅技能的含义；模式检查无法判断所有自然语言中的私密事实。
- 不读写任何 memory scope，不改变 `team/group/bot/joined:<node>:<bot>` 权限。私密 Bot 的学习不得授予跨机共享。
- 旧消息没有 skills 时保留已有导入；未知版本、格式错误或不安全快照不应用，原有 roster 继续处理。只有有效 version 1 空快照表示来源撤销。
- 64 项或 256 KiB 上限以外的技能留在来源主机，不自动导出；接收方只将收到的有效快照作为该来源的目录。

## 传输前提与验证

本仓库通过已有 `remote-agent:roster-report`、registry `roster` 和 `remote-agent:peer-roster.onRoster` 服务接入，不修改 DSH 或 remote-agent。跨机使用要求 remote-agent 在这三个边界保留 `skills` 扩展字段。当前任务未提供该插件源码或运行节点，服务边界和 JSON 载荷回放已测试，实际传输兼容性尚待核实；不能将测试替身当成真实双机验收。

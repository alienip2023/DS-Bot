# Bot 协作的 work 模型（重写 W1 起）

- 日期：2026-11-24
- 相关：全面重审 `ds-bot-cluster/REVIEW-2-summary-and-redesign.md`（维护者已拍板：按 OpenMausBot 模型重做；本机与跨机同一套；主控镜像页并入）；详细设计 `ds-bot-cluster/DESIGN-work-model.md`；AC 可靠通道 `dsh-ai-cluster/docs/reliable-link.md`（W0）
- 取代：`2026-11-24-bot-assign.md` 全部；`2026-10-16-bot-handoffs.md` 中"结果作为一条消息投给发问方、每条结果唤醒一次"的部分

## 为什么

R1–R4 之后实机反复出现：回复进了用户排队区、node 间只有单向、回复丢失、一问两答。根因不是某一处 bug，而是本机、bot/assign、bot/turn 三条路各管一段，没有一条记录说清"谁要谁做什么、做到哪了"，结果又被当作普通消息逐条投递，甚至插进对方正在跑的回合。OpenMausBot 的做法是：一件事一条 assignment；交出去的一方等待；结果到齐后在它原来的对话里恢复一次；结果从不插话。

## 模型

- **一种记录：work**（扩展现有 `state.works`）。每一件"谁要谁做事"都是一条 work：Bot 交给 Bot、用户对 Bot 说话后 Bot 交出去的那件事（根 work）、群里点名成员。字段：`from`、`to`、`parent`、`open`（交出去还没读的）、`results`（交回的）、`held`（等待时它已经说的话）、`part`（这件事在哪段对话里做，恢复回到那里）、`origin`（根 work 为 `person`）。
- **发问方：交出 → 等待 → 恢复一次**
  - 回合里 `message_bot` 给另一个 Bot：开一个子 work，挂在本回合在做的 work 下面；本回合若是用户发起、本身没有 work，就先为这个回合开一个**根 work**（`origin: 'person'`，`part` 为这段对话）。工具立刻返回回执，告诉 Bot"都交出去后结束本回合，交回的东西会一起回到你这里"。
  - 回合结束：还有没交回的 → 这件 work 进入等待（状态行"在等 X"），回合说的话存为 `held`，不往上交。
  - 子 work 交回：写进父 work 的 `results`，**不投递任何消息**。父 work 交出去的全部交回后，框架在父 work 所在的那段对话里发起**一个**恢复回合：一条 `role: 'results'` 的 Bot 消息（`kind: 'bot'`，界面显示为"收到交回的结果：X、Y"一行，可打开对话记录），带上所有交回的结果，每个结果只出现一次。只在那段对话空闲时进（每 Bot 一槽的闸门），从不 steer，也不进用户排队区。
  - 恢复回合结束：又交出了新的 → 再等待；否则这件 work 完成。根 work 完成时，这段对话里用户看到的回答就是答复，不再额外投递；非根 work 的答复照旧交给发问方（W3 起跨机同样只写记录）。
  - 结果从不插进正在跑的回合（撤回 fork.114 的"回复 steer 进当前回合"）。
  - **维护者 2026-11-25 修订（fork.124）**：交出这件事的那一轮如果还在跑（Bot 交出去后继续做别的、sleep、等后台任务），交回的结果一到就 steer 进这一轮，下一步就读到；以前要等这一轮结束，实测晚 2 分 40 秒。仍是一条 `role: 'results'` 消息、只读一次（`work.resume` 直到其中每个结果被读才清，回合结束不再续跑；读到的是根 work 自己的结果，不算"别的 work"，不再延后重发）。steer 时这一轮恰好已结束，就照常在对话空闲时续跑。
  - 用户可以"不再等"某个交出去的事（含根 work 下的），它以"用户放弃等待"作为结果，同样走一次恢复。
- **没有自动超时**。删除 25 分钟提醒 / 30 分钟超时（违背 `2026-10-16-bot-handoffs.md`"不做自动超时"）。对方在等用户批准、对方机器离线，这边就一直等；状态里看得到在等谁。
- **收件方（W2）**：每对（发问方 Bot + 它的那段对话，收件 Bot）一条固定工作线程，标题"@发问方 · 工作"，同一对的后续 work 都进这个线程，上下文连续。
- **跨机（W3）**：work 帧 `work/handoff|status|result|cancel` 经 AC 可靠通道；对方地址存在 work 里；离线挂起不计时；取消级联。删除 `bot/message`、`bot/assign`、Bot 间用途的 `bot/turn`。
- **主控显示（W4）**：用户在主控对节点 Bot 说话就是一件 work；主控读节点上的对话（`bot/history` 增量 + 推送），不再另写镜像 Session。

## 本次（W1）落地

- 根 work；等待；交回只写记录；全部交回后在原对话恢复一次；`role: 'results'` 消息与界面一行；"不再等"走同一恢复。
- 删除 25/30 分钟定时器与 `DELEGATE_*` 常量；撤回 `delivery.js` 的 `answerNow` steer。
- 本机之外的交回（bot/assign、joined bot/turn、群聊、后台任务、subagent）仍按各自原来的消息唤醒；它们读完后，同一 work 的本机结果在回合结束时一起恢复。W3 把跨机的改到同一条路上。

## 测试

协作测试用会话事件驱动真实回合（`turn/start → user/message → assistant/message → turn/end`），不手工调用 `closeWork` 假装答完；每条规则配反向验证（撤掉实现，对应测试必须失败）。

## W2 落地：固定工作线程

- **载体是后台任务**（`2026-11-16-async-work.md` 的 `bot.tasks[]`），不是用户建的 Thread：后台任务已经接好会话归属、换段、重启对账、审批冒泡和任务界面；用户建的 Thread 的回合 DS Bot 不路由。新任务来源 `origin: 'bot-work'`，记 `workFor: { botId, part }`（发问方 Bot 和它那段对话：主对话、某个后台任务或某条工作线程），标题"@发问方 · 工作"。
- **取代"遇忙直开后台任务"**：别的 Bot 的 `message_bot` 请求（交给本机 Bot、要回给发问方的）不再进收件 Bot 的主对话，也不再一件一个后台任务，而是进这对的工作线程；没有就开一条（从收件 Bot 前台最近完成的轮次分出，和原来一样）。`reply_to: "user"` 仍进主对话（用户要在那里看）。
- **一件做完不结束**：线程回到 `standing`（待命）状态，下一件同一对的 work 进同一会话。待命线程仍归属这个 Bot（审批、权限、换段照常），但不算"在忙"：任务条和计数不显示它，任务列表里显示"待命"。失败或被打断时发问方照常收到说明，线程回到待命；用户停掉线程（task_stop / 停止按钮）它才结束，下一件再开新的。重启时待命线程原样保留。
- **同一对正在做时再来**：线程里正在跑这对的回合，就 steer 进去（补充给那件 work，`when: "queue"` 除外）；这是唯一允许的 steer。
- **上限**：每个 Bot 最多 10 条待命/在做的工作线程；再开新的时，结束最久没用、空闲、没有在等结果的那条；都在忙就照开。

## W3 落地：跨机器的 work

- **一条路**：交给别的机器上的 Bot（节点上的 peer 行、主控上的 joined 影子）的 `message_bot`，和交给本机 Bot 一样开一个子 work（挂在本回合的 work 或根 work 下），再发一个 `work/handoff` 帧；对方机器把它当本机的请求放进这对的工作线程（W2），做完发回 `work/result`；这边按 work id 把结果写进那件 work，全部回来后续跑一次（W1）。结果从不作为消息投递、从不 steer。
- **帧**（走 AC 可靠通道 `docs/reliable-link.md`，恰好处理一次；节点之间经主控存转）：
  - `work/handoff { id, from, to, part, text }`：`from`/`to` 是全队通用的 Bot 引用（主控 Bot 用自己的 id，节点 Bot 用 `joined:<节点>:<本地 id>`）；`part` 是发问方那段对话的稳定名字，收件方据此选工作线程。
  - `work/status { id, status }`：收件方收下后回 `queued`，发问方据此在两人的对话记录里标"已送达"。
  - `work/result { id, outcome, text }`：`outcome` 为 `done` / `failed` / `stopped`。
  - `work/cancel { id }`：用户在发问方放弃等待时发出；收件方停下那件 work 的回合（只认它登记过的 work）、不再回答。
  - `team/pair { from, to, id, role, text, replyTo? }`：节点之间的一来一回同时抄给主控一份，只写进主控上两人的对话记录（主控是用户看全队的地方）。
- **身份**：发送方是链路给出的事实（`from` 的机器必须等于帧实际来自的机器），不信帧里自称；收件方找不到发问方的替身行时不收（不 ack，稍后重发，等目录到了再处理）。
- **离线**：对方机器不在时帧留在可靠通道（主控存转），不计任何时钟；回来立刻送。
- **删除**：`bot-assign.js`（`bot/assign` 发件箱、`assignInbound`、`assignRounds`、主控转发记录）、`bot/message`（`sendToPeer`、节点 `onMessage`、主控 `handleNodeMessage` 的 ask/reply）、`message_bot` 对 joined 影子走 `bot/turn` 的路。
- **暂不动（后续阶段）**：主控页面对节点 Bot 说话（W4 改成 work）、群聊里有节点成员时的 `bot/turn`、`team/act` 管理 RPC、AC 里 `bot/assign` / `bot/message` 帧本身（ds-bot 不再用，W5 清理）。

## W4 落地：主控上节点 Bot 的页面是它对话的副本

- **维护者 2026-11-25 选定"副本 Session"**（取代上文"不在主控另写镜像 Session"的写法）：主控上节点 Bot 的页面仍是一段 DSH Session（客户端不用改），但只有一个写入者——节点把这个 Bot 自己对话里真实发生的事件（`turn/start`、`step/start`、用户消息、带思考与工具调用的回答、`tool/call`、`tool/result`、`step/end`、`turn/end`）按顺序经可靠通道发来（`team/conv`），主控原样抄进页面。主控不再自己编造回合。
- **单一写入者**：节点 Bot 的页面 Session 的 `append` 被把住，只有副本写入者能写；以前的写入者（页面回合的开头与结果、插话回合、迟到回复、排队失败说明、`bot/trace` 步骤、`bot/stream` 预览、节点任务报告、打开页面时的历史导入）一律不再写进去（代码在 W5 删除）。
- **回合编号**：节点每段会话的回合号各自从 1 起；主控按到达顺序给页面分配自己的回合号，并记下对应关系（`state.replicas`，随 state.json 落盘，重启后按 `(会话, seq)` 去重）。
- **用户的消息**：主控页面上输入的消息仍经原来的路送到节点（排队 / 插话 / 附件 / 停止都不变），节点把它放进 Bot 自己的对话；页面上看到的是节点那条消息的副本（带上页面的 requestId，输入框的回显照常收起）。
- **运行中**：副本回合开着时页面显示运行中、有停止按钮。
- **工作线程也抄一份**（fork.119）：节点 Bot 的工作线程与后台任务（群聊的除外）同样按 `team/conv` 发来，帧里带 `task { id, title, origin }`；主控为每个任务建一段只读副本 Session（`state.replicas[bot].tasks[taskId]`），不写进 Bot 的主页面。主控在该 Bot 的任务列表里列出它（工作线程两件 work 之间显示「待命」），点开读的就是副本。所以节点之间的请求在主控上看得到：收件 Bot 在「@发问方 · 工作」线程里，发问方页面上是「已给 X 发消息」，点开是两人的对话记录。
- **surface 标记**：DSH 要求 `system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result` 写入时带 `surfaceOp`；副本写入者对这五种都带 `append`（fork.118 漏了 `tool/result`，页面上的 `message_bot` 因此显示成失败）。
- **页面永远能打开**（fork.120）：DSH 要求一步里每个工具调用在 `step/end` 前都有结果，否则整段 Session 无法加载。副本写入者在写 `step/end` / `turn/end`（含新回合开始时补关上一回合）前，给本步还没有结果的调用补一条「结果没有抄到主控」的 `tool/result`（没有 `tool/call` 的先补 `tool/call`）；仍开着的步先关上。工作线程副本不写 `system/message` 开头（DSH 只在回合内存得下它，存不下时整段都不落盘）；fork.119 建的副本（`v` 不为 2）重建。
- **不再自动重建页面**：roster 报告不再触发 `migrateLegacyJoined`（把节点历史导成新页面并换掉页面 Session，与"页面就是副本、已有内容保留"冲突，且节点历史里有未答回合时每 5 秒重试）；需要时显式调用（`rt.autoMigrateJoined` 打开旧行为）。
- **看得见**（fork.121）：副本不带节点的 inbox 事件，DSH 把 Bot 发来的消息算作 context（ds-bot 不画），所以交回与请求要走 relay 行：`role: 'results'` 也算 relay，画成「交回结果：X」并在下面显示交回的内容（长的可展开），本机页面（turn-trigger）同一组件。主控写副本时把消息来源里的节点本地 id（`senderSessionId`、`resultFrom`；`peer:<hub>:<home>:<id>` 或节点本地 Bot id）换成主控上的 id。侧栏 Bot 展开后列出它的工作线程（本机的与节点副本），点开在任务阅读器里看。
- **收件方对话里的一行**（fork.122）：收件 Bot 的主对话按时间在两轮之间（最后一轮之后也算）显示它这段时间处理过的工作线程：「处理了交来的工作：X」/「正在处理交来的工作：X」，点开在任务阅读器里看那条线程（`WorkTurnTail`，按线程的 `updatedAt` 落在哪两轮之间）。维护者 2026-11-25 定：发问方页面的交回行只显示交回方名字（fork.121 下面显示的内容去掉），点名字打开两人的往来记录。
- **停止级联与防循环**（fork.125，对齐 OpenMausBot）：用户停止一回合（`aborted/user`，或跨机 `work/cancel` 的 `ds-bot/cancelled`）时，这回合在做的 work 交出去的全部子 work 一起停：本机停正在做的回合并从工作线程收件箱撤下未开始的请求，跨机发 `work/cancel`，收件方 `onCancel` 再往下级联；停掉的 id 记在 `state.stoppedWorks`（保留 24 小时），其回答不再投递。只在等待、没有回合在跑的 Bot 上按停止，同样停掉它这段对话的根 work。DSH 关机（`aborted/disposed`）不算停止。`work/handoff` 带 `chain`（等在上面的 Bot 的全队引用，根在前，至多 16 个）：发送方 `upstreamOf` 把链也算作上游，拒绝交回；经手超过 `WORK_DEPTH_MAX`（4）拒绝；接收方再查一遍（目标在链上或链太长 → 立即 `work/result failed`）。
- **队列与交回可靠性**（fork.126）：队列释放下一件改为 `setImmediate`（期间把 Bot 占住，不让别的插队），不在 DSH 记录 `turn/end` 的过程中写入；续跑消息用 `deliver({ untilSent: true })`，排队后没送出会让调用方得知并重试；启动时对 `work.resume` 已设、对话里却没有那条 `role: 'results'` 消息的 work 清掉标记重新续跑。用户停止一回合时，也停掉这段对话里所有还在等的根 work（`stopWaitingIn`）。
- **不带过去的**：图片、文件块换成一行文字；超长文本截断并注明；`assistant/message` 的流式片段不带（页面按步更新，不逐字）。已经在主控上的旧页面内容保留，W4 之后只增加副本。

## W5 落地：清理（2026-11-25）

- **删掉的写入者**：主控页面回合、插话回合不再写页面（`executor.js` 只剩控制：一 Bot 一条在途、插话位、排队、停止、卸载）；删除迟到回复、排队失败说明、`deliverTurn`、`writeNodeReport`、`hub-stream.js`、节点任务报告（`reportTaskToHub` / `handleNodeReport` / `remote-agent:bot-message`）、主控对"主控答不了的节点卡片"的提示、`spawnBotHandoffTask`，以及 `mirror.js` 里不再有人用的函数。节点不再发 `bot/stream`。
- **失败怎么让人知道**：页面不再写"⚠ 无法送达节点"。消息发不出去，或节点在收到后马上拒收（1.5 秒内），由输入框 / `sendUser` 的调用方报错；IM、手机同理。
- **同一条消息不发两次**：重发的 requestId 若正在发往节点（在途或插话中）即视为已收下，不再排队重发。
- **AC**：删除 `bot/assign`、`bot/stream` 帧与 `bot-stream/1` 能力；`bot/message` 仍在 AC 里，节点之间直连（peer-direct）还用它，与 peer 认证一起处理。
- **仍保留**：群聊里有节点成员时仍走 `bot/turn`，主控照旧把节点的思考步骤（`bot/trace`，`hub-trace.js`）写进群聊的会话。
- **后续（原计划里尚未做的）**：发问方对话里每件交出去的事一行实时状态、点开看对方工作线程的只读视图、全队「协作记录」；防重复（同一目标短时间重复交办）、对方反问（needs_input）、受保护会话（带定时任务的会话不作工作线程）、peer 认证与 `bot/message` 退场；节点卡片（主控答不了的）在主控上的提示；群聊里"没有收到思考过程"提示的写法。

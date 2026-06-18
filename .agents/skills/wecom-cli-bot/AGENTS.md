# 企业微信 CLI 机器人技能

本目录包含 `wecom-cli-bot` 技能，是仓库中该技能的唯一维护副本。

## 用途

创建或扩展 Docker 优先的企业微信智能机器人桥接项目。当前生成的项目将企业微信长连接消息桥接到 Kiro CLI；其他 CLI 仅作为未来 adapter 扩展方向。

## 生成内容

模板生成 Node.js + TypeScript 工作进程，使用 `@wecom/aibot-node-sdk`。每个 Bot 作为独立进程运行，拥有独立工作空间：

```text
bots/<bot-name>/workspace/
  private/       # 私有：.env、配置、soul、历史、日志
  cli-home/      # CLI 专用主目录/配置/缓存
  instructions/  # 无密钥的 CLI 指令
  files/         # CLI 工作目录
```

运行时支持：

- 企业微信长连接和流式回复
- 每个 Bot/用户一个活跃任务
- `/stop` 取消任务
- 3 小时空闲会话过期
- 斜杠指令：`/history` `/new` `/open N` `/name`
- 管理员认领、初始化锁和管理员转移
- Kiro host auth 只读挂载
- 共享 memory namespace 和共享文档目录
- 用户隔离的会话管理
- JSONL 历史记录
- 密钥脱敏和 ANSI 清理
- Docker Compose 持久化部署

## 维护规则

- 仅修改 `.agents/skills/wecom-cli-bot` 路径下的内容。
- `SKILL.md` 保持简洁，详细内容放在 `references/`。
- 模板文件放在 `assets/wecom-cli-bots-template/`。
- 不存储真实凭证，`.env.example` 仅保留占位符。
- 优先 Docker 模式验证。

## 默认配置

- 默认项目路径：`./wecom-cli-bots`
- 当前 CLI：`kiro-cli`
- Kiro CLI 安装：`curl -fsSL https://cli.kiro.dev/install | bash`
- 管理员认领：`npm run admin:claim -- --bot <bot-name>`
- 停止指令：`/stop`
- 会话空闲过期：3 小时
- 部署方式：Docker Compose + `restart: unless-stopped`

## 验证

修改技能后执行：

```bash
python3 /Users/dujiepeng/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/dujiepeng/Project/AI/my-agent-toolkit/.agents/skills/wecom-cli-bot
```

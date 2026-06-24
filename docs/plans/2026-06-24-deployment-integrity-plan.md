# 本地部署可信性实施计划

## 目标

让本地 Docker 联调具备版本可见性和强制重建校验能力，避免旧容器被误当成最新代码。

## 任务

### Task 1: 为核心服务健康接口增加版本字段

修改：

- `services/control-api/src/server.ts`
- `services/bot-host/src/server.ts`
- `services/bot-host/src/wecomWorkerMain.ts`
- `services/data-service/src/server.ts`
- `services/llm-runner/src/server.ts`
- `services/capability-runner/src/server.ts`
- 对应测试文件

要求：

- `/health` 返回 `git_sha`、`build_time`
- 默认值为 `unknown`

### Task 2: 注入构建元数据

修改：

- 相关 `Dockerfile`
- `deploy/compose/docker-compose.yml`

要求：

- 支持 `BUILD_SHA`
- 支持 `BUILD_TIME`

### Task 3: 新增强制重建与校验脚本

新增：

- `scripts/dev-redeploy.sh`

要求：

- 构建失败立即退出
- 成功后 `up -d --force-recreate`
- 校验 `/health.git_sha == HEAD`

### Task 4: 更新文档并验证

修改：

- `README.md`
- `deploy/compose/README.md`

验证：

- 相关测试通过
- `pnpm run typecheck`
- `git diff --check`

# {{JIRA_KEY}} 测试用例清单

## 状态说明

- `待评审`: 已设计，等待用户 review，不能开始代码实现。
- `待实现`: 用户已 review 通过，尚未实现自动化代码。
- `已实现`: 对应自动化代码已落地，但尚未完成真实环境验证。
- `已通过`: 真实环境执行通过，case 标题前使用 `[x]`。
- `未通过`: 真实环境执行未通过，需要记录失败原因，case 标题前保持 `[ ]`。
- `跳过`: 因环境、依赖或明确不测范围跳过，case 标题前保持 `[ ]`。

## 用例列表

### [ ] {{JIRA_KEY}}-TC-001 | 待评审 | P0 | {{CASE_SCENARIO}}

- 前置条件:
  - {{CASE_PRECONDITION}}
- 操作步骤:
  1. {{CASE_STEP_1}}
  2. {{CASE_STEP_2}}
- 请求内容:

```http
{{HTTP_METHOD}} {{API_PATH}}
Authorization: {{TOKEN_TYPE}}
Content-Type: application/json

{{REQUEST_BODY_JSON}}
```

- 预期结果:

```json
{
  "http_status": {{EXPECTED_HTTP_STATUS}},
  "response_assertions": [
    "{{EXPECTED_RESPONSE_ASSERTION}}"
  ]
}
```

- 执行结果:
  - 待执行。生成代码前必须由用户 review 并确认本文件。

## Review 记录

- 生成时间: {{GENERATED_AT}}
- Review 状态: 待用户 review
- Review 结论: 待填写
- 硬性要求: 用户确认前不得生成或修改自动化代码；如果用户后续修改本文件，必须重新生成或更新对应自动化代码。

## 执行汇总

- 执行命令: 待执行
- 目标环境: 待执行
- 总数: 待执行
- 已通过: 待执行
- 未通过: 待执行
- 跳过: 待执行
- 备注: 测试完成后的执行文档必须从本文件状态汇总生成。

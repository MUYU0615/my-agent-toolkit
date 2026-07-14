import { describe, expect, it } from "vitest";
import {
  presentRuntimeOutput,
  stripRuntimeControlSequences,
} from "./runtimeOutput.js";

describe("runtime output presentation", () => {
  it("removes ANSI control sequences without removing assistant text", () => {
    expect(stripRuntimeControlSequences("\u001b[m> \u001b[0m正常回复")).toBe("正常回复");
  });

  it("hides Kiro shell traces and preserves the final Chinese answer", () => {
    const presentation = presentRuntimeOutput([
      "I will run the following command: [PATH] --root HIM-22356 (using tool: shell)",
      "Purpose: Run easemob-jira-testcase for HIM-22356",
      "Traceback (most recent call last):",
      'File "[PATH]", line 117, in load_config',
      "jira_login_probe.LoginError: Jira credentials are not bound for the current WeCom user and Bot.",
      "- Completed in 2.945s",
      "Jira 凭证未绑定。当前 WeCom 用户和 Bot 缺少 Jira 登录凭证。",
      "请在企业微信中发送 /jira bind 绑定 Jira 账号后重试。",
    ].join("\n"));

    expect(presentation.visibleText).toBe([
      "Jira 凭证未绑定。当前 WeCom 用户和 Bot 缺少 Jira 登录凭证。",
      "请在企业微信中发送 /jira bind 绑定 Jira 账号后重试。",
    ].join("\n"));
    expect(presentation.diagnosticText).toContain("Traceback");
    expect(presentation.diagnosticInProgress).toBe(false);
  });

  it("keeps an unfinished tool block out of intermediate stream updates", () => {
    const presentation = presentRuntimeOutput([
      "正在准备 Jira 分析。",
      "I will run the following command: ./scripts/run.sh --root HIM-22356",
      "Purpose: Analyze Jira",
      "partial command output",
    ].join("\n"));

    expect(presentation.visibleText).toBe("正在准备 Jira 分析。");
    expect(presentation.diagnosticInProgress).toBe(true);
  });

  it("hides Kiro batch file-read operation traces", () => {
    const presentation = presentRuntimeOutput([
      "Batch fs_read operation with 2 operations (using tool: read)↱ Operation 1: Reading file: [PATH], all lines",
      "⋮",
      "- Completed in 0.0s",
      "↱ Operation 2: Reading file: [PATH], all lines",
      "✓ Successfully read 3379 bytes from [PATH]",
      "✓ Successfully read 158 bytes from [PATH]",
      "⦁Summary: 2 operations processed, 2 successful, 0 failed",
      "# HIM-22356 测试用例草稿",
      "",
      "## TC-001 默认下载源下载",
    ].join("\n"));

    expect(presentation.visibleText).toBe([
      "# HIM-22356 测试用例草稿",
      "",
      "## TC-001 默认下载源下载",
    ].join("\n"));
    expect(presentation.diagnosticText).toContain("Operation 2");
    expect(presentation.diagnosticText).toContain("Successfully read 3379 bytes");
    expect(presentation.diagnosticText).toContain("Summary: 2 operations processed");
  });

  it("maps a diagnostic-only missing credential failure to Chinese", () => {
    const presentation = presentRuntimeOutput([
      "Traceback (most recent call last):",
      'File "[PATH]", line 117, in load_config',
      "jira_login_probe.LoginError: Missing EASEMOB_JIRA_USERNAME or EASEMOB_JIRA_PASSWORD.",
    ].join("\n"));

    expect(presentation.visibleText).toContain("/jira bind");
  });

  it("does not alter ordinary mixed-language assistant output", () => {
    const output = "接口 POST /messages 验证通过。\nNext, check the callback.";
    expect(presentRuntimeOutput(output).visibleText).toBe(output);
  });
});

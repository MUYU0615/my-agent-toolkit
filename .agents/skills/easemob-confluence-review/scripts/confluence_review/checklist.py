from __future__ import annotations

import re
from pathlib import Path

from .shared import write_json


def item(key: str, label: str, matched: bool, issue: str, action: str) -> dict:
    return {"key": key, "label": label, "matched": bool(matched), "issue": issue, "action": action}


def _has(text: str, pattern: str) -> bool:
    return bool(re.search(pattern, text, re.I))


def summarize_checklist(items: list[dict]) -> dict:
    total = len(items)
    matched = sum(1 for entry in items if entry.get("matched"))
    return {"total": total, "matched": matched, "missing": total - matched, "coverage": 0 if total == 0 else round(matched / total, 2)}


def _evaluate_readiness(doc_type: str, engineering_checklist: list[dict], qa_checklist: list[dict]) -> dict:
    engineering = summarize_checklist(engineering_checklist)
    qa = summarize_checklist(qa_checklist)
    stage_label = {
        "prd-review": "HLD / 研发 / 测试",
        "frontend-hld-review": "开发与测试执行",
        "client-hld-review": "开发与测试执行",
        "backend-hld-review": "开发与测试执行",
        "pressure-design-review": "压测执行",
        "pressure-benchmark-review": "性能结论复核",
    }.get(doc_type, "下一阶段")
    return {"engineering_ready": engineering["missing"] == 0, "qa_ready": qa["missing"] == 0, "overall": engineering["missing"] == 0 and qa["missing"] == 0, "next_stage": stage_label}


def _prd(text: str) -> dict:
    engineering = [
        item("business_context", "背景与目标", _has(text, r"背景|目标|价值|目的"), "缺少业务背景、目标或价值说明。", "补充业务背景、目标用户价值和本次需求要解决的问题。"),
        item("roles", "用户角色与影响对象", _has(text, r"用户|角色|persona|对象"), "缺少目标用户、角色或影响对象说明。", "补充目标用户、使用角色、上下游影响方和适用对象。"),
        item("scenarios", "核心场景与主流程", _has(text, r"场景|用例|流程|业务流程"), "缺少核心使用场景、用户流程或业务流转说明。", "补充关键场景、主流程、异常流程和边界路径。"),
        item("scope", "范围边界与不做项", _has(text, r"范围|边界|不包含|不支持"), "缺少范围、边界或不做项说明。", "补充本期范围、排除范围、边界条件和不做什么。"),
        item("rules", "功能规则与约束", _has(text, r"需求|规则|约束|功能点"), "缺少明确的需求项、业务规则或约束说明。", "补充功能需求清单、业务规则、关键约束和优先级。"),
        item("dependencies", "依赖与风险", _has(text, r"依赖|风险|前置条件"), "缺少依赖项、风险或前置条件说明。", "补充外部依赖、前置条件、主要风险和缓解策略。"),
        item("owner_timeline", "负责人与排期", _has(text, r"负责人|时间节点|排期|里程碑|下一步"), "缺少负责人、排期或后续动作安排。", "补充负责人、时间节点、里程碑和后续落地动作。"),
    ]
    qa = [
        item("acceptance", "验收标准可测试", _has(text, r"验收|成功标准|验收标准"), "缺少验收标准或完成判定口径。", "补充可验证的验收标准、成功判定方式和测试关注点。"),
        item("testable_scenarios", "场景可映射测试用例", _has(text, r"场景|用例|流程|业务流程"), "缺少可直接映射测试用例的业务场景说明。", "补充主流程、分支流程和典型异常流程，便于测试设计用例。"),
        item("edge_cases", "异常流与边界流", _has(text, r"异常|边界|失败|错误|降级"), "缺少异常流、失败流或边界条件说明。", "补充异常路径、错误提示、边界条件和失败后的预期行为。"),
        item("test_env", "测试环境与数据", _has(text, r"测试环境|账号|测试数据|联调环境"), "缺少测试环境、测试账号或测试数据准备说明。", "补充测试环境、账号准备、测试数据构造和联调依赖。"),
        item("regression_scope", "回归范围", _has(text, r"回归|影响范围|兼容"), "缺少回归范围或兼容影响说明。", "补充影响模块、兼容范围和建议回归范围。"),
        item("release_verification", "发布验证点", _has(text, r"发布|上线|验证点|灰度"), "缺少发布后的验证点或上线检查说明。", "补充上线验证点、灰度观察指标和回滚触发条件。"),
    ]
    return {"engineering": engineering, "qa": qa}


def _generic(text: str) -> dict:
    return {
        "engineering": [
            item("context", "背景与目标", _has(text, r"背景|目标|目的"), "背景和目标描述不够明确。", "补充文档背景、目标和要解决的问题。"),
            item("scope", "范围边界", _has(text, r"范围|边界|不包含|不支持"), "范围和边界描述不足。", "明确包含范围、排除范围和边界条件。"),
            item("details", "关键细节", _has(text, r"接口|字段|参数|数据结构|异常|错误码|兼容"), "接口、数据结构、异常处理或兼容性说明不足。", "补充接口定义、关键字段、异常处理和兼容性策略。"),
        ],
        "qa": [
            item("owner", "责任人与后续动作", _has(text, r"负责人|owner|时间|截止|待办|todo|下一步"), "缺少责任人、时间点或后续动作信息。", "补充责任人、时间节点和后续执行动作。"),
            item("acceptance", "验收与验证", _has(text, r"验收|验证|成功标准"), "缺少可验证的验收或成功判定说明。", "补充验收标准、验证口径和回归范围。"),
        ],
    }


def _frontend_hld(text: str) -> dict:
    groups = _generic(text)
    groups["engineering"] = [
        item("module_boundary", "页面/模块边界", _has(text, r"页面|模块|边界|route|路由"), "缺少页面或模块边界说明。", "补充页面范围、模块边界和主要入口路由。"),
        item("component_state", "组件职责与状态管理", _has(text, r"组件|状态管理|store|viewmodel|state"), "缺少组件职责或状态管理说明。", "补充核心组件职责、状态归属和数据更新方式。"),
        item("interaction_flow", "交互流程", _has(text, r"交互|点击|流程|用户操作|跳转"), "缺少关键交互流程说明。", "补充主交互路径、跳转关系和关键状态切换。"),
        item("api_contract", "对外 API 与参数契约", _has(text, r"对外\s*API|API|接口|参数|字段|request|response|入参|出参"), "缺少对外 API、接口参数或字段契约说明。", "补充是否有对外 API、API 具体参数、字段含义、必填/可选、返回结构和错误码。"),
        item("platform_diff", "Web 适配与兼容", _has(text, r"web|浏览器|兼容|适配"), "缺少 Web 适配与兼容策略说明。", "补充浏览器兼容范围、适配策略和影响页面。"),
    ]
    groups["qa"] = [
        item("ui_paths", "可验证交互路径", _has(text, r"交互|点击|流程|用户操作"), "缺少可直接验证的关键交互路径。", "补充主流程、分支流程和关键交互检查点。"),
        item("state_assertions", "状态切换判定", _has(text, r"加载|空态|异常态|成功态|失败态|状态"), "缺少 UI 状态切换和判定标准说明。", "补充加载态、空态、异常态、成功态的期望表现与判定口径。"),
        item("api_retry", "API 失败与重试策略", _has(text, r"重试|超时|失败|错误码|幂等|退避|retry|timeout"), "缺少 API 调用失败、超时、重试或幂等策略说明。", "补充 API 调用失败、超时、重试次数、退避策略、幂等保障和用户可见表现。"),
        item("exception_permissions", "异常/权限/弱网流", _has(text, r"异常|权限|弱网|失败|重试"), "缺少异常流、权限流或弱网流的可测说明。", "补充异常、权限拒绝、弱网和重试等测试场景。"),
    ]
    return groups


def _client_hld(text: str) -> dict:
    return {
        "engineering": [
            item("client_boundary", "客户端范围与端边界", _has(text, r"客户端|移动端|ios|android|sdk|端上|机型"), "缺少客户端范围、端边界或适用平台说明。", "补充 iOS、Android、SDK、端上模块边界、适用版本和机型范围。"),
            item("client_api_contract", "端上 API/SDK 参数契约", _has(text, r"API|SDK\s*接口|接口|参数|字段|回调|callback|入参|出参"), "缺少端上 API、SDK 接口、参数或回调契约说明。", "补充端上 API/SDK 接口、参数、字段、回调时机、错误码和兼容策略。"),
            item("local_state_storage", "端上状态与本地存储", _has(text, r"状态|缓存|本地存储|离线|数据库|持久化"), "缺少端上状态、本地缓存或离线数据设计说明。", "补充端上状态流转、本地缓存、离线数据、持久化和清理策略。"),
            item("compatibility", "版本与兼容策略", _has(text, r"兼容|版本|升级|降级|灰度|机型|系统版本"), "缺少客户端版本、系统版本或兼容策略说明。", "补充客户端版本、系统版本、升级降级、灰度和兼容范围。"),
        ],
        "qa": [
            item("client_paths", "端上可验证路径", _has(text, r"流程|交互|启动|登录|推送|通知|前后台"), "缺少端上主流程、前后台或通知链路的可测说明。", "补充端上主流程、前后台切换、推送通知和关键交互检查点。"),
            item("network_recovery", "弱网/离线/重试恢复", _has(text, r"弱网|重试|恢复|冲突|超时|失败|离线恢复|断网"), "缺少弱网、离线、重试、恢复或冲突处理的可测说明。", "补充弱网、离线、超时、重试、恢复、冲突处理和用户可见表现。"),
            item("compatibility_matrix", "兼容性矩阵", _has(text, r"兼容|机型|系统版本|ios|android|版本矩阵"), "缺少 iOS/Android、系统版本或机型兼容性测试矩阵。", "补充 iOS/Android、系统版本、机型、升级降级和灰度验证矩阵。"),
        ],
    }


def _backend_hld(text: str) -> dict:
    return {
        "engineering": [
            item("service_boundary", "系统边界与服务职责", _has(text, r"系统边界|服务边界|职责|模块|service"), "缺少系统边界、服务职责或模块边界说明。", "补充系统边界、服务职责、模块边界和关键依赖关系。"),
            item("api_flow", "调用链与数据流", _has(text, r"接口|调用链|数据流|消息流|交互流程"), "缺少关键接口、调用链或数据流说明。", "补充核心接口、同步/异步调用链和关键数据流向。"),
            item("storage_cache", "存储与缓存设计", _has(text, r"数据库|存储|缓存|mq|消息队列|redis"), "缺少存储、缓存或消息机制设计说明。", "补充数据库、缓存、消息队列及数据一致性设计。"),
            item("security_auth", "鉴权与安全", _has(text, r"鉴权|认证|授权|RBAC|OAuth|加密|安全"), "缺少鉴权、安全控制或数据保护说明。", "补充认证鉴权、权限模型、敏感数据保护和加密策略。"),
        ],
        "qa": [
            item("api_testability", "接口可测性", _has(text, r"接口|输入|输出|错误码|状态流转"), "缺少接口输入输出、错误码或状态流转的可测说明。", "补充接口输入输出、状态变化、错误码和断言口径。"),
            item("resilience_paths", "异常/重试/幂等/降级", _has(text, r"异常|重试|幂等|限流|降级|回滚"), "缺少异常、重试、幂等、限流、降级或回滚场景说明。", "补充异常、重试、幂等、限流、降级、回滚等测试场景。"),
            item("test_env_data", "测试环境与数据", _has(text, r"测试环境|测试数据|账号|数据准备|压测环境"), "缺少测试环境、测试数据或账号准备说明。", "补充测试环境、数据准备、账号和数据清理方式。"),
        ],
    }


def _pressure_design(text: str) -> dict:
    return {
        "engineering": [
            item("target", "目标与验收", _has(text, r"目标|验收标准|成功标准"), "缺少明确的测试目标或验收标准。", "补充本次压测/基准方案的目标、验收阈值和成功判定方式。"),
            item("scenario", "场景与路径", _has(text, r"场景|用户路径|流量模型|压测路径"), "缺少测试场景、关键用户路径或流量模型说明。", "补充核心测试场景、链路范围和用户行为路径。"),
            item("environment", "环境与配置", _has(text, r"环境|拓扑|部署|版本|配置项"), "缺少环境规格、部署拓扑、版本或关键配置说明。", "补充机器规格、实例数、部署拓扑、版本和关键配置项。"),
            item("concurrency", "并发与时长", _has(text, r"并发|持续时长|压测时长|爬坡"), "缺少并发规模、持续时长或爬坡策略说明。", "补充并发目标、压测时长、分阶段爬坡策略和停止条件。"),
            item("metrics", "观测指标", _has(text, r"指标|QPS|TPS|P99|P95|CPU|内存|网络|磁盘"), "缺少指标采集范围和核心观测指标定义。", "补充吞吐、时延、错误率、CPU、内存、网络、磁盘等观测指标及采集方式。"),
        ],
        "qa": [
            item("risk", "风险与回滚", _has(text, r"风险|回滚|应急预案"), "缺少风险说明、回滚策略或应急预案。", "补充风险项、回滚方案和异常情况下的处理策略。"),
            item("owner", "负责人与排期", _has(text, r"负责人|执行时间|排期|时间窗口"), "缺少负责人、执行时间或排期信息。", "补充负责人、执行窗口、依赖方和时间安排。"),
            item("output", "输出物与判定", _has(text, r"输出物|结果判定|结论模板"), "缺少预期输出物和结果判定方式说明。", "补充压测完成后需要产出的报表、结论模板和结果判定口径。"),
        ],
    }


def _pressure_benchmark(text: str) -> dict:
    return {
        "engineering": [
            item("target", "目标与场景", _has(text, r"目标|场景|并发|持续时长|环境"), "缺少压测目标、场景、并发规模、持续时长、环境配置说明。", "补充压测目标、测试场景、并发规模、持续时长、机器规格、版本和关键配置。"),
            item("metrics", "关键指标", _has(text, r"QPS|TPS|P95|P99|时延|错误率|CPU|内存|网络|磁盘"), "缺少可直接引用的压测结果结论，无法判断瓶颈是在性能、存储、网络还是资源配置层面。", "补充 QPS/TPS、P95/P99、平均时延、错误率、CPU/内存/网络/磁盘 等核心指标，并说明采样时间范围。"),
            item("comparison", "对比与结论", _has(text, r"对比|参数调整|瓶颈|结论|收益"), "缺少前后对比、参数变化说明和最终瓶颈结论，无法确认优化是否有效。", "补充关键截图对应的文字结论，包括峰值、平台期、抖动区间、异常点和瓶颈判断。"),
        ],
        "qa": [
            item("baseline", "基线与收益", _has(text, r"基线|变更项|收益|结论"), "缺少基线数据或优化收益结论。", "如果有参数调整或开关前后对比，请补充基线数据、变更项和最终收益结论。"),
            item("validation", "结果可验证性", _has(text, r"验收|判定|验证"), "缺少结果判定或验证口径说明。", "补充验证口径、验收标准和测试侧复核方法。"),
        ],
    }


def build_review_checklist(title: str, markdown: str = "", doc_type: dict | None = None) -> dict | None:
    if not doc_type or doc_type.get("type") == "skip-weekly-report":
        return None
    text = re.sub(r"```[\s\S]*?```", "", markdown or "").replace("|", " ")
    groups = {
        "prd-review": _prd,
        "frontend-hld-review": _frontend_hld,
        "client-hld-review": _client_hld,
        "backend-hld-review": _backend_hld,
        "pressure-design-review": _pressure_design,
        "pressure-benchmark-review": _pressure_benchmark,
    }.get(doc_type.get("type"), _generic)(text)
    engineering_summary = summarize_checklist(groups["engineering"])
    qa_summary = summarize_checklist(groups["qa"])
    return {
        "title": title,
        "doc_type": doc_type["type"],
        "template": doc_type.get("selected_template") or doc_type["type"],
        "engineering_checklist": groups["engineering"],
        "qa_checklist": groups["qa"],
        "coverage_summary": {"engineering": engineering_summary, "qa": qa_summary},
        "ready_for_next_stage": _evaluate_readiness(doc_type["type"], groups["engineering"], groups["qa"]),
    }


def extract_checklist_insights(review_checklist: dict | None) -> dict:
    if not review_checklist:
        return {"engineeringIssues": [], "qaIssues": [], "engineeringActions": [], "qaActions": [], "readiness": None}
    engineering = review_checklist.get("engineering_checklist") or []
    qa = review_checklist.get("qa_checklist") or []
    return {
        "engineeringIssues": [entry["issue"] for entry in engineering if not entry.get("matched")],
        "qaIssues": [entry["issue"] for entry in qa if not entry.get("matched")],
        "engineeringActions": [entry["action"] for entry in engineering if not entry.get("matched")],
        "qaActions": [entry["action"] for entry in qa if not entry.get("matched")],
        "readiness": review_checklist.get("ready_for_next_stage"),
    }


def persist_review_checklist_artifact(page_dir: str | Path, review_checklist: dict | None) -> None:
    if review_checklist:
        write_json(Path(page_dir) / "review-checklist.json", review_checklist)

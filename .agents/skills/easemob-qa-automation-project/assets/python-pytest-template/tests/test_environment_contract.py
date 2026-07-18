from __future__ import annotations


def test_environment_contract(config):
    assert config.base_url.startswith("http")
    assert "#" in config.appkey


def test_replace_with_jira_specific_flow(runtime_state):
    runtime_state.set("template_verified", True)
    assert runtime_state.get("template_verified") is True

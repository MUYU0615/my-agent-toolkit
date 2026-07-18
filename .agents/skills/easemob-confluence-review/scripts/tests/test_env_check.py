from __future__ import annotations

from confluence_review.env_check import build_doctor_payload


def test_doctor_payload_does_not_expose_secret_values():
    payload = build_doctor_payload()

    assert "system_env" in payload
    for item in payload["system_env"]:
        assert set(item.keys()) == {"name", "available"}


def test_doctor_payload_includes_install_guidance():
    payload = build_doctor_payload()

    assert any("scripts/run.sh test" in item for item in payload["guidance"])
    assert any(tool["name"] == "tesseract" and "brew install tesseract" in tool["install"] for tool in payload["optional_tools"])

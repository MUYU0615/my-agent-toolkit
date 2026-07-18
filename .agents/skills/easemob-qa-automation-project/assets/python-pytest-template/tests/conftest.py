from __future__ import annotations

import pytest
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
PROJECT_KEY = PROJECT_DIR.name

from easemob_client import EasemobClient
from easemob_config import load_config
from easemob_request_logger import RequestLogger
from easemob_runtime_state import RuntimeState


@pytest.fixture(scope="session")
def config():
    return load_config()


@pytest.fixture(scope="session")
def request_logger():
    logger = RequestLogger(PROJECT_KEY)
    print(f"\nrequest/response log directory: {logger.root}")
    return logger


@pytest.fixture(scope="session")
def client(config, request_logger):
    return EasemobClient(config, logger=request_logger)


@pytest.fixture(scope="session")
def runtime_state():
    return RuntimeState(PROJECT_KEY)

"""Executor factory guards for hf_anchor_bot.__main__."""

from __future__ import annotations

import importlib


def test_make_executor_dry_run_returns_dry_run_executor():
    m = importlib.import_module("hf_anchor_bot.__main__")
    ex = m._make_executor(True)
    from hf_anchor_bot.execution import DryRunExecutor

    assert isinstance(ex, DryRunExecutor)


def test_make_executor_live_without_flag_raises():
    m = importlib.import_module("hf_anchor_bot.__main__")
    try:
        m._make_executor(False)
    except RuntimeError as e:
        assert "DRY_RUN=false" in str(e)
        assert "live executor" in str(e).lower()
    else:
        raise AssertionError("expected RuntimeError")


def test_live_executor_available_flag_exists():
    m = importlib.import_module("hf_anchor_bot.__main__")
    assert hasattr(m, "LIVE_EXECUTOR_AVAILABLE")
    assert isinstance(m.LIVE_EXECUTOR_AVAILABLE, bool)


def test_make_executor_live_with_hf_env_returns_live_order_executor(monkeypatch):
    monkeypatch.setenv("HF_ANCHOR_LIVE_EXECUTOR_AVAILABLE", "true")
    import importlib

    m = importlib.import_module("hf_anchor_bot.__main__")
    ex = m._make_executor(False)
    from hf_anchor_bot.execution import LiveOrderExecutor

    assert isinstance(ex, LiveOrderExecutor)


def test_dry_run_executor_has_no_clob_client():
    """DRY_RUN uses DryRunExecutor only — no CLOB order client attached."""
    from hf_anchor_bot.execution import DryRunExecutor

    ex = DryRunExecutor()
    assert getattr(ex, "clob", None) is None


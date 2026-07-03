"""Dispatch action -> task mapping in WorkerPool._dispatch.

Regression guard for the route<->dispatch contract: every always-admitted PR
action that `github_events.route` can queue as `review_pr` must reach
`tasks.review_pr`. `pull_request.synchronize` is admitted only behind the
settings gate in `_dispatch`; missed actions fall through to the no-op branch
and get silently marked `done`.
"""

from __future__ import annotations

import pytest

from robomp import tasks
from robomp.config import Settings
from robomp.db import Database, EventRow
from robomp.queue import WorkerPool
from robomp.slot_pool import SlotPool


class _StubGitHub:
    """Sentinel; dispatch tests stub out the task body."""


class _StubSandbox:
    natives_cache = None


class _StubGitTransport:
    pass


def _make_pool(settings: Settings, db: Database) -> WorkerPool:
    return WorkerPool(
        settings=settings,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=SlotPool(),
    )


def _pr_row(action: str, *, delivery: str = "pr1") -> EventRow:
    return EventRow(
        delivery_id=delivery,
        event_type="pull_request",
        repo="octo/widget",
        issue_key="octo/widget#7",
        payload={"action": action, "pull_request": {"number": 7}},
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )


@pytest.mark.parametrize("action", ["opened", "reopened", "ready_for_review", "labeled"])
@pytest.mark.asyncio
async def test_dispatch_routes_pr_review_actions_to_review_pr(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    """Every PR action `route` can queue for review MUST reach `tasks.review_pr`.

    `labeled` is the vouched-label trigger, `synchronize` is config-gated in
    `route`, and the others are the `open` trigger.
    """
    seen: list[str] = []

    async def fake_review_pr(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("action")))

    monkeypatch.setattr(tasks, "review_pr", fake_review_pr)

    await _make_pool(settings, db)._dispatch(_pr_row(action))  # noqa: SLF001

    assert seen == [action]


@pytest.mark.asyncio
async def test_dispatch_pr_synchronize_respects_settings_gate(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[str] = []

    async def fake_review_pr(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("action")))

    monkeypatch.setattr(tasks, "review_pr", fake_review_pr)

    class DisabledReviewSettings:
        on_synchronize = False
        max_reviews_per_pr = 3

    monkeypatch.setitem(settings.__dict__, "review", DisabledReviewSettings())
    await _make_pool(settings, db)._dispatch(_pr_row("synchronize", delivery="sync-disabled"))  # noqa: SLF001
    assert seen == []

    class EnabledReviewSettings:
        on_synchronize = True
        max_reviews_per_pr = 3

    monkeypatch.setitem(settings.__dict__, "review", EnabledReviewSettings())
    await _make_pool(settings, db)._dispatch(_pr_row("synchronize", delivery="sync-enabled"))  # noqa: SLF001
    assert seen == ["synchronize"]


@pytest.mark.asyncio
async def test_dispatch_pr_synchronize_skipped_under_vouched_label_trigger(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stored/retried synchronize row must not bypass the vouch gate.

    `github_events.route` defers synchronize to the `labeled` event under
    `vouched_label`; `_dispatch` must enforce the same gate so a retried
    row never reaches `review_pr` even when `on_synchronize` is True.
    """
    seen: list[str] = []

    async def fake_review_pr(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("action")))

    monkeypatch.setattr(tasks, "review_pr", fake_review_pr)

    class EnabledReviewSettings:
        on_synchronize = True
        max_reviews_per_pr = 3

    monkeypatch.setitem(settings.__dict__, "review", EnabledReviewSettings())
    monkeypatch.setitem(settings.__dict__, "pr_review_trigger", "vouched_label")

    await _make_pool(settings, db)._dispatch(_pr_row("synchronize", delivery="sync-vouched"))  # noqa: SLF001
    assert seen == []

    # Under the default `open` trigger the same row is admitted.
    monkeypatch.setitem(settings.__dict__, "pr_review_trigger", "open")
    await _make_pool(settings, db)._dispatch(_pr_row("synchronize", delivery="sync-open"))  # noqa: SLF001
    assert seen == ["synchronize"]


@pytest.mark.asyncio
async def test_pr_comment_rereview_delegates_to_review_pr(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, object] = {}

    async def fake_review_pr(**kwargs) -> None:
        seen.update(kwargs)

    monkeypatch.setattr(tasks, "review_pr", fake_review_pr)

    payload = {
        "action": "created",
        "repository": {"full_name": "octo/widget"},
        "issue": {"number": 7, "pull_request": {"url": "https://api.github.test/pulls/7"}},
        "comment": {"user": {"login": "can1357"}, "body": "@robomp-bot please re-review"},
        "_robomp_review": {"bypass_once_guard": True},
    }

    await tasks.handle_pr_conversation(
        settings=settings,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        payload=payload,
        delivery_id="d-rereview",
    )

    delegated_payload = seen["payload"]
    assert isinstance(delegated_payload, dict)
    assert delegated_payload["pull_request"] == {"number": 7}
    assert delegated_payload["_robomp_review"] == {"bypass_once_guard": True}

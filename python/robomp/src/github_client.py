"""Minimal typed GitHub REST client (PAT auth, httpx)."""

import asyncio
import logging
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
ACCEPT = "application/vnd.github+json"
API_VERSION = "2022-11-28"


class GitHubError(RuntimeError):
    """Raised on non-2xx responses from GitHub."""

    def __init__(self, status: int, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(f"GitHub {status}: {message}")
        self.status = status
        self.message = message
        self.retry_after = retry_after


@dataclass(slots=True, frozen=True)
class IssueInfo:
    repo: str
    number: int
    title: str
    body: str
    state: str
    author: str
    labels: tuple[str, ...]
    is_pull_request: bool


@dataclass(slots=True, frozen=True)
class CommentInfo:
    id: int
    author: str
    body: str
    created_at: str


@dataclass(slots=True, frozen=True)
class RepoInfo:
    full_name: str
    default_branch: str
    clone_url: str
    private: bool


@dataclass(slots=True, frozen=True)
class PullRequestInfo:
    repo: str
    number: int
    html_url: str
    head_ref: str
    base_ref: str
    state: str
    author: str = ""
    head_repo: str = ""
    title: str = ""
    body: str = ""


@dataclass(slots=True, frozen=True)
class PullRequestFileInfo:
    path: str
    status: str
    additions: int
    deletions: int


@dataclass(slots=True, frozen=True)
class LinkedPullRequest:
    """A PR linked to an issue via closing keywords or the Development panel.

    Carries the PR's own source repo and html_url so cross-repo linked PRs
    can be reported with their full identity (``owner/repo#N``) rather than
    a bare ``#N`` that is ambiguous across repositories.
    """

    repo: str
    number: int
    html_url: str = ""


@dataclass(slots=True, frozen=True)
class ReviewCommentInfo:
    """In-line PR review comment (attached to a file/line)."""

    id: int
    author: str
    body: str
    path: str
    line: int | None
    created_at: str


@dataclass(slots=True, frozen=True)
class PullRequestReviewInfo:
    """Top-level PR review (the summary block, not the inline comments)."""

    id: int
    author: str
    body: str
    state: str  # APPROVED / CHANGES_REQUESTED / COMMENTED
    submitted_at: str


@dataclass(slots=True, frozen=True)
class IssueSummary:
    """Lightweight projection of an issue for list views (no body)."""

    repo: str
    number: int
    title: str
    state: str
    author: str
    labels: tuple[str, ...]
    comments: int
    updated_at: str
    created_at: str
    html_url: str


@dataclass(slots=True, frozen=True)
class ReactionInfo:
    """A reaction on an issue/comment.

    `content` is GitHub's reaction string: `+1`, `-1`, `laugh`, `hooray`,
    `confused`, `heart`, `rocket`, `eyes`. The auto-close scheduler only
    looks at `-1` (👎) reactions from the issue's original author.
    """

    content: str
    user_login: str
    user_type: str


def _parse_retry_after(resp: httpx.Response) -> float | None:
    ra = resp.headers.get("retry-after")
    if ra:
        try:
            return float(ra)
        except ValueError:
            pass
    reset = resp.headers.get("x-ratelimit-reset")
    if reset:
        try:
            return max(0.0, float(reset) - time.time())
        except ValueError:
            pass
    return None


_CLOSING_KEYWORD_RE = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s+|:\s*)"
    r"(?:#(?P<num>\d+)"
    r"|https?://(?:www\.)?github\.com/(?P<url_repo>[\w.+-]+/[\w.+-]+)/issues/(?P<url_num>\d+)"
    r"|(?P<repo>[\w.+-]+/[\w.+-]+)#(?P<repo_num>\d+))",
    re.IGNORECASE,
)


def _repo_from_url(url: object) -> str:
    """Extract ``owner/repo`` from a GitHub API ``repository_url``, or ``""``."""
    if not isinstance(url, str) or not url:
        return ""
    parts = url.rstrip("/").split("/")
    if len(parts) >= 2:
        return f"{parts[-2]}/{parts[-1]}"
    return ""


def _closing_keyword_for(body: str, issue_number: int, repo: str = "", *, source_repo: str = "") -> bool:
    """True iff *body* contains a closing keyword referencing *issue_number*.

    Recognizes the three GitHub closing-reference forms: bare ``#N``,
    a full URL ending in ``/issues/N``, and the ``owner/repo#N`` shorthand
    (e.g. ``Fixes octo/widget#42``) GitHub accepts for cross-repo links.
    Also accepts the colon-form ``Closes: #N``.

    For the ``owner/repo#N`` form the prefix must match *repo* (the issue's
    own repository) so an unrelated cross-repo reference like
    ``Fixes other/repo#42`` does not trip the duplicate guard on issue #42
    of a different repository.

    For the URL form the repo path in the URL must match *repo* when *repo*
    is provided, so ``Fixes https://github.com/other/repo/issues/42`` does
    not falsely match issue #42 of a different repository.

    For the bare ``#N`` form, when *source_repo* is provided (the repo the
    referencing PR lives in), it must match *repo* — a bare ``#42`` in a
    cross-repo PR refers to that PR's own issue #42, not this repo's.
    """
    for match in _CLOSING_KEYWORD_RE.finditer(body):
        num = match.group("num")
        if num:
            # Bare #N — only trust when the source PR is in the same repo
            # as the issue. A cross-repo PR's bare #N refers to its own
            # repo's issue, not ours.
            if source_repo and repo and source_repo.lower() != repo.lower():
                continue
            if int(num) == issue_number:
                return True
            continue
        url_num = match.group("url_num")
        if url_num:
            # URL form — the repo in the URL path must match our repo.
            if repo and (match.group("url_repo") or "").lower() != repo.lower():
                continue
            if int(url_num) == issue_number:
                return True
            continue
        repo_num = match.group("repo_num")
        if repo_num:
            # owner/repo#N — a fully-qualified cross-repo shorthand. Only
            # count it when we know our own repo AND the prefix matches;
            # without a repo context we cannot confirm it targets THIS
            # issue, so skip it rather than risk a false positive on the
            # duplicate-PR refuse gate.
            if not repo or (match.group("repo") or "").lower() != repo.lower():
                continue
            if int(repo_num) == issue_number:
                return True
    return False


class GitHubClient:
    """Async + sync facades over a small slice of the GitHub REST API."""

    def __init__(self, token: str, *, transport: httpx.BaseTransport | None = None) -> None:
        self._token = token
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": ACCEPT,
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "robomp/0.1",
        }
        self._transport = transport

    def _client(self) -> httpx.Client:
        return httpx.Client(
            base_url=GITHUB_API,
            headers=self._headers,
            transport=self._transport,
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )

    def _async_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=GITHUB_API,
            headers=self._headers,
            transport=self._transport,  # type: ignore[arg-type]
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )

    # ---- request helpers ----
    def _check(self, resp: httpx.Response) -> Any:
        if resp.status_code >= 400:
            retry_after = _parse_retry_after(resp)
            try:
                msg = resp.json().get("message", resp.text)
            except Exception:
                msg = resp.text
            raise GitHubError(resp.status_code, str(msg), retry_after=retry_after)
        if resp.status_code >= 300:
            # Redirect we couldn't (or weren't asked to) follow. GitHub uses 301
            # for transferred repos / issues. Surface as a normal error so host
            # tools map it to RpcCommandError instead of mis-parsing the body.
            location = resp.headers.get("location", "")
            raise GitHubError(
                resp.status_code,
                f"unexpected redirect to {location!r}; resource may have moved",
            )
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    _TRANSIENT_RETRY_DELAYS = (1.0, 3.0, 10.0)
    """Backoff schedule for transient connection/timeout errors."""

    def request_sync(
        self, method: str, path: str, *, json: Mapping[str, Any] | None = None, params: Mapping[str, Any] | None = None
    ) -> Any:
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                with self._client() as client:
                    resp = client.request(method, path, json=json, params=params)
                    return self._check(resp)
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "transient error, retrying",
                    extra={"method": method, "path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                time.sleep(delay)
        raise last_exc  # type: ignore[misc]

    async def request(
        self, method: str, path: str, *, json: Mapping[str, Any] | None = None, params: Mapping[str, Any] | None = None
    ) -> Any:
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                async with self._async_client() as client:
                    resp = await client.request(method, path, json=json, params=params)
                    return self._check(resp)
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "transient error, retrying",
                    extra={"method": method, "path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                await asyncio.sleep(delay)
        raise last_exc  # type: ignore[misc]

    # ---- repos / issues / comments / PRs ----
    async def get_repo(self, repo: str) -> RepoInfo:
        data = await self.request("GET", f"/repos/{repo}")
        return _repo_from_payload(data)

    async def get_issue(self, repo: str, number: int) -> IssueInfo:
        data = await self.request("GET", f"/repos/{repo}/issues/{number}")
        return _issue_from_payload(repo, data)

    async def list_closing_pull_requests(
        self, repo: str, number: int, *, default_branch: str = ""
    ) -> tuple[LinkedPullRequest, ...]:
        """Return PRs currently linked to issue ``number`` via "Closes"/"Fixes"
        keywords or the Development panel.

        Walks ``GET /repos/{repo}/issues/{N}/timeline`` and computes net
        ``connected`` − ``disconnected`` events for sources that are pull
        requests. ``cross-referenced`` events are also considered when the
        source PR body contains a closing keyword (``Fixes #N`` /
        ``Closes #N``) for this issue, because GitHub does not always emit a
        matching ``connected`` event for closing-keyword links. Only PRs
        whose timeline source carries ``state == "open"`` are returned — a
        merged or closed PR no longer needs the bot's work.

        When *default_branch* is provided, cross-referenced PRs whose body
        contains a closing keyword are additionally verified to target the
        default branch of their **own** repository:

        - A **same-repo** PR targeting a feature branch does not block the
          guard.
        - A **cross-repo** PR (``source_repo`` differs from *repo*) is
          fetched from its own source repository and its base ref is
          compared against that repo's default branch. This prevents a
          cross-repo PR targeting a feature branch from blocking a valid
          fix. PRs whose base ref or default branch cannot be fetched are
          skipped (fail open) so a GitHub hiccup doesn't block a legitimate
          PR.

        The timeline is paginated (``per_page=100``) because by the time the
        duplicate guard runs at ``gh_open_pr`` the issue may have accumulated
        well over 100 events (comments, commits, cross-refs); a ``connected``
        or ``cross-referenced`` link can land on any page.
        """
        # Keyed by (repo, number) so two repos' PRs sharing a number
        # don't collide.
        linked: dict[tuple[str, int], LinkedPullRequest] = {}
        states: dict[tuple[str, int], str] = {}
        # Cache source_repo → default_branch to avoid re-fetching across
        # multiple cross-repo cross-refs from the same source repo.
        source_defaults: dict[str, str] = {}
        page = 1
        while True:
            try:
                data = await self.request(
                    "GET",
                    f"/repos/{repo}/issues/{number}/timeline",
                    params={"per_page": 100, "page": page},
                )
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                if page == 1:
                    raise
                # Page 2+ transport failure: fail open with what we have
                # so a network hiccup mid-pagination doesn't crash
                # direct-PAT triage. Page 1 failures still propagate (a
                # total timeline fetch failure is a real error).
                log.warning(
                    "timeline page %d transport error; returning partial results",
                    page,
                    extra={"repo": repo, "number": number, "page": page, "error": str(exc)},
                )
                break
            batch = data or []
            for event in batch:
                if not isinstance(event, Mapping):
                    continue
                ev = event.get("event")
                source = event.get("source") or {}
                src_issue = source.get("issue") if isinstance(source, Mapping) else None
                if not isinstance(src_issue, Mapping) or "pull_request" not in src_issue:
                    continue
                pr_number = src_issue.get("number")
                if not isinstance(pr_number, int):
                    continue
                source_repo = _repo_from_url(src_issue.get("repository_url")) or repo
                key = (source_repo, pr_number)
                states[key] = str(src_issue.get("state") or "open")
                html_url = str(src_issue.get("html_url") or "")
                if ev == "connected":
                    linked[key] = LinkedPullRequest(repo=source_repo, number=pr_number, html_url=html_url)
                elif ev == "cross-referenced":
                    # GitHub exposes ``Fixes #N`` / ``Closes #N`` PR-body links
                    # as ``cross-referenced`` events, not always as
                    # ``connected``. Only treat the cross-ref as a closing
                    # link when the PR body contains a closing keyword for
                    # this issue number, so mere mentions don't trigger
                    # false-positive duplicate guards.
                    pr_body = src_issue.get("body") or ""
                    if not _closing_keyword_for(pr_body, number, repo, source_repo=source_repo):
                        continue
                    if default_branch:
                        if source_repo.lower() == repo.lower():
                            # Same-repo PR: verify it targets the default
                            # branch — a PR targeting a feature branch should
                            # not block the guard. Fail open on fetch errors.
                            try:
                                pr_info = await self.get_pull_request(repo, pr_number)
                            except (GitHubError, httpx.ConnectError, httpx.TimeoutException):
                                continue
                            if pr_info.base_ref != default_branch:
                                continue
                        else:
                            # Cross-repo PR: verify it targets the default
                            # branch of its OWN source repo. Fetch the
                            # source repo's default branch (cached) and the
                            # PR from the source repo. Fail open on any
                            # fetch error so a GitHub hiccup or an
                            # inaccessible private repo doesn't block a
                            # valid fix.
                            try:
                                src_default = source_defaults.get(source_repo)
                                if src_default is None:
                                    src_repo_info = await self.get_repo(source_repo)
                                    src_default = src_repo_info.default_branch
                                    source_defaults[source_repo] = src_default
                                pr_info = await self.get_pull_request(source_repo, pr_number)
                            except (GitHubError, httpx.ConnectError, httpx.TimeoutException):
                                continue
                            if pr_info.base_ref != src_default:
                                continue
                            html_url = pr_info.html_url or html_url
                    linked[key] = LinkedPullRequest(repo=source_repo, number=pr_number, html_url=html_url)
                elif ev == "disconnected":
                    linked.pop(key, None)
            if len(batch) < 100:
                break
            page += 1
        return tuple(
            sorted(
                (v for k, v in linked.items() if states.get(k, "open") == "open"),
                key=lambda lpr: (lpr.repo, lpr.number),
            )
        )

    async def get_pull_request(self, repo: str, number: int) -> PullRequestInfo:
        data = await self.request("GET", f"/repos/{repo}/pulls/{number}")
        return _pr_from_payload(repo, data)

    async def list_pr_files(self, repo: str, pr_number: int) -> list[PullRequestFileInfo]:
        files: list[PullRequestFileInfo] = []
        page = 1
        while True:
            data = await self.request(
                "GET",
                f"/repos/{repo}/pulls/{pr_number}/files",
                params={"per_page": 100, "page": page},
            )
            batch = [_pr_file_from_payload(item) for item in (data or [])]
            files.extend(batch)
            if len(batch) < 100:
                return files
            page += 1

    async def list_issues(
        self,
        repo: str,
        *,
        state: str = "open",
        limit: int = 30,
    ) -> list[IssueSummary]:
        """List recent issues for `repo`, newest-updated first. Excludes pull requests.

        `state` is one of `open`, `closed`, `all`. `limit` is capped at 100 by the
        GitHub `per_page`; we don't paginate here — the dashboard browse view shows
        a recent slice, not every issue ever.
        """
        if state not in ("open", "closed", "all"):
            raise ValueError(f"invalid state: {state!r}")
        per_page = max(1, min(int(limit), 100))
        data = await self.request(
            "GET",
            f"/repos/{repo}/issues",
            params={"state": state, "per_page": per_page, "sort": "updated", "direction": "desc"},
        )
        out: list[IssueSummary] = []
        for item in data or []:
            if "pull_request" in item:
                continue  # GitHub's /issues endpoint also returns PRs; skip them.
            user = item.get("user") or {}
            labels_raw = item.get("labels") or []
            out.append(
                IssueSummary(
                    repo=repo,
                    number=int(item["number"]),
                    title=str(item.get("title") or ""),
                    state=str(item.get("state") or "open"),
                    author=str(user.get("login") or ""),
                    labels=tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in labels_raw),
                    comments=int(item.get("comments") or 0),
                    updated_at=str(item.get("updated_at") or ""),
                    created_at=str(item.get("created_at") or ""),
                    html_url=str(item.get("html_url") or ""),
                )
            )
        return out

    async def list_comments(self, repo: str, number: int) -> list[CommentInfo]:
        data = await self.request("GET", f"/repos/{repo}/issues/{number}/comments", params={"per_page": 100})
        return [_comment_from_payload(item) for item in (data or [])]

    async def list_review_comments(self, repo: str, pr_number: int) -> list[ReviewCommentInfo]:
        """List inline review comments on a PR (the ones attached to a path:line)."""
        data = await self.request(
            "GET",
            f"/repos/{repo}/pulls/{pr_number}/comments",
            params={"per_page": 100},
        )
        out: list[ReviewCommentInfo] = []
        for item in data or []:
            user = item.get("user") or {}
            line = item.get("line")
            if not isinstance(line, int):
                orig = item.get("original_line")
                line = orig if isinstance(orig, int) else None
            out.append(
                ReviewCommentInfo(
                    id=int(item.get("id") or 0),
                    author=str(user.get("login") or ""),
                    body=str(item.get("body") or ""),
                    path=str(item.get("path") or ""),
                    line=line,
                    created_at=str(item.get("created_at") or ""),
                )
            )
        return out

    async def list_pr_reviews(self, repo: str, pr_number: int) -> list[PullRequestReviewInfo]:
        """List top-level reviews on a PR. Empty-body reviews are skipped — they
        carry no novel text beyond what the inline comments + merge state convey."""
        data = await self.request(
            "GET",
            f"/repos/{repo}/pulls/{pr_number}/reviews",
            params={"per_page": 100},
        )
        out: list[PullRequestReviewInfo] = []
        for item in data or []:
            user = item.get("user") or {}
            body = str(item.get("body") or "").strip()
            if not body:
                continue
            out.append(
                PullRequestReviewInfo(
                    id=int(item.get("id") or 0),
                    author=str(user.get("login") or ""),
                    body=body,
                    state=str(item.get("state") or ""),
                    submitted_at=str(item.get("submitted_at") or item.get("created_at") or ""),
                )
            )
        return out

    async def post_comment(self, repo: str, number: int, body: str) -> CommentInfo:
        data = await self.request(
            "POST",
            f"/repos/{repo}/issues/{number}/comments",
            json={"body": body},
        )
        return _comment_from_payload(data)

    async def open_pull_request(
        self,
        *,
        repo: str,
        head: str,
        base: str,
        title: str,
        body: str,
        draft: bool = False,
        maintainer_can_modify: bool = True,
    ) -> PullRequestInfo:
        data = await self.request(
            "POST",
            f"/repos/{repo}/pulls",
            json={
                "title": title,
                "body": body,
                "head": head,
                "base": base,
                "draft": draft,
                "maintainer_can_modify": maintainer_can_modify,
            },
        )
        return _pr_from_payload(repo, data)

    async def request_reviewers(
        self,
        *,
        repo: str,
        pr_number: int,
        reviewers: list[str] | None = None,
        team_reviewers: list[str] | None = None,
    ) -> None:
        payload: dict[str, Any] = {}
        if reviewers:
            payload["reviewers"] = reviewers
        if team_reviewers:
            payload["team_reviewers"] = team_reviewers
        if not payload:
            return
        await self.request(
            "POST",
            f"/repos/{repo}/pulls/{pr_number}/requested_reviewers",
            json=payload,
        )

    async def add_issue_labels(self, repo: str, number: int, labels: list[str]) -> tuple[str, ...]:
        """Append labels to an issue (or PR). Returns the full label set after the add.

        Uses `POST /repos/{owner}/{repo}/issues/{n}/labels` which is *additive* —
        we never remove or overwrite existing labels.
        """
        if not labels:
            return ()
        data = await self.request(
            "POST",
            f"/repos/{repo}/issues/{number}/labels",
            json={"labels": labels},
        )
        return tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in (data or []))

    async def remove_issue_label(self, repo: str, number: int, label: str) -> None:
        """Remove one label from an issue (or PR)."""
        if not label:
            return
        encoded = quote(label, safe="")
        await self.request(
            "DELETE",
            f"/repos/{repo}/issues/{number}/labels/{encoded}",
        )

    async def submit_pr_review(
        self,
        *,
        repo: str,
        pr_number: int,
        body: str,
        event: str,
        comments: list[Mapping[str, Any]],
    ) -> PullRequestReviewInfo:
        data = await self.request(
            "POST",
            f"/repos/{repo}/pulls/{pr_number}/reviews",
            json={"body": body, "event": event, "comments": comments},
        )
        return _pr_review_from_payload(data)

    async def add_assignees(self, repo: str, number: int, assignees: list[str]) -> None:
        if not assignees:
            return
        await self.request(
            "POST",
            f"/repos/{repo}/issues/{number}/assignees",
            json={"assignees": assignees},
        )

    async def list_comment_reactions(self, repo: str, comment_id: int) -> tuple[ReactionInfo, ...]:
        """Reactions on an issue comment, filtered server-side to 👎 (`content=-1`).

        The auto-close scheduler only consults 👎 reactions; filtering server-side
        keeps payloads small even on noisy threads. Returns reactions in the
        order GitHub provides (creation order).
        """
        data = await self.request(
            "GET",
            f"/repos/{repo}/issues/comments/{comment_id}/reactions",
            params={"content": "-1", "per_page": 100},
        )
        return tuple(_reaction_from_payload(item) for item in (data or []))

    async def close_issue(self, repo: str, number: int, *, reason: str = "completed") -> None:
        """Close an issue with `state_reason` (`completed`/`not_planned`/`reopened`)."""
        await self.request(
            "PATCH",
            f"/repos/{repo}/issues/{number}",
            json={"state": "closed", "state_reason": reason},
        )

    async def get_authenticated_login(self) -> str:
        data = await self.request("GET", "/user")
        return str(data["login"])


def _repo_from_payload(data: Mapping[str, Any]) -> RepoInfo:
    return RepoInfo(
        full_name=str(data["full_name"]),
        default_branch=str(data["default_branch"]),
        clone_url=str(data["clone_url"]),
        private=bool(data.get("private", False)),
    )


def _issue_from_payload(repo: str, data: Mapping[str, Any]) -> IssueInfo:
    labels_raw = data.get("labels") or []
    labels = tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in labels_raw)
    user = data.get("user") or {}
    return IssueInfo(
        repo=repo,
        number=int(data["number"]),
        title=str(data.get("title") or ""),
        body=str(data.get("body") or ""),
        state=str(data.get("state") or "open"),
        author=str(user.get("login") or ""),
        labels=labels,
        is_pull_request="pull_request" in data,
    )


def _pr_review_from_payload(data: Mapping[str, Any]) -> PullRequestReviewInfo:
    user = data.get("user") or {}
    body = str(data.get("body") or "").strip()
    return PullRequestReviewInfo(
        id=int(data.get("id") or 0),
        author=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        body=body,
        state=str(data.get("state") or ""),
        submitted_at=str(data.get("submitted_at") or data.get("created_at") or ""),
    )


def _pr_file_from_payload(data: Mapping[str, Any]) -> PullRequestFileInfo:
    return PullRequestFileInfo(
        path=str(data.get("filename") or data.get("path") or ""),
        status=str(data.get("status") or ""),
        additions=int(data.get("additions") or 0),
        deletions=int(data.get("deletions") or 0),
    )


def _pr_from_payload(repo: str, data: Mapping[str, Any]) -> PullRequestInfo:
    head = data.get("head") or {}
    base = data.get("base") or {}
    user = data.get("user") or {}
    head_repo = head.get("repo") if isinstance(head, Mapping) else None
    return PullRequestInfo(
        repo=repo,
        number=int(data["number"]),
        html_url=str(data["html_url"]),
        head_ref=str(head.get("ref") or "") if isinstance(head, Mapping) else "",
        base_ref=str(base.get("ref") or "") if isinstance(base, Mapping) else "",
        state=str(data.get("state") or "open"),
        author=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        head_repo=str(head_repo.get("full_name") or "") if isinstance(head_repo, Mapping) else "",
        title=str(data.get("title") or ""),
        body=str(data.get("body") or ""),
    )


def _comment_from_payload(data: Mapping[str, Any]) -> CommentInfo:
    user = data.get("user") or {}
    return CommentInfo(
        id=int(data["id"]),
        author=str(user.get("login") or ""),
        body=str(data.get("body") or ""),
        created_at=str(data.get("created_at") or ""),
    )


def _reaction_from_payload(data: Mapping[str, Any]) -> ReactionInfo:
    user = data.get("user") or {}
    return ReactionInfo(
        content=str(data.get("content") or ""),
        user_login=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        user_type=str(user.get("type") or "") if isinstance(user, Mapping) else "",
    )


def parse_issue_payload(payload: Mapping[str, Any]) -> tuple[RepoInfo, IssueInfo]:
    """Build typed records from a webhook payload (issues.opened, etc.)."""
    repo_payload = payload["repository"]
    repo = _repo_from_payload(repo_payload)
    issue = _issue_from_payload(repo.full_name, payload["issue"])
    return repo, issue


__all__ = [
    "ACCEPT",
    "API_VERSION",
    "CommentInfo",
    "GitHubClient",
    "GitHubError",
    "IssueInfo",
    "IssueSummary",
    "LinkedPullRequest",
    "PullRequestFileInfo",
    "PullRequestInfo",
    "PullRequestReviewInfo",
    "ReactionInfo",
    "RepoInfo",
    "ReviewCommentInfo",
    "parse_issue_payload",
]

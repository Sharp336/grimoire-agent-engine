"""Fail-closed Kitty remote-control policy for the OMP subagent pane example.

Kitty must be started with OMP_KITTY_OMP_EXECUTABLE set to the same absolute
npm/Bun `omp` executable used by the launcher. The password using this policy
is intentionally useful only for exact viewer launch, structured listing, and
ownership-qualified close-window requests.
"""

import os
import re
import tempfile
from typing import Any

_OWNER_VAR = "OMP_PANE_OWNER"
_VIEWER_VAR = "OMP_PANE_VIEWER"
_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
_CLOSE_MATCH = re.compile(rf"^id:[1-9][0-9]* and var:{_OWNER_VAR}=({_UUID}) and var:{_VIEWER_VAR}=({_UUID})$")
_HANDOFF = re.compile(rf"^handoff-{_UUID}\.json$")
_CHILD_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_CONFIGURED_OMP = os.environ.get("OMP_KITTY_OMP_EXECUTABLE", "")
_ALLOWED_OMP = os.path.realpath(_CONFIGURED_OMP) if os.path.isabs(_CONFIGURED_OMP) else ""


def _defaults_only(
    payload: dict[str, Any],
    defaults: dict[str, Any],
    required: set[str] | None = None,
    dynamic: set[str] | None = None,
) -> bool:
    required_fields = required or set()
    dynamic_fields = dynamic or set()
    return (
        required_fields.issubset(payload)
        and set(payload).issubset(defaults)
        and all(key in dynamic_fields or payload.get(key, expected) == expected for key, expected in defaults.items())
    )


def _valid_handoff(locator: Any) -> bool:
    if not isinstance(locator, str) or not os.path.isabs(locator):
        return False
    root = os.path.realpath(os.path.join(tempfile.gettempdir(), f"omp-agent-pane-{os.getuid()}"))
    resolved = os.path.realpath(locator)
    return os.path.dirname(resolved) == root and bool(_HANDOFF.fullmatch(os.path.basename(resolved)))


def _allow_launch(payload: dict[str, Any]) -> bool:
    defaults = {
        "args": None,
        "match": None,
        "next_to": None,
        "source_window": None,
        "window_title": None,
        "cwd": None,
        "add_to_session": None,
        "env": [
            "OMP_KITTY_SUBAGENT_PANES",
            "OMP_KITTY_OMP_EXECUTABLE",
            "OMP_KITTY_KITTEN_EXECUTABLE",
            "OMP_KITTY_RC_PASSWORD_FILE",
            "KITTY_RC_PASSWORD",
            "KITTY_LISTEN_ON",
            "KITTY_PUBLIC_KEY",
        ],
        "var": None,
        "os_panel": [],
        "tab_title": None,
        "type": "window",
        "keep_focus": True,
        "copy_colors": False,
        "copy_cmdline": False,
        "copy_env": False,
        "hold": False,
        "location": "default",
        "allow_remote_control": False,
        "remote_control_password": [],
        "stdin_source": "none",
        "stdin_add_formatting": False,
        "stdin_add_line_wrap_markers": False,
        "spacing": [],
        "marker": None,
        "logo": None,
        "logo_position": None,
        "logo_alpha": -1.0,
        "self": False,
        "os_window_title": None,
        "os_window_name": None,
        "os_window_class": None,
        "os_window_state": "normal",
        "os_window_position": None,
        "color": [],
        "watcher": [],
        "bias": 0.0,
        "wait_for_child_to_exit": False,
        "hold_after_ssh": False,
        "response_timeout": 86400.0,
        "no_response": False,
    }
    if not _defaults_only(payload, defaults, {"args", "env", "var"}, {"args", "var"}):
        return False
    args = payload.get("args")
    variables = payload.get("var")
    if not _ALLOWED_OMP or not isinstance(args, list) or len(args) != 5 or not isinstance(variables, list) or len(variables) != 2:
        return False
    child_id, locator = args[3], args[4]
    if args[:3] != [_ALLOWED_OMP, "__agent-pane", "--"] or not isinstance(child_id, str) or not _CHILD_ID.fullmatch(child_id):
        return False
    owners = [value for value in variables if isinstance(value, str) and value.startswith(f"{_OWNER_VAR}=")]
    viewers = [value for value in variables if isinstance(value, str) and value.startswith(f"{_VIEWER_VAR}=")]
    return (
        len(owners) == 1
        and bool(re.fullmatch(rf"{_OWNER_VAR}={_UUID}", owners[0]))
        and len(viewers) == 1
        and bool(re.fullmatch(rf"{_VIEWER_VAR}={_UUID}", viewers[0]))
        and _valid_handoff(locator)
    )


def _allow_ls(payload: dict[str, Any]) -> bool:
    return _defaults_only(payload, {"all_env_vars": False, "match": None, "match_tab": None, "self": False, "output_format": "json"})


def _allow_close(payload: dict[str, Any]) -> bool:
    return (
        _defaults_only(payload, {"match": None, "self": False, "ignore_no_match": True}, {"match"}, {"match"})
        and isinstance(payload.get("match"), str)
        and bool(_CLOSE_MATCH.fullmatch(payload["match"]))
    )


def is_cmd_allowed(pcmd: Any, window: Any, from_socket: bool, extra_data: Any) -> bool:
    """Allow only the exact requests emitted by kitty-subagent-panes.ts."""
    del window, extra_data
    if from_socket or not isinstance(pcmd, dict) or pcmd.get("no_response", False):
        return False
    payload = pcmd.get("payload")
    if not isinstance(payload, dict):
        return False
    command = pcmd.get("cmd")
    if command == "launch":
        return _allow_launch(payload)
    if command == "ls":
        return _allow_ls(payload)
    if command == "close-window":
        return _allow_close(payload)
    return False

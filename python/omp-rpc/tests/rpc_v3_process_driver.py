from __future__ import annotations

import base64
import json
import math
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from omp_rpc import (
    RpcClient,
    RpcCommandError,
    RpcError,
    RpcV3ClientOptions,
    SessionCommand,
    SessionHostClientCapabilities,
)

FRAME_CONDITION = threading.Condition()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def wait_frame(
    frames: list[dict[str, Any]],
    predicate: Callable[[dict[str, Any]], bool],
    description: str,
    *,
    after: int = 0,
    timeout: float = 15.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    with FRAME_CONDITION:
        while True:
            for frame in frames[after:]:
                if predicate(frame):
                    return frame
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    f"timed out waiting for {description}; last frames={frames[-8:]}"
                )
            FRAME_CONDITION.wait(remaining)


def response_data(frame: dict[str, Any], command: str) -> dict[str, Any]:
    require(frame.get("type") == "response", f"{command}: expected response")
    require(frame.get("command") == command, f"{command}: wrong response command")
    require(frame.get("success") is True, f"{command}: {frame}")
    data = frame.get("data")
    if not isinstance(data, dict):
        raise AssertionError(f"{command}: response data is not an object")
    return data


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(
            "usage: rpc_v3_process_driver.py BINARY WORK_ROOT PROVIDER_FIXTURE"
        )
    binary = str(Path(sys.argv[1]).resolve(strict=True))
    root = Path(sys.argv[2]).resolve(strict=True)
    provider_fixture = str(Path(sys.argv[3]).resolve(strict=True))
    cwd = root / "python-cwd"
    home = root / "python-home"
    sessions = root / "python-sessions"
    for directory in (cwd, home, sessions):
        directory.mkdir(parents=True, exist_ok=True)
    extension = root / "rpc-process-interactions.ts"
    extension.write_text(
        """
export default function (pi) {
  pi.registerCommand("rpc-process-interactions", {
    description: "Emit process conformance interactions",
    handler: async (_args, ctx) => {
      ctx.ui.setWorkingMessage("process-progress");
      const approval = await ctx.ui.requestApproval?.({
        title: "Process approval",
        toolCallId: "process-tool-call",
        toolName: "process-fixture",
        operation: "write",
        approvalMode: "write",
        resolvedPolicy: "prompt",
        providerSafety: { required: false, checks: [] },
        choices: ["Approve", "Deny"],
        defaultChoice: "Deny",
      });
      const answer = await ctx.ui.askDialog?.([{
        id: "process-question",
        question: "Choose",
        options: [{ label: "A" }, { label: "B" }],
      }]);
      if (approval?.approved !== true || answer?.kind !== "submit") {
        throw new Error("Host did not settle process interactions");
      }
    },
  });
}
""",
        encoding="utf-8",
    )

    raw_frames: list[dict[str, Any]] = []

    def record_raw(frame: dict[str, Any]) -> None:
        with FRAME_CONDITION:
            raw_frames.append(frame)
            FRAME_CONDITION.notify_all()

    client = RpcClient(
        executable=binary,
        mode="rpc-ui",
        session_dir=sessions,
        cwd=cwd,
        env={
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(root / "python-xdg-config"),
            "XDG_DATA_HOME": str(root / "python-xdg-data"),
            "XDG_CACHE_HOME": str(root / "python-xdg-cache"),
            "PI_CODING_AGENT_DIR": str(home / ".omp" / "agent"),
            "PI_NO_TITLE": "1",
            "NO_COLOR": "1",
            "ANTHROPIC_API_KEY": "",
        },
        extra_args=(
            "--extension",
            str(extension),
            "--extension",
            provider_fixture,
            "--model",
            "rpc-process/rpc-native-ask",
            "--api-key",
            "rpc-process-key",
            "--tools",
            "ask",
        ),
        startup_timeout=15.0,
        request_timeout=20.0,
        rpc_v3=RpcV3ClientOptions(
            requested_capabilities=(
                "session.observe",
                "session.execute",
                "session.shutdown",
                "artifact.read",
                "context.projection",
            ),
            host_capabilities=SessionHostClientCapabilities(
                interactions=("confirm", "approval", "ask", "progress"),
                semantic_content=("text", "markdown"),
            ),
        ),
        max_stderr_chunks=None,
    )
    interaction_requests: list[Any] = []

    def handle_interaction(request: Any) -> None:
        interaction_requests.append(request)
        if request.method == "approval":
            client.send_ui_approval(
                request.id,
                "approve",
                operation_id=request.operation_id,
            )
        elif request.method == "ask":
            questions = request.questions or ()
            question_id = questions[0].id if questions else ""
            native = question_id == "native-ask-question"
            client.send_ui_ask(
                request.id,
                {
                    "kind": "submit",
                    "results": [
                        {
                            "id": question_id,
                            "question": (
                                "Choose the native AskTool answer"
                                if native
                                else "Choose"
                            ),
                            "options": (
                                ["native-ask-answer", "wrong-answer"]
                                if native
                                else ["A", "B"]
                            ),
                            "multi": False,
                            "selectedOptions": [
                                "native-ask-answer" if native else "A"
                            ],
                        }
                    ],
                },
            )

    client.on_ui_request(handle_interaction)
    client.on_raw_frame(record_raw)
    require(client.command[0] == binary, "Python client did not select exact binary")

    client.start()
    try:
        require(client.rpc_v3_negotiation is not None, "missing v3 negotiation")
        require(
            client.rpc_v3_negotiation.framing_version == 2,
            "Python client did not negotiate framing v2",
        )
        manifest = client.get_capabilities()
        command_names = {command.name for command in manifest.commands}
        require("session_open" in command_names, "manifest omitted session_open")
        require("session_shutdown" in command_names, "manifest omitted session_shutdown")
        require("context_get" in command_names, "manifest omitted context_get")

        interaction_at = len(raw_frames)
        client.prompt("/rpc-process-interactions")
        for method in ("progress", "approval", "ask"):
            wait_frame(
                raw_frames,
                lambda frame, expected=method: frame.get("type") == "extension_ui_request"
                and frame.get("method") == expected,
                f"Python {method} interaction",
                after=interaction_at,
            )
        require(
            {"progress", "approval", "ask"}
            <= {request.method for request in interaction_requests},
            "Python UI listener omitted a process interaction",
        )
        queued_interactions: set[str] = set()
        for _ in range(16):
            if queued_interactions == {"progress", "approval", "ask"}:
                break
            queued = client.next_ui_request(timeout=5.0)
            if queued.method in {"progress", "approval", "ask"}:
                queued_interactions.add(queued.method)
        require(
            queued_interactions == {"progress", "approval", "ask"},
            f"Python UI queue changed process interactions: {queued_interactions}",
        )

        native_ask_at = len(raw_frames)
        native_operation_id = client.prompt("exercise the official native AskTool")
        require(native_operation_id is not None, "native Ask prompt omitted operation id")
        native_request = wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "extension_ui_request"
            and frame.get("method") == "ask"
            and any(
                isinstance(question, dict)
                and question.get("id") == "native-ask-question"
                for question in frame.get("questions", [])
            ),
            "Python native AskTool request",
            after=native_ask_at,
        )
        wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "interaction_settled"
            and frame.get("id") == native_request.get("id")
            and isinstance(frame.get("outcome"), dict)
            and frame["outcome"].get("state") == "accepted",
            "Python native AskTool settlement",
            after=native_ask_at,
        )
        native_tool_result = wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "tool_execution_end"
            and frame.get("toolCallId") == "rpc-native-ask-call"
            and frame.get("toolName") == "ask",
            "Python native AskTool result",
            after=native_ask_at,
        )
        require(
            "native-ask-answer" in json.dumps(native_tool_result),
            "native AskTool result omitted the selected answer",
        )
        wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "message_end"
            and "native-ask-verified:" in json.dumps(frame.get("message")),
            "Python provider verification of native AskTool result",
            after=native_ask_at,
        )
        wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "operation_completed"
            and frame.get("operationId") == native_operation_id,
            "Python native AskTool operation completion",
            after=native_ask_at,
        )
        context = client.get_context(
            max_sources=8,
            max_relations=16,
            max_content_bytes=2048,
        )
        require(context.snapshot.get("sessionId") is not None, "context projection omitted session identity")
        require(context.returned.sources <= 8, "context projection exceeded source bound")
        require(context.returned.relations <= 16, "context projection exceeded relation bound")
        require(context.returned.content_bytes <= 2048, "context projection exceeded content bound")

        opened_at = len(raw_frames)
        opened = client.open_session(snapshot=True)
        require(opened.snapshot is not None, "snapshot open omitted snapshot")
        require(opened.durable_cursor is not None, "snapshot open omitted durable cursor")
        open_response = wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "response"
            and frame.get("command") == "session_open",
            "Python session_open response",
            after=opened_at,
        )
        open_data = response_data(open_response, "session_open")
        mutation_at = len(raw_frames)
        absent = client.invoke_session(
            SessionCommand(
                kind="set_session_name",
                input={"name": "python-live-observation"},
                idempotency_key="python-process-absent",
            )
        )
        require(absent.outcome == "completed", "session mutation failed")
        require(not absent.has_result, "absent nested result was converted to explicit null")
        live = wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "session_observation"
            and frame.get("subscriptionId") == opened.subscription_id
            and isinstance(frame.get("observation"), dict)
            and frame["observation"].get("type") == "observation"
            and frame["observation"].get("replay") is False,
            "post-barrier live observation",
            after=mutation_at,
        )
        observation = live["observation"]
        watermark = open_data["watermark"]
        require(
            observation.get("epoch") == watermark.get("epoch")
            and isinstance(observation.get("sequence"), int)
            and observation["sequence"] > watermark.get("sequence", -1),
            "live observation did not follow watermark",
        )
        explicit_null = client.invoke_session(
            SessionCommand(kind="get_job", input={"jobId": "missing-process-job"})
        )
        require(explicit_null.outcome == "completed", "nullable session command failed")
        require(
            explicit_null.has_result and explicit_null.result == {"job": None},
            "explicit-null nested value was collapsed into absence",
        )
        reopened_at = len(raw_frames)
        reopened = client.open_session(snapshot=False, after_cursor=opened.durable_cursor)
        require(reopened.snapshot is None, "snapshot:false returned snapshot")
        reopen_response = wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "response"
            and frame.get("command") == "session_open",
            "Python snapshot:false open response",
            after=reopened_at,
        )
        reopen_data = response_data(reopen_response, "session_open")
        require(isinstance(reopen_data.get("watermark"), dict), "reopen omitted watermark")
        require(isinstance(reopen_data.get("durableCursor"), dict), "reopen omitted cursor")

        before_nonfinite = len(raw_frames)
        try:
            client.request_raw("future_nonfinite", nested={"value": math.nan})
            raise AssertionError("nested NaN was accepted")
        except RpcError as error:
            require("valid JSON" in str(error), f"wrong nonfinite error: {error}")
        require(
            len(raw_frames) == before_nonfinite,
            "nonfinite payload reached the process before rejection",
        )

        future_at = len(raw_frames)
        try:
            client.request_raw("rpc_v99_future", future={"preserve": [1, None, "x"]})
            raise AssertionError("unknown command unexpectedly succeeded")
        except RpcCommandError as error:
            require(error.code == "unsupported_command", f"wrong future command error: {error}")
        future_error = wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "response"
            and frame.get("command") == "rpc_v99_future",
            "raw future-command response",
            after=future_at,
        )
        require(future_error.get("code") == "unsupported_command", "raw listener changed error")
        require(client.get_capabilities().application_api_version > 0, "process died after future command")

        eval_at = len(raw_frames)
        operation_id = client.eval_execute("js", "console.log('python-progress-proof')", timeout=15)
        for _ in range(8):
            ui = client.next_ui_request(timeout=10.0)
            if ui.method == "confirm":
                break
        else:
            raise AssertionError("eval did not request confirmation")
        require(ui.operation_id == operation_id, "confirmation lost operation correlation")
        client.send_ui_confirmation(ui.id, True, operation_id=operation_id)
        terminal = wait_frame(
            raw_frames,
            lambda frame: frame.get("operationId") == operation_id
            and frame.get("type") in {"operation_completed", "operation_failed"},
            "Python eval terminal",
            after=eval_at,
            timeout=30.0,
        )
        require(terminal.get("type") == "operation_completed", f"eval failed: {terminal}")
        require(
            any(
                frame.get("type") == "eval_output"
                and frame.get("operationId") == operation_id
                and "python-progress-proof" in str(frame.get("chunk"))
                for frame in raw_frames[eval_at:]
            ),
            "Python raw listener missed eval progress/output",
        )
        require(
            sum(
                1
                for frame in raw_frames[eval_at:]
                if frame.get("operationId") == operation_id
                and frame.get("type")
                in {"operation_completed", "operation_cancelled", "operation_failed"}
            )
            == 1,
            "eval emitted more than one terminal",
        )

        artifact_at = len(raw_frames)
        artifact_output = ("p" * 400_000) + "\n"
        artifact_operation = client.eval_execute(
            "js",
            "console.log('p'.repeat(400000))",
            title="python lossless artifact",
            timeout=30,
        )
        artifact_ui = client.next_ui_request(timeout=10.0)
        require(
            artifact_ui.method == "confirm"
            and artifact_ui.operation_id == artifact_operation,
            "artifact eval confirmation lost correlation",
        )
        client.send_ui_confirmation(
            artifact_ui.id, True, operation_id=artifact_operation
        )
        artifact_complete = wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "eval_complete"
            and frame.get("operationId") == artifact_operation,
            "Python artifact eval completion",
            after=artifact_at,
            timeout=45.0,
        )
        artifact_result = artifact_complete.get("result")
        if not isinstance(artifact_result, dict):
            raise AssertionError("artifact eval result is not an object")
        descriptor = artifact_result.get("artifact")
        if not isinstance(descriptor, dict):
            raise AssertionError("oversized eval omitted artifact descriptor")
        artifact_id = descriptor.get("id")
        if not isinstance(artifact_id, str):
            raise AssertionError("artifact descriptor omitted id")
        require(
            artifact_result.get("truncated") is True
            and isinstance(artifact_result.get("artifactRef"), str),
            "oversized eval omitted truncation metadata",
        )
        reconstructed = bytearray()
        offset = 0
        while True:
            artifact_range = client.read_artifact(
                artifact_id, offset=offset, length=32_767
            )
            chunk = base64.b64decode(artifact_range.data, validate=True)
            require(artifact_range.offset == offset, "artifact range offset changed")
            require(
                artifact_range.byte_length == len(chunk),
                "artifact range byte length changed",
            )
            reconstructed.extend(chunk)
            offset += len(chunk)
            if artifact_range.eof:
                break
            require(len(chunk) > 0, "nonterminal artifact range made no progress")
        require(
            bytes(reconstructed) == artifact_output.encode(),
            "artifact range reconstruction was not byte-exact",
        )

        cancel_at = len(raw_frames)
        cancel_operation = client.eval_execute(
            "js",
            "await Bun.sleep(30000); console.log('late-python-output')",
            title="python active cancellation",
            timeout=60,
        )
        cancel_ui = client.next_ui_request(timeout=10.0)
        require(
            cancel_ui.method == "confirm"
            and cancel_ui.operation_id == cancel_operation,
            "cancellation eval confirmation lost correlation",
        )
        client.send_ui_confirmation(
            cancel_ui.id, True, operation_id=cancel_operation
        )
        wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "operation_started"
            and frame.get("operationId") == cancel_operation,
            "Python active operation start",
            after=cancel_at,
        )
        cancelled = client.cancel_operation(cancel_operation)
        require(
            cancelled.status in {"cancelling", "cancelled"},
            f"active cancellation was not accepted: {cancelled}",
        )
        wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "operation_cancelled"
            and frame.get("operationId") == cancel_operation,
            "Python active operation cancellation",
            after=cancel_at,
            timeout=30.0,
        )
        require(
            sum(
                1
                for frame in raw_frames[cancel_at:]
                if frame.get("operationId") == cancel_operation
                and frame.get("type")
                in {"operation_completed", "operation_cancelled", "operation_failed"}
            )
            == 1,
            "Python cancellation emitted more than one terminal",
        )

        shutdown_at = len(raw_frames)
        settlement = client.shutdown_session()
        require(settlement.state == "settled", "Python shutdown did not settle")
        shutdown_response = wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "response"
            and frame.get("command") == "session_shutdown",
            "Python shutdown response",
            after=shutdown_at,
        )
        final_observation = wait_frame(
            raw_frames,
            lambda frame: frame.get("type") == "session_observation"
            and frame.get("subscriptionId") == reopened.subscription_id
            and isinstance(frame.get("observation"), dict)
            and frame["observation"].get("type") == "observation"
            and frame["observation"].get("kind") == "session_settled",
            "Python final shutdown observation",
            after=shutdown_at,
        )
        require(
            raw_frames.index(final_observation) < raw_frames.index(shutdown_response),
            "Python shutdown settled before its final observation",
        )
        require(
            sum(
                1
                for frame in raw_frames[cancel_at:]
                if frame.get("operationId") == cancel_operation
                and frame.get("type")
                in {"operation_completed", "operation_cancelled", "operation_failed"}
            )
            == 1,
            "Python cancellation emitted a late second terminal",
        )
        require(raw_frames[-1] is shutdown_response, "Python shutdown response was not final")
    finally:
        client.stop()

    package_path = Path(__import__("omp_rpc").__file__).resolve()
    require("site-packages" in package_path.parts, f"package was not installed: {package_path}")
    print(
        json.dumps(
            {
                "binary": binary,
                "package": str(package_path),
                "logicalFrames": len(raw_frames),
                "framingVersion": 2,
                "stderr": client.stderr,
            },
            allow_nan=False,
        )
    )


if __name__ == "__main__":
    main()

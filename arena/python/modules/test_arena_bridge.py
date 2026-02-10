from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List

AiCallback = Callable[[Dict[str, Any], List[Dict[str, Any]], Dict[str, Any]], List[Dict[str, Any]]]


def _http_json(method: str, url: str, payload: Dict[str, Any] | None = None, timeout_s: float = 10.0) -> Dict[str, Any]:
    data = None
    headers = {"content-type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url=url, method=method, headers=headers, data=data)
    with urllib.request.urlopen(req, timeout=timeout_s) as res:
        raw = res.read().decode("utf-8")
        if not raw:
            return {}
        return json.loads(raw)


class TestArenaBridgeClient:
    def __init__(
        self,
        base_url: str,
        client_id: str,
        callback: AiCallback,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.callback = callback
        self.ctx: Dict[str, Any] = {"steps": 0}

    def connect(self) -> Dict[str, Any]:
        return _http_json("POST", f"{self.base_url}/__pyai/connect", {"clientId": self.client_id})

    def heartbeat(self) -> Dict[str, Any]:
        return _http_json("POST", f"{self.base_url}/__pyai/heartbeat", {"clientId": self.client_id})

    def disconnect(self) -> Dict[str, Any]:
        return _http_json("POST", f"{self.base_url}/__pyai/disconnect", {"clientId": self.client_id})

    def poll_next(self) -> Dict[str, Any]:
        q = urllib.parse.urlencode({"clientId": self.client_id})
        return _http_json("GET", f"{self.base_url}/__pyai/next?{q}")

    def respond(self, request_id: str, commands: List[Dict[str, Any]], errors: List[str] | None = None) -> Dict[str, Any]:
        return _http_json(
            "POST",
            f"{self.base_url}/__pyai/respond/{urllib.parse.quote(request_id)}",
            {
                "clientId": self.client_id,
                "commands": commands,
                "errors": errors or [],
            },
        )

    def run_forever(self, poll_interval_s: float = 0.02, heartbeat_interval_s: float = 5.0) -> None:
        self.connect()
        last_heartbeat = 0.0
        try:
            while True:
                now = time.time()
                if now - last_heartbeat >= heartbeat_interval_s:
                    self.heartbeat()
                    last_heartbeat = now

                next_payload = self.poll_next()
                request_obj = next_payload.get("request")
                if not request_obj:
                    time.sleep(poll_interval_s)
                    continue

                request_id = str(request_obj.get("id", ""))
                payload = request_obj.get("payload", {})
                snapshot_block = payload.get("snapshot", {})
                snapshot = snapshot_block.get("state", snapshot_block)
                pending_units = payload.get("pendingUnits", [])

                try:
                    commands = self.callback(snapshot, pending_units, self.ctx) or []
                    self.respond(request_id, commands, [])
                except Exception as err:
                    self.respond(request_id, [], [f"callback_error: {err}"])
                self.ctx["steps"] = int(self.ctx.get("steps", 0)) + 1
        finally:
            try:
                self.disconnect()
            except Exception:
                pass

"""HTTP bridge client for browser Test Arena <-> Python AI callbacks.

This module connects to the Vite dev middleware endpoints under ``/__pyai/*``.
It continuously polls decision requests emitted by the browser Test Arena UI,
executes a Python callback, and returns per-unit commands back to the browser.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List

AiCallback = Callable[[Dict[str, Any], List[Dict[str, Any]], Dict[str, Any]], List[Dict[str, Any]]]


def _http_json(method: str, url: str, payload: Dict[str, Any] | None = None, timeout_s: float = 10.0) -> Dict[str, Any]:
    """Execute one HTTP request and parse JSON response.

    Args:
        method: HTTP method (for example ``"GET"`` or ``"POST"``).
        url: Absolute request URL.
        payload: Optional dictionary serialized as JSON request body.
        timeout_s: Socket timeout in seconds.

    Returns:
        Parsed JSON response dictionary. Empty dict when response body is empty.

    Raises:
        urllib.error.URLError / HTTPError: Network and HTTP errors.
        json.JSONDecodeError: Invalid JSON response body.
    """
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
    """Long-running bridge client for Test Arena external AI.

    The client lifecycle is:
    1. ``connect()``
    2. periodic ``heartbeat()``
    3. poll ``poll_next()`` for pending requests
    4. run callback on each request
    5. ``respond()`` with commands or callback error
    6. ``disconnect()`` on shutdown
    """

    def __init__(
        self,
        base_url: str,
        client_id: str,
        callback: AiCallback,
    ) -> None:
        """Initialize a bridge session object.

        Args:
            base_url: Dev server base URL (for example ``http://localhost:5173``).
            client_id: Stable client identifier shown in browser status.
            callback: Policy function receiving ``(snapshot, pending_units, ctx)``.
        """
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.callback = callback
        self.ctx: Dict[str, Any] = {"steps": 0}

    def connect(self) -> Dict[str, Any]:
        """Register this bridge client with the dev server broker."""
        return _http_json("POST", f"{self.base_url}/__pyai/connect", {"clientId": self.client_id})

    def heartbeat(self) -> Dict[str, Any]:
        """Send keepalive so browser status remains connected."""
        return _http_json("POST", f"{self.base_url}/__pyai/heartbeat", {"clientId": self.client_id})

    def disconnect(self) -> Dict[str, Any]:
        """Unregister this bridge client from the broker."""
        return _http_json("POST", f"{self.base_url}/__pyai/disconnect", {"clientId": self.client_id})

    def poll_next(self) -> Dict[str, Any]:
        """Fetch next pending AI request for this client.

        Returns:
            Response with ``request`` key. ``request`` is ``null`` when queue is empty.
        """
        q = urllib.parse.urlencode({"clientId": self.client_id})
        return _http_json("GET", f"{self.base_url}/__pyai/next?{q}")

    def respond(self, request_id: str, commands: List[Dict[str, Any]], errors: List[str] | None = None) -> Dict[str, Any]:
        """Submit callback result for one broker request.

        Args:
            request_id: Broker request identifier.
            commands: List of unit command dictionaries.
            errors: Optional list of textual errors produced by callback logic.
        """
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
        """Run bridge event loop until interrupted.

        Behavior:
        - Maintains periodic heartbeat.
        - Polls for new broker requests.
        - Extracts ``snapshot`` and ``pendingUnits`` payload fields.
        - Executes callback and returns commands.
        - Captures callback exceptions and reports them as broker errors.

        Args:
            poll_interval_s: Sleep duration when no request is pending.
            heartbeat_interval_s: Keepalive interval.
        """
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

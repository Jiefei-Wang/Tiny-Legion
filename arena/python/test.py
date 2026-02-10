from arena.python.modules.example_baseline_ai import baseline_ai_callback
from arena.python.modules.test_arena_bridge import TestArenaBridgeClient

bridge = TestArenaBridgeClient(
    base_url="http://localhost:5173",
    client_id="py-baseline-1",
    callback=baseline_ai_callback,
)
bridge.run_forever()


# bridge.connect()
# bridge.heartbeat()
# next_payload = bridge.poll_next()
# request_obj = next_payload.get("request")

# request_id = str(request_obj.get("id", ""))
# payload = request_obj.get("payload", {})
# snapshot_block = payload.get("snapshot", {})
# snapshot = snapshot_block.get("state", snapshot_block)
# pending_units = payload.get("pendingUnits", [])


# snapshot.keys()
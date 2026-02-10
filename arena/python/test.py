from arena.python.modules.example_baseline_ai import baseline_ai_callback
from arena.python.modules.test_arena_bridge import TestArenaBridgeClient

bridge = TestArenaBridgeClient(
    base_url="http://localhost:5173",
    client_id="py-baseline-1",
    callback=baseline_ai_callback,
)
bridge.run_forever()

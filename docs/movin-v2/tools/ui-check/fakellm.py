# Local stand-in for the UI check: answers both the OpenAI-compatible API
# (/v1/models, /v1/chat/completions) and Claude's (/v1/models, /v1/messages).
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
MODELS = ["stub-openai-model", "claude-opus-5-5", "claude-sonnet-5-5"]
class H(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/v1/models"):
            return self._send({"data": [{"id": m, "type": "model"} for m in MODELS], "has_more": False})
        self._send({"error": {"message": "not found"}}, 404)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); self.rfile.read(n)
        if self.path == "/v1/chat/completions":
            return self._send({"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "set_dates", "arguments": "{\"move_in\":\"2026-12-05\"}"}}]}, "finish_reason": "tool_calls"}]})
        if self.path == "/v1/messages":
            return self._send({"id": "m", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "stop_reason": "tool_use",
                               "content": [{"type": "tool_use", "id": "toolu_1", "name": "set_dates", "input": {"move_in": "2026-12-05"}}],
                               "usage": {"input_tokens": 5, "output_tokens": 5}})
        self._send({"error": {"message": "not found"}}, 404)
ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), H).serve_forever()

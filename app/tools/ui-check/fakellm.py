# Local stand-in for the UI check: answers the OpenAI-compatible API
# (/v1/models, /v1/chat/completions). v2 has no Claude path, so /v1/messages is
# gone (plan.md T2.3).
#
# For the chat check (T3.5) it plays a model that records one entry and then
# answers: the settings probe and a fresh message both get a tool call, and the
# model's reply to the tool result is the sentence the page check asserts. It
# streams when the request asks for it, because the app's own client always does.
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = ["stub-openai-model"]
SAVED_TITLE = "UI check: chat note"
REPLY = "Saved it. Anything else?"


class H(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _stream(self, message):
        events = [{"choices": [{"delta": {"role": "assistant", "content": message.get("content", "")}}]},
                  {"choices": [{"delta": {}, "finish_reason": "tool_calls" if message.get("tool_calls") else "stop"}]}]
        if message.get("tool_calls"):
            events.insert(0, {"choices": [{"delta": {"tool_calls": message["tool_calls"]}}]})
        body = "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"
        raw = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            return self._send({"data": [{"id": m, "type": "model"} for m in MODELS], "has_more": False})
        self._send({"error": {"message": "not found"}}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        if self.path != "/v1/chat/completions":
            return self._send({"error": {"message": "not found"}}, 404)
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = {}
        messages = body.get("messages") or []
        last = messages[-1] if messages else {}
        if body.get("tool_choice") == "none" or last.get("role") == "tool":
            message = {"role": "assistant", "content": REPLY if last.get("role") == "tool" else "Done."}
        else:
            # One entry, so the page shows a change row with its Undo, and the
            # settings probe sees the tool_calls it insists on.
            message = {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "add_entry",
                        "arguments": json.dumps({"entries": [{"kind": "note", "title": SAVED_TITLE}]}),
                    },
                }],
            }
        if body.get("stream"):
            return self._stream(message)
        self._send({"choices": [{"message": message, "finish_reason": "tool_calls" if message.get("tool_calls") else "stop"}]})


ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), H).serve_forever()

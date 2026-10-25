"""
The real HTTP clients talking to a local mock server that speaks the Anthropic Messages API and the
OpenAI Chat Completions API formats. (No real provider is contacted.)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import _shared  # noqa: F401  (sys.path)

from rag_chatbot.config import Settings
from rag_chatbot.llm import AnthropicClient, LLMError, Message, OpenAICompatibleClient, build_client


class _Handler(BaseHTTPRequestHandler):
    calls = []
    fail_next = []          # list of status codes to return before succeeding

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _Handler.calls.append({"path": self.path, "headers": dict(self.headers), "body": body})
        if _Handler.fail_next:
            code = _Handler.fail_next.pop(0)
            self.send_response(code)
            self.end_headers()
            self.wfile.write(b'{"error": "mock failure"}')
            return
        if self.path == "/v1/messages":
            if self.headers.get("x-api-key") != "good-key":
                self.send_response(401); self.end_headers(); self.wfile.write(b'{"error":"bad key"}'); return
            out = {"content": [{"type": "text", "text": f"anthropic says: {body['messages'][-1]['content'][:20]}"}],
                   "stop_reason": "end_turn"}
        elif self.path == "/v1/chat/completions":
            out = {"choices": [{"message": {"role": "assistant", "content": f"openai says: {body['messages'][0]['role']}"}}]}
        else:
            self.send_response(404); self.end_headers(); return
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class LLMHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), _Handler)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        _Handler.calls.clear()
        _Handler.fail_next.clear()

    def _session(self):
        import requests
        s = requests.Session()
        s.trust_env = False        # ignore any HTTPS_PROXY in the environment for the local mock
        return s

    def test_anthropic_request_format_and_parse(self):
        c = AnthropicClient("good-key", "claude-test", self.url, max_retries=0, session=self._session())
        out = c.generate("SYS", [Message("user", "hello there")])
        self.assertEqual(out, "anthropic says: hello there")
        call = _Handler.calls[-1]
        self.assertEqual(call["body"]["system"], "SYS")
        self.assertEqual(call["body"]["model"], "claude-test")
        self.assertEqual(call["headers"]["anthropic-version"], "2023-06-01")

    def test_anthropic_bad_key_is_friendly_and_not_retried(self):
        c = AnthropicClient("bad", "m", self.url, max_retries=2, session=self._session())
        with self.assertRaises(LLMError) as cm:
            c.generate("s", [Message("user", "x")])
        self.assertIn("API key", str(cm.exception))
        self.assertEqual(len(_Handler.calls), 1)

    def test_retry_on_server_error(self):
        _Handler.fail_next[:] = [503]
        c = AnthropicClient("good-key", "m", self.url, max_retries=1, session=self._session())
        c_time = __import__("time")
        orig = c_time.sleep
        c_time.sleep = lambda s: None
        try:
            self.assertTrue(c.generate("s", [Message("user", "retry")]).startswith("anthropic says"))
        finally:
            c_time.sleep = orig
        self.assertEqual(len(_Handler.calls), 2)

    def test_openai_compatible(self):
        c = OpenAICompatibleClient("k", "gpt-test", self.url + "/v1", max_retries=0, session=self._session())
        self.assertEqual(c.generate("SYS", [Message("user", "q")]), "openai says: system")
        self.assertEqual(_Handler.calls[-1]["headers"]["Authorization"], "Bearer k")

    def test_build_client_selection(self):
        self.assertIsNone(build_client(Settings(llm_provider="auto")))
        self.assertIsInstance(build_client(Settings(llm_provider="auto", anthropic_api_key="x")), AnthropicClient)
        self.assertIsInstance(build_client(Settings(llm_provider="auto", openai_api_key="x")), OpenAICompatibleClient)
        with self.assertRaises(LLMError):
            build_client(Settings(llm_provider="anthropic"))
        with self.assertRaises(LLMError):
            build_client(Settings(llm_provider="banana"))

    def test_chat_engine_end_to_end_over_http(self):
        from _shared import services
        c = AnthropicClient("good-key", "claude-test", self.url, max_retries=0, session=self._session())
        res = services(c).answer("What should we do about PF001 ANSYS?", [])
        self.assertEqual(res.llm_used, "Anthropic (claude-test)")
        self.assertTrue(res.answer.startswith("anthropic says: CONTEXT:"))
        body = _Handler.calls[-1]["body"]
        self.assertIn("Never invent numbers", body["system"])
        self.assertIn("PF001 / SW003", body["messages"][-1]["content"])

    def test_unreachable_server(self):
        c = OpenAICompatibleClient("k", "m", "http://127.0.0.1:9", max_retries=0, timeout=2, session=self._session())
        with self.assertRaises(LLMError) as cm:
            c.generate("s", [Message("user", "x")])
        self.assertIn("connect", str(cm.exception).lower())


if __name__ == "__main__":
    unittest.main()

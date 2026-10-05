import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/files":
            files = []
            for name in sorted(os.listdir(ROOT)):
                if name.lower().endswith(".csv"):
                    files.append(name)
            payload = json.dumps(files).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        if path == "/api/data":
            file_name = query.get("file", [None])[0]
            if not file_name:
                self.send_response(400)
                self.end_headers()
                return
            safe_path = os.path.join(ROOT, os.path.basename(file_name))
            if not os.path.isfile(safe_path):
                self.send_response(404)
                self.end_headers()
                return
            with open(safe_path, "r", encoding="utf-8") as f:
                data = f.read().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        file_path = path.lstrip("/") or "index.html"
        if file_path.startswith("api/"):
            file_path = "index.html"
        full_path = os.path.join(ROOT, file_path)

        if not os.path.isfile(full_path):
            self.send_response(404)
            self.end_headers()
            return

        content_type = "text/html; charset=utf-8"
        if full_path.endswith(".css"):
            content_type = "text/css; charset=utf-8"
        elif full_path.endswith(".js"):
            content_type = "application/javascript; charset=utf-8"

        with open(full_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    port = 8000
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Dashboard is running at http://localhost:{port}")
    server.serve_forever()

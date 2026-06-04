"""Static dev server with SPA fallback.

Plain `python3 -m http.server` returns its own 404 for unknown paths, so a
direct visit / refresh on /history would fail even though 404.html is right
there. This wrapper serves 404.html for any non-existent path, matching
GitHub Pages behaviour so we can test the routing locally.
"""
import http.server
import os
import socketserver
import sys


class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path.split("?", 1)[0])
        if not os.path.exists(path):
            self.path = "/404.html"
        return super().send_head()


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    with ReusableServer(("", port), SPAHandler) as httpd:
        print(f"Serving on http://localhost:{port}/  (Ctrl+C to stop)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()

"""
Visualization Web Server (Python standard http.server zero-dependency solution).
Serves the web dashboard from visualization/public and audio files from data/input.
Runs on http://localhost:3000
"""

import os
import sys
import http.server
import socketserver

PORT = 3000
VISUALIZATION_DIR = os.path.abspath(os.path.dirname(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(VISUALIZATION_DIR, ".."))
PUBLIC_DIR = os.path.join(VISUALIZATION_DIR, "public")
DATA_INPUT_DIR = os.path.join(PROJECT_ROOT, "data", "input")


class CustomHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Route audio file requests /audio/filename -> data/input/filename
        if path.startswith("/audio/"):
            audio_filename = path.replace("/audio/", "")
            return os.path.join(DATA_INPUT_DIR, audio_filename)
        # Route all static web files to visualization/public/
        req_file = path.lstrip("/")
        if not req_file or req_file == "index.html":
            return os.path.join(PUBLIC_DIR, "index.html")
        return os.path.join(PUBLIC_DIR, req_file)

    def end_headers(self):
        # Add CORS and no-cache headers for easy local debugging
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def run_server():
    os.chdir(PUBLIC_DIR)
    handler = CustomHTTPRequestHandler
    with ReusableTCPServer(("", PORT), handler) as httpd:
        print(f"\n========================================================")
        print(f"🚀 SoundCount Visualization Dashboard is running at:")
        print(f"👉 http://localhost:{PORT}")
        print(f"========================================================\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    run_server()

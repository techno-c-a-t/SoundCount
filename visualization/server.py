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

    def do_POST(self):
        if self.path == "/api/save_taps":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            save_path = os.path.join(DATA_INPUT_DIR, "user_taps.json")
            with open(save_path, "wb") as f:
                f.write(post_data)
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b'{"status": "ok", "message": "User taps saved successfully!"}')
            print(f" Saved user tap recording to: {save_path}")
            return
        
        self.send_error(444, "Invalid endpoint")

    def end_headers(self):
        # Add CORS and no-cache headers for easy local debugging
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


import socket


def get_local_ip():
    """Detects primary local IP address (Wi-Fi hotspot / LAN)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except Exception:
        return "127.0.0.1"


def run_server():
    os.chdir(PUBLIC_DIR)
    local_ip = get_local_ip()
    handler = CustomHTTPRequestHandler
    with ReusableTCPServer(("", PORT), handler) as httpd:
        print(f"\n========================================================")
        print(f"🚀 SoundCount Mobile Game & DSP Server is running!")
        print(f"👉 ПК (локально):  http://localhost:{PORT}")
        print(f"📱 ТЕЛЕФОН (ТД):   http://{local_ip}:{PORT}")
        print(f"========================================================\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    run_server()

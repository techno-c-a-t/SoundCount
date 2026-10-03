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
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)
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

    def do_GET(self):
        if self.path.startswith("/api/filter_audio"):
            import json
            from urllib.parse import urlparse, parse_qs
            query = parse_qs(urlparse(self.path).query)
            try:
                f_low = float(query.get("low", [20])[0])
                f_high = float(query.get("high", [11025])[0])

                if f_low == 30 and f_high == 250:
                    url = "/audio/test_music_bass.wav"
                elif f_low == 250 and f_high == 2500:
                    url = "/audio/test_music_mids.wav"
                elif f_low == 2500 and f_high >= 11000:
                    url = "/audio/test_music_highs.wav"
                elif f_low <= 25 and f_high >= 11000:
                    url = "/audio/test_music.mp3"
                else:
                    out_name = f"custom_{int(f_low)}_{int(f_high)}.wav"
                    out_path = os.path.join(DATA_INPUT_DIR, out_name)
                    if not os.path.exists(out_path):
                        from src.preprocessing import load_audio, save_wav, apply_bandpass_filter
                        input_file = os.path.join(DATA_INPUT_DIR, "test_music.mp3")
                        y, sr, _ = load_audio(input_file)
                        y_filt = apply_bandpass_filter(y, sr, f_low, f_high, order=6)
                        save_wav(y_filt, out_path, sr)
                    url = f"/audio/{out_name}"

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok", "url": url}).encode("utf-8"))
                return
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
                return

        super().do_GET()

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

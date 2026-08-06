from __future__ import annotations

import http.server
import os
import socketserver
import threading
import webbrowser
from pathlib import Path

PORT = 8000
ROOT = Path(__file__).resolve().parent


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True


def main() -> None:
    os.chdir(ROOT)
    threading.Timer(0.7, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    try:
        with ReusableServer(("", PORT), http.server.SimpleHTTPRequestHandler) as server:
            print(f"AirDraw iniciado em http://localhost:{PORT}")
            print("Pressione Ctrl+C para encerrar.")
            server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")


if __name__ == "__main__":
    main()

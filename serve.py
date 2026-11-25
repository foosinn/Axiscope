"""Run Axiscope on http://localhost:3000 straight from GitHub, no clone needed:

python3 -c "import urllib.request as u; exec(u.urlopen('https://raw.githubusercontent.com/foosinn/Axiscope/main/serve.py').read())"

GitHub serves raw files as text/plain, so browsers won't run them directly.
This server fetches each file from GitHub and serves it with the right type.
The page runs on localhost, so the browser allows local cameras.
"""
import http.server
import urllib.error
import urllib.request
import webbrowser

BASE = 'https://raw.githubusercontent.com/foosinn/Axiscope/main'
PORT = 3000
TYPES = {
    'html': 'text/html; charset=utf-8',
    'js': 'text/javascript; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'png': 'image/png',
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            path = '/index.html'
        kind = path.rsplit('.', 1)[-1]
        if kind not in TYPES or '..' in path:
            return self.send_error(404)
        try:
            body = urllib.request.urlopen(BASE + path, timeout=10).read()
        except urllib.error.HTTPError as e:
            return self.send_error(e.code)
        except urllib.error.URLError as e:
            return self.send_error(502, str(e))
        self.send_response(200)
        self.send_header('Content-Type', TYPES[kind])
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


try:
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
except OSError:
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
url = f'http://localhost:{server.server_address[1]}'
print(f'Axiscope runs on {url} (Ctrl+C to stop)')
webbrowser.open(url)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass

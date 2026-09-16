#!/usr/bin/env python3
"""
Run from Terminal: python3 /Users/johnskead/Desktop/Dashboard/get-refresh-token.py
Opens a browser, you authorize with Google, and your refresh token prints in the terminal.
"""

import json, urllib.parse, urllib.request, http.server, threading, webbrowser, os

secret_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'client_secret.json')
with open(secret_path) as f:
    creds = json.load(f).get('installed') or json.load(f).get('web')

CLIENT_ID     = creds['client_id']
CLIENT_SECRET = creds['client_secret']
REDIRECT_URI  = 'http://localhost:3000'
SCOPE         = 'https://mail.google.com/'

auth_url = (
    'https://accounts.google.com/o/oauth2/v2/auth'
    f'?client_id={urllib.parse.quote(CLIENT_ID)}'
    f'&redirect_uri={urllib.parse.quote(REDIRECT_URI)}'
    f'&response_type=code'
    f'&scope={urllib.parse.quote(SCOPE)}'
    f'&access_type=offline'
    f'&prompt=consent'
)

print('\n── Gmail Refresh Token Setup ──────────────────')
print('\nOpening browser... if it does not open, paste this URL manually:\n')
print(auth_url)
print('\nWaiting for Google to redirect back...\n')

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        code   = params.get('code', [None])[0]
        error  = params.get('error', [None])[0]

        self.send_response(200)
        self.end_headers()

        if error:
            self.wfile.write(f'<h2>Error: {error}</h2>'.encode())
            print(f'\nError: {error}\n')
            threading.Thread(target=self.server.shutdown).start()
            return

        if not code:
            self.wfile.write(b'Waiting...')
            return

        self.wfile.write(b'<html><body style="font-family:sans-serif;padding:40px"><h2>&#x2705; Done! Check your terminal for the refresh token.</h2></body></html>')

        data = urllib.parse.urlencode({
            'code':          code,
            'client_id':     CLIENT_ID,
            'client_secret': CLIENT_SECRET,
            'redirect_uri':  REDIRECT_URI,
            'grant_type':    'authorization_code',
        }).encode()

        req = urllib.request.Request(
            'https://oauth2.googleapis.com/token', data=data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'}
        )
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read())

        if 'refresh_token' in tokens:
            print('── Copy this into Railway ─────────────────────\n')
            print(f"GMAIL_REFRESH_TOKEN={tokens['refresh_token']}\n")
            print('GMAIL_USER=<the Google account you just authorized>')
            print('\n───────────────────────────────────────────────\n')
        else:
            print('\nNo refresh_token returned.')
            print('Go to https://myaccount.google.com/permissions')
            print('remove the app, then run this script again.\n')

        threading.Thread(target=self.server.shutdown).start()

    def log_message(self, *args):
        pass

webbrowser.open(auth_url)
server = http.server.HTTPServer(('localhost', 3000), Handler)
server.serve_forever()

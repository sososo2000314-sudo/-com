
#!/usr/bin/env python3
"""Japan Connect - starter server. Uses DATABASE_URL (PostgreSQL) when configured."""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import mimetypes
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

ROOT = Path(__file__).resolve().parent
DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()
PORT = int(os.environ.get('PORT', '10000'))
MAX_BODY = 2 * 1024 * 1024

try:
    import psycopg
    from psycopg.rows import dict_row
except Exception:
    psycopg = None
    dict_row = None


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def clean_text(value, limit=10000):
    if value is None:
        return ''
    return str(value).strip()[:limit]


def make_password(password):
    salt = secrets.token_bytes(16)
    rounds = 310000
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, rounds)
    return f'pbkdf2_sha256${rounds}${salt.hex()}${digest.hex()}'


def check_password(password, stored):
    try:
        _, rounds, salt_hex, digest_hex = stored.split('$', 3)
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt_hex), int(rounds)).hex()
        return hmac.compare_digest(actual, digest_hex)
    except Exception:
        return False


class DB:
    def __init__(self):
        self.pg = bool(DATABASE_URL and psycopg)
        if DATABASE_URL and not psycopg:
            print('WARNING: DATABASE_URL is set but psycopg is unavailable; using local SQLite.', flush=True)
        self.sqlite_path = os.environ.get('SQLITE_PATH', str(ROOT / 'japan_connect.db'))
        self.init_schema()

    def connect(self):
        if self.pg:
            return psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=False)
        conn = sqlite3.connect(self.sqlite_path, timeout=20)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        return conn

    def execute(self, conn, sql, params=()):
        if self.pg:
            sql = sql.replace('?', '%s')
            cur = conn.cursor()
            cur.execute(sql, params)
            return cur
        return conn.execute(sql, params)

    def init_schema(self):
        conn = self.connect()
        try:
            if self.pg:
                statements = [
                    "CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS posts (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS likes (user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(user_id,post_id))",
                    "CREATE TABLE IF NOT EXISTS comments (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, from_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, deleted_by_sender INTEGER NOT NULL DEFAULT 0, deleted_by_recipient INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"
                ]
            else:
                statements = [
                    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS likes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(user_id,post_id))",
                    "CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, deleted_by_sender INTEGER NOT NULL DEFAULT 0, deleted_by_recipient INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"
                ]
            for statement in statements:
                self.execute(conn, statement)
            conn.commit()
        finally:
            conn.close()

DBH = DB()


def rowdict(row):
    return dict(row) if row is not None else None


class Handler(BaseHTTPRequestHandler):
    server_version = 'JapanConnect/1.0'

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args), flush=True)

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise ValueError('リクエストサイズが不正です')
        if size > MAX_BODY:
            raise OverflowError('送信データが大きすぎます')
        raw = self.rfile.read(size) if size else b'{}'
        try:
            data = json.loads(raw.decode('utf-8'))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except Exception:
            raise ValueError('送信データの形式が正しくありません')

    def db(self):
        return DBH.connect()

    def query(self, conn, sql, params=()):
        return DBH.execute(conn, sql, params)

    def current_user(self, conn):
        auth = self.headers.get('Authorization', '')
        token = auth[7:].strip() if auth.lower().startswith('bearer ') else ''
        if not token:
            return None
        row = self.query(conn, 'SELECT u.id,u.username,u.display_name,u.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', (token,)).fetchone()
        return rowdict(row)

    def require_user(self, conn):
        user = self.current_user(conn)
        if not user:
            self.send_json(401, {'error':'ログインしてください'})
            return None
        return user

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith('/api/'):
            self.api_get(path, parse_qs(parsed.query))
        else:
            self.static_get(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith('/api/'):
            self.send_json(404, {'error':'ページが見つかりません'}); return
        self.api_post(path)

    def do_PATCH(self):
        path = urlparse(self.path).path
        if path != '/api/me':
            self.send_json(404, {'error':'ページが見つかりません'}); return
        self.api_patch_me()

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith('/api/'):
            self.api_delete(path)
        else:
            self.send_json(404, {'error':'ページが見つかりません'})

    def static_get(self, path):
        if path == '/': path = '/index.html'
        mapping = {'/index.html': ROOT / 'index.html', '/style.css': ROOT / 'style.css', '/app.js': ROOT / 'app.js'}
        file_path = mapping.get(path)
        if not file_path or not file_path.is_file():
            self.send_error(404, 'Not Found'); return
        content = file_path.read_bytes()
        ctype = mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript',): ctype += '; charset=utf-8'
        self.send_response(200); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(content))); self.send_header('X-Content-Type-Options','nosniff'); self.end_headers(); self.wfile.write(content)

    def api_get(self, path, query):
        conn = self.db()
        try:
            if path == '/api/me':
                user = self.require_user(conn)
                if user: self.send_json(200, {'user':user})
                return
            if path == '/api/posts':
                user = self.require_user(conn)
                if not user: return
                rows = self.query(conn, "SELECT p.id,p.user_id,p.kind,p.title,p.body,p.url,p.created_at,u.username,u.display_name,(SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS likes_count,(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comments_count,EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id=p.id AND l2.user_id=?) AS liked_by_me FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 300", (user['id'],)).fetchall()
                self.send_json(200, {'posts':[rowdict(r) for r in rows]}); return
            if path == '/api/users':
                user = self.require_user(conn)
                if not user: return
                q = clean_text((query.get('q') or [''])[0], 80).lower()
                rows = self.query(conn, "SELECT username,display_name,created_at FROM users WHERE lower(username) LIKE ? OR lower(display_name) LIKE ? ORDER BY username LIMIT 50", (f'%{q}%',f'%{q}%')).fetchall()
                self.send_json(200, {'users':[rowdict(r) for r in rows if r['username'] != user['username']]}); return
            if path == '/api/mail':
                user = self.require_user(conn)
                if not user: return
                box = (query.get('box') or ['inbox'])[0]
                if box == 'sent':
                    rows = self.query(conn, "SELECT m.id,m.subject,m.body,m.is_read,m.created_at,u.username AS to_username,(SELECT username FROM users WHERE id=m.from_user_id) AS from_username FROM messages m JOIN users u ON u.id=m.to_user_id WHERE m.from_user_id=? AND m.deleted_by_sender=0 ORDER BY m.id DESC LIMIT 300", (user['id'],)).fetchall()
                else:
                    rows = self.query(conn, "SELECT m.id,m.subject,m.body,m.is_read,m.created_at,u.username AS from_username,(SELECT username FROM users WHERE id=m.to_user_id) AS to_username FROM messages m JOIN users u ON u.id=m.from_user_id WHERE m.to_user_id=? AND m.deleted_by_recipient=0 ORDER BY m.id DESC LIMIT 300", (user['id'],)).fetchall()
                self.send_json(200, {'messages':[rowdict(r) for r in rows]}); return
            self.send_json(404, {'error':'APIが見つかりません'})
        except Exception as e:
            conn.rollback(); print('GET API error:', repr(e), flush=True); self.send_json(500, {'error':'サーバーでエラーが発生しました'})
        finally:
            conn.close()

    def api_post(self, path):
        try: data = self.read_json()
        except OverflowError as e: self.send_json(413, {'error':str(e)}); return
        except ValueError as e: self.send_json(400, {'error':str(e)}); return
        conn = self.db()
        try:
            if path == '/api/register':
                username = clean_text(data.get('username'),32)
                display = clean_text(data.get('display_name') or username,40)
                password = str(data.get('password') or '')
                if not re.fullmatch(r'[A-Za-z0-9_.-]{3,32}', username): self.send_json(400, {'error':'アカウント名は英数字、_、-、. の3〜32文字にしてください'}); return
                if len(password) < 8: self.send_json(400, {'error':'パスワードは8文字以上にしてください'}); return
                token = secrets.token_urlsafe(32)
                try:
                    cur = self.query(conn, 'INSERT INTO users(username,display_name,password_hash,created_at) VALUES(?,?,?,?) RETURNING id,username,display_name,created_at', (username,display,make_password(password),now_iso()))
                    user = rowdict(cur.fetchone())
                    self.query(conn, 'INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)', (token,user['id'],now_iso()))
                    conn.commit(); self.send_json(201, {'token':token,'user':user})
                except Exception:
                    conn.rollback(); self.send_json(409, {'error':'そのアカウント名はすでに使われています'})
                return
            if path == '/api/login':
                username = clean_text(data.get('username'),32); password = str(data.get('password') or '')
                row = self.query(conn, 'SELECT id,username,display_name,password_hash,created_at FROM users WHERE lower(username)=lower(?)', (username,)).fetchone()
                if not row or not check_password(password,row['password_hash']): self.send_json(401, {'error':'アカウント名またはパスワードが違います'}); return
                token = secrets.token_urlsafe(32); self.query(conn,'INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)',(token,row['id'],now_iso()));conn.commit()
                self.send_json(200, {'token':token,'user':{'id':row['id'],'username':row['username'],'display_name':row['display_name'],'created_at':row['created_at']}}); return
            user = self.require_user(conn)
            if not user: return
            if path == '/api/logout':
                auth = self.headers.get('Authorization',''); token=auth[7:].strip() if auth.lower().startswith('bearer ') else ''
                self.query(conn,'DELETE FROM sessions WHERE token=?',(token,));conn.commit();self.send_json(200,{'ok':True});return
            if path == '/api/posts':
                kind=clean_text(data.get('kind'),30); title=clean_text(data.get('title'),160); body=clean_text(data.get('body'),10000); url=clean_text(data.get('url'),2000)
                if kind not in ('text','image','video_vertical','video_horizontal','file','url'): self.send_json(400,{'error':'投稿の種類が正しくありません'});return
                if not title: self.send_json(400,{'error':'タイトルを入力してください'});return
                if kind=='url' and url and not re.match(r'^https?://',url,re.I): self.send_json(400,{'error':'URLは http:// または https:// から始めてください'});return
                cur=self.query(conn,'INSERT INTO posts(user_id,kind,title,body,url,created_at) VALUES(?,?,?,?,?,?) RETURNING id',(user['id'],kind,title,body,url,now_iso()));post_id=cur.fetchone()['id'];conn.commit();self.send_json(201,{'ok':True,'id':post_id});return
            if path == '/api/mail':
                to_username=clean_text(data.get('to_username'),32);subject=clean_text(data.get('subject'),160);body=clean_text(data.get('body'),10000)
                if not body: self.send_json(400,{'error':'メッセージを入力してください'});return
                target=self.query(conn,'SELECT id FROM users WHERE lower(username)=lower(?)',(to_username,)).fetchone()
                if not target: self.send_json(404,{'error':'宛先アカウントが見つかりません'});return
                if target['id']==user['id']: self.send_json(400,{'error':'自分自身には送信できません'});return
                cur=self.query(conn,'INSERT INTO messages(from_user_id,to_user_id,subject,body,is_read,created_at) VALUES(?,?,?,?,0,?) RETURNING id',(user['id'],target['id'],subject,body,now_iso()));conn.commit();self.send_json(201,{'ok':True,'id':cur.fetchone()['id']});return
            match=re.fullmatch(r'/api/posts/(\d+)/like',path)
            if match:
                post_id=int(match.group(1));exists=self.query(conn,'SELECT 1 FROM likes WHERE user_id=? AND post_id=?',(user['id'],post_id)).fetchone()
                if exists:self.query(conn,'DELETE FROM likes WHERE user_id=? AND post_id=?',(user['id'],post_id))
                else:
                    try:self.query(conn,'INSERT INTO likes(user_id,post_id,created_at) VALUES(?,?,?)',(user['id'],post_id,now_iso()))
                    except Exception:conn.rollback()
                conn.commit();self.send_json(200,{'ok':True,'liked':not bool(exists)});return
            match=re.fullmatch(r'/api/posts/(\d+)/comments',path)
            if match:
                body=clean_text(data.get('body'),3000)
                if not body:self.send_json(400,{'error':'コメントを入力してください'});return
                self.query(conn,'INSERT INTO comments(user_id,post_id,body,created_at) VALUES(?,?,?,?)',(user['id'],int(match.group(1)),body,now_iso()));conn.commit();self.send_json(201,{'ok':True});return
            match=re.fullmatch(r'/api/mail/(\d+)/read',path)
            if match:
                cur=self.query(conn,'UPDATE messages SET is_read=1 WHERE id=? AND to_user_id=?',(int(match.group(1)),user['id']));conn.commit();self.send_json(200,{'ok':True});return
            self.send_json(404,{'error':'APIが見つかりません'})
        except Exception as e:
            conn.rollback();print('POST API error:',repr(e),flush=True);self.send_json(500,{'error':'サーバーでエラーが発生しました'})
        finally: conn.close()

    def api_patch_me(self):
        try:data=self.read_json()
        except Exception as e:self.send_json(400,{'error':str(e)});return
        conn=self.db()
        try:
            user=self.require_user(conn)
            if not user:return
            display=clean_text(data.get('display_name'),40) or user['username']
            self.query(conn,'UPDATE users SET display_name=? WHERE id=?',(display,user['id']));conn.commit()
            updated=self.query(conn,'SELECT id,username,display_name,created_at FROM users WHERE id=?',(user['id'],)).fetchone();self.send_json(200,{'user':rowdict(updated)})
        except Exception as e:conn.rollback();print('PATCH API error:',repr(e),flush=True);self.send_json(500,{'error':'サーバーでエラーが発生しました'})
        finally:conn.close()

    def api_delete(self,path):
        conn=self.db()
        try:
            user=self.require_user(conn)
            if not user:return
            match=re.fullmatch(r'/api/posts/(\d+)',path)
            if match:
                post=self.query(conn,'SELECT user_id FROM posts WHERE id=?',(int(match.group(1)),)).fetchone()
                if not post:self.send_json(404,{'error':'投稿が見つかりません'});return
                if post['user_id']!=user['id']:self.send_json(403,{'error':'自分の投稿だけ削除できます'});return
                self.query(conn,'DELETE FROM posts WHERE id=?',(int(match.group(1)),));conn.commit();self.send_json(200,{'ok':True});return
            match=re.fullmatch(r'/api/mail/(\d+)',path)
            if match:
                mid=int(match.group(1));msg=self.query(conn,'SELECT from_user_id,to_user_id FROM messages WHERE id=?',(mid,)).fetchone()
                if not msg:self.send_json(404,{'error':'メッセージが見つかりません'});return
                if msg['from_user_id']==user['id']:self.query(conn,'UPDATE messages SET deleted_by_sender=1 WHERE id=?',(mid,))
                elif msg['to_user_id']==user['id']:self.query(conn,'UPDATE messages SET deleted_by_recipient=1 WHERE id=?',(mid,))
                else:self.send_json(403,{'error':'このメッセージを削除できません'});return
                conn.commit();self.send_json(200,{'ok':True});return
            self.send_json(404,{'error':'APIが見つかりません'})
        except Exception as e:conn.rollback();print('DELETE API error:',repr(e),flush=True);self.send_json(500,{'error':'サーバーでエラーが発生しました'})
        finally:conn.close()


def main():
    print(f'Japan Connect starting on port {PORT}; database={"PostgreSQL" if DBH.pg else "SQLite (local)"}', flush=True)
    server=ThreadingHTTPServer(('0.0.0.0',PORT),Handler)
    server.serve_forever()

if __name__=='__main__':
    main()

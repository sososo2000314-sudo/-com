
import hashlib
import hmac
import json
import logging
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

# =========================================================
# Japan Connect 🇯🇵 - サーバー本体
# =========================================================

BASE_DIR = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "10000"))

DATABASE_URL = (
    os.environ.get("DATABASE_URL")
    or os.environ.get("NEON_DATABASE_URL")
    or ""
).strip()

DB_PATH = os.environ.get(
    "DB_PATH",
    str(BASE_DIR / "japan_connect.db")
)

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "").strip()
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

PASSWORD_ITERATIONS = 310_000
MAX_BODY_SIZE = 5 * 1024 * 1024

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

if DATABASE_URL:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise RuntimeError(
            "DATABASE_URL が設定されていますが、"
            "psycopg がインストールされていません。"
        ) from exc


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def json_bytes(data):
    return json.dumps(
        data,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PASSWORD_ITERATIONS,
    ).hex()


def make_password(password):
    salt = secrets.token_hex(16)
    return salt, password_hash(password, salt)


def check_password(password, salt, stored_hash):
    try:
        return hmac.compare_digest(
            password_hash(password, salt),
            stored_hash,
        )
    except (TypeError, ValueError):
        return False


@contextmanager
def db_connection():
    """SQLite または PostgreSQL への接続を管理する。"""
    if DATABASE_URL:
        conn = psycopg.connect(
            DATABASE_URL,
            row_factory=dict_row,
            connect_timeout=15,
        )
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    else:
        Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=15)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def execute(conn, sql, params=()):
    """両方のデータベースで ? プレースホルダーを使えるようにする。"""
    if DATABASE_URL:
        sql = sql.replace("?", "%s")
    return conn.execute(sql, params)


def row_dict(row):
    if row is None:
        return None
    return dict(row)


def init_database():
    """必要なテーブルを作成する。既存テーブルは削除しない。"""
    if DATABASE_URL:
        id_type = "BIGSERIAL PRIMARY KEY"
        bool_type = "BOOLEAN NOT NULL DEFAULT FALSE"
    else:
        id_type = "INTEGER PRIMARY KEY AUTOINCREMENT"
        bool_type = "BOOLEAN NOT NULL DEFAULT 0"

    statements = [
        f"""
        CREATE TABLE IF NOT EXISTS users (
            id {id_type},
            username TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            is_admin {bool_type},
            created_at TEXT NOT NULL
        )
        """,
        f"""
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id BIGINT NOT NULL,
            created_at TEXT NOT NULL
        )
        """,
        f"""
        CREATE TABLE IF NOT EXISTS posts (
            id {id_type},
            user_id BIGINT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """,
        f"""
        CREATE TABLE IF NOT EXISTS likes (
            user_id BIGINT NOT NULL,
            post_id BIGINT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(user_id, post_id)
        )
        """,
        f"""
        CREATE TABLE IF NOT EXISTS comments (
            id {id_type},
            post_id BIGINT NOT NULL,
            user_id BIGINT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """,
        f"""
        CREATE TABLE IF NOT EXISTS messages (
            id {id_type},
            sender_id BIGINT NOT NULL,
            receiver_id BIGINT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """,
    ]

    with db_connection() as conn:
        for statement in statements:
            conn.execute(statement)

        # 以前からあるデータベースにも管理者列を追加する。
        if DATABASE_URL:
            conn.execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS "
                "is_admin BOOLEAN NOT NULL DEFAULT FALSE"
            )
        else:
            columns = {
                row["name"]
                for row in conn.execute(
                    "PRAGMA table_info(users)"
                ).fetchall()
            }
            if "is_admin" not in columns:
                conn.execute(
                    "ALTER TABLE users ADD COLUMN "
                    "is_admin BOOLEAN NOT NULL DEFAULT 0"
                )

        # よく使用する検索用インデックス。
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_posts_created "
            "ON posts(created_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_users "
            "ON messages(sender_id, receiver_id, created_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_comments_post "
            "ON comments(post_id, created_at)"
        )

    ensure_admin()
    logging.info(
        "データベースの初期化が完了しました。接続先=%s",
        "PostgreSQL" if DATABASE_URL else "SQLite",
    )


def ensure_admin():
    """環境変数で指定された管理者アカウントを用意する。"""
    if not ADMIN_USERNAME or not ADMIN_PASSWORD:
        logging.warning(
            "ADMIN_USERNAME または ADMIN_PASSWORD が未設定です。"
            "管理者アカウントの自動作成は行いません。"
        )
        return

    if len(ADMIN_PASSWORD) < 12:
        logging.warning(
            "管理者パスワードは12文字以上にしてください。"
        )
        return

    salt, hashed = make_password(ADMIN_PASSWORD)

    with db_connection() as conn:
        existing = execute(
            conn,
            "SELECT id FROM users WHERE username = ?",
            (ADMIN_USERNAME,),
        ).fetchone()

        if existing:
            # 既存アカウントを管理者にする。
            execute(
                conn,
                "UPDATE users SET is_admin = TRUE WHERE username = ?",
                (ADMIN_USERNAME,),
            )
        else:
            execute(
                conn,
                """
                INSERT INTO users
                    (username, display_name, password_hash,
                     salt, is_admin, created_at)
                VALUES (?, ?, ?, ?, TRUE, ?)
                """,
                (
                    ADMIN_USERNAME,
                    ADMIN_USERNAME,
                    hashed,
                    salt,
                    now(),
                ),
            )

    logging.info("管理者アカウントの確認が完了しました。")


def public_user(user):
    if not user:
        return None

    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "is_admin": bool(user["is_admin"]),
        "created_at": user["created_at"],
    }


def get_user_by_token(conn, token):
    if not token:
        return None

    row = execute(
        conn,
        """
        SELECT users.*
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = ?
        """,
        (token,),
    ).fetchone()

    return row_dict(row)


def get_token(handler):
    header = handler.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()

    # Cookie 認証は必須にしない。
    return ""


def require_user(handler, conn):
    user = get_user_by_token(conn, get_token(handler))
    if not user:
        raise ApiError(401, "ログインしてください。")
    return user


def require_admin(handler, conn):
    user = require_user(handler, conn)
    if not bool(user["is_admin"]):
        raise ApiError(403, "管理者のみ実行できます。")
    return user


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def parse_json_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or "0")

    if length < 0 or length > MAX_BODY_SIZE:
        raise ApiError(413, "送信データが大きすぎます。")

    raw = handler.rfile.read(length)

    if not raw:
        return {}

    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ApiError(400, "送信データの形式が正しくありません。")

    if not isinstance(data, dict):
        raise ApiError(400, "送信データはJSONオブジェクトにしてください。")

    return data


def clean_text(value, max_length=5000):
    if not isinstance(value, str):
        return ""
    return value.strip()[:max_length]


class JapanConnectHandler(BaseHTTPRequestHandler):
    server_version = "JapanConnect/1.0"

    def log_message(self, fmt, *args):
        logging.info(
            "%s - %s",
            self.client_address[0],
            fmt % args,
        )

    def send_json(self, status, data):
        body = json_bytes(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json(status, {
            "ok": False,
            "error": message,
            "message": message,
        })

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, DELETE, OPTIONS")
        self.end_headers()

    def do_GET(self):
        try:
            path = urlparse(self.path).path.rstrip("/") or "/"

            if path.startswith("/api/"):
                self.api_get(path)
            else:
                self.serve_static(path)

        except ApiError as exc:
            self.send_error_json(exc.status, exc.message)
        except Exception:
            logging.exception("GET処理でエラーが発生しました")
            self.send_error_json(
                500,
                "サーバー内部でエラーが発生しました。ログを確認してください。",
            )

    def do_POST(self):
        try:
            path = urlparse(self.path).path.rstrip("/")
            data = parse_json_body(self)

            if not path.startswith("/api/"):
                raise ApiError(404, "このAPIは存在しません。")

            self.api_post(path, data)

        except ApiError as exc:
            self.send_error_json(exc.status, exc.message)
        except Exception:
            logging.exception("POST処理でエラーが発生しました")
            self.send_error_json(
                500,
                "サーバー内部でエラーが発生しました。ログを確認してください。",
            )

    def do_DELETE(self):
        try:
            path = urlparse(self.path).path.rstrip("/")
            if not path.startswith("/api/"):
                raise ApiError(404, "このAPIは存在しません。")
            self.api_delete(path)
        except ApiError as exc:
            self.send_error_json(exc.status, exc.message)
        except Exception:
            logging.exception("DELETE処理でエラーが発生しました")
            self.send_error_json(500, "削除処理に失敗しました。")

    def api_get(self, path):
        with db_connection() as conn:
            if path == "/api/health":
                self.send_json(200, {
                    "ok": True,
                    "database": (
                        "postgresql" if DATABASE_URL else "sqlite"
                    ),
                })
                return

            if path == "/api/me":
                user = get_user_by_token(conn, get_token(self))
                self.send_json(200, {
                    "ok": True,
                    "user": public_user(user),
                })
                return

            if path == "/api/posts":
                rows = execute(
                    conn,
                    """
                    SELECT posts.*, users.username,
                           users.display_name
                    FROM posts
                    JOIN users ON users.id = posts.user_id
                    ORDER BY posts.id DESC
                    LIMIT 200
                    """,
                ).fetchall()

                user = get_user_by_token(conn, get_token(self))
                current_id = user["id"] if user else None

                result = []
                for row in rows:
                    post = row_dict(row)
                    likes = execute(
                        conn,
                        "SELECT COUNT(*) AS n FROM likes WHERE post_id = ?",
                        (post["id"],),
                    ).fetchone()
                    comments = execute(
                        conn,
                        """
                        SELECT comments.id, comments.content,
                               comments.created_at, users.username,
                               users.display_name
                        FROM comments
                        JOIN users ON users.id = comments.user_id
                        WHERE comments.post_id = ?
                        ORDER BY comments.id ASC
                        LIMIT 100
                        """,
                        (post["id"],),
                    ).fetchall()

                    liked = False
                    if current_id is not None:
                        liked = execute(
                            conn,
                            "SELECT 1 FROM likes "
                            "WHERE user_id = ? AND post_id = ?",
                            (current_id, post["id"]),
                        ).fetchone() is not None

                    result.append({
                        "id": post["id"],
                        "user_id": post["user_id"],
                        "username": post["username"],
                        "display_name": post["display_name"],
                        "content": post["content"],
                        "created_at": post["created_at"],
                        "likes": likes["n"],
                        "liked": liked,
                        "comments": [row_dict(c) for c in comments],
                    })

                self.send_json(200, {"ok": True, "posts": result})
                return

            if path == "/api/mail":
                user = require_user(self, conn)
                rows = execute(
                    conn,
                    """
                    SELECT messages.*, 
                           sender.username AS sender_username,
                           sender.display_name AS sender_name,
                           receiver.username AS receiver_username,
                           receiver.display_name AS receiver_name
                    FROM messages
                    JOIN users AS sender ON sender.id = messages.sender_id
                    JOIN users AS receiver ON receiver.id = messages.receiver_id
                    WHERE messages.sender_id = ?
                       OR messages.receiver_id = ?
                    ORDER BY messages.id DESC
                    LIMIT 300
                    """,
                    (user["id"], user["id"]),
                ).fetchall()

                self.send_json(200, {
                    "ok": True,
                    "messages": [row_dict(r) for r in rows],
                })
                return

            if path == "/api/friends":
                user = require_user(self, conn)
                rows = execute(
                    conn,
                    """
                    SELECT id, username, display_name, created_at
                    FROM users
                    WHERE id != ?
                    ORDER BY username
                    LIMIT 500
                    """,
                    (user["id"],),
                ).fetchall()
                self.send_json(200, {
                    "ok": True,
                    "friends": [row_dict(r) for r in rows],
                })
                return

            if path == "/api/admin/users":
                require_admin(self, conn)
                rows = execute(
                    conn,
                    """
                    SELECT id, username, display_name, is_admin, created_at
                    FROM users ORDER BY id DESC LIMIT 1000
                    """,
                ).fetchall()
                self.send_json(200, {
                    "ok": True,
                    "users": [public_user(row_dict(r)) for r in rows],
                })
                return

            if path == "/api/admin/posts":
                require_admin(self, conn)
                rows = execute(
                    conn,
                    """
                    SELECT posts.*, users.username, users.display_name
                    FROM posts
                    JOIN users ON users.id = posts.user_id
                    ORDER BY posts.id DESC LIMIT 1000
                    """,
                ).fetchall()
                self.send_json(200, {
                    "ok": True,
                    "posts": [row_dict(r) for r in rows],
                })
                return

        raise ApiError(404, "指定されたAPIは存在しません。")

    def api_post(self, path, data):
        with db_connection() as conn:
            if path == "/api/register":
                username = clean_text(data.get("username"), 32)
                password = data.get("password", "")
                display_name = clean_text(
                    data.get("display_name")
                    or data.get("name")
                    or username,
                    60,
                )

                if not username or not password:
                    raise ApiError(
                        400,
                        "アカウント名とパスワードを入力してください。",
                    )
                if len(username) < 3:
                    raise ApiError(
                        400,
                        "アカウント名は3文字以上にしてください。",
                    )
                if not all(
                    ch.isalnum() or ch in "_-." for ch in username
                ):
                    raise ApiError(
                        400,
                        "アカウント名には英数字、_、-、. を使用できます。",
                    )
                if len(password) < 8:
                    raise ApiError(
                        400,
                        "パスワードは8文字以上にしてください。",
                    )
                if len(password) > 1024:
                    raise ApiError(400, "パスワードが長すぎます。")

                existing = execute(
                    conn,
                    "SELECT id FROM users WHERE username = ?",
                    (username,),
                ).fetchone()
                if existing:
                    raise ApiError(
                        409,
                        "このアカウント名はすでに使用されています。",
                    )

                salt, hashed = make_password(password)
                cursor = execute(
                    conn,
                    """
                    INSERT INTO users
                        (username, display_name, password_hash,
                         salt, is_admin, created_at)
                    VALUES (?, ?, ?, ?, FALSE, ?)
                    """,
                    (username, display_name or username,
                     hashed, salt, now()),
                )

                user_id = cursor.lastrowid
                if DATABASE_URL:
                    # PostgreSQLでは lastrowid を使わずIDを取得する。
                    row = execute(
                        conn,
                        "SELECT id FROM users WHERE username = ?",
                        (username,),
                    ).fetchone()
                    user_id = row["id"]

                token = secrets.token_urlsafe(32)
                execute(
                    conn,
                    "INSERT INTO sessions (token, user_id, created_at) "
                    "VALUES (?, ?, ?)",
                    (token, user_id, now()),
                )

                user = execute(
                    conn,
                    "SELECT * FROM users WHERE id = ?",
                    (user_id,),
                ).fetchone()

                logging.info("アカウント登録成功: %s", username)
                self.send_json(201, {
                    "ok": True,
                    "message": "アカウントを作成しました。",
                    "token": token,
                    "user": public_user(row_dict(user)),
                })
                return

            if path == "/api/login":
                username = clean_text(data.get("username"), 32)
                password = data.get("password", "")

                user = execute(
                    conn,
                    "SELECT * FROM users WHERE username = ?",
                    (username,),
                ).fetchone()

                if (
                    not user
                    or not check_password(
                        password,
                        user["salt"],
                        user["password_hash"],
                    )
                ):
                    raise ApiError(
                        401,
                        "アカウント名またはパスワードが違います。",
                    )

                token = secrets.token_urlsafe(32)
                execute(
                    conn,
                    "INSERT INTO sessions (token, user_id, created_at) "
                    "VALUES (?, ?, ?)",
                    (token, user["id"], now()),
                )
                self.send_json(200, {
                    "ok": True,
                    "message": "ログインしました。",
                    "token": token,
                    "user": public_user(row_dict(user)),
                })
                return

            if path == "/api/logout":
                execute(
                    conn,
                    "DELETE FROM sessions WHERE token = ?",
                    (get_token(self),),
                )
                self.send_json(200, {"ok": True})
                return

            if path == "/api/posts":
                user = require_user(self, conn)
                content = clean_text(data.get("content"), 10000)
                if not content:
                    raise ApiError(400, "投稿内容を入力してください。")

                cursor = execute(
                    conn,
                    "INSERT INTO posts (user_id, content, created_at) "
                    "VALUES (?, ?, ?)",
                    (user["id"], content, now()),
                )
                post_id = cursor.lastrowid

                if DATABASE_URL:
                    row = execute(
                        conn,
                        "SELECT id FROM posts WHERE user_id = ? "
                        "AND content = ? ORDER BY id DESC LIMIT 1",
                        (user["id"], content),
                    ).fetchone()
                    post_id = row["id"]

                self.send_json(201, {
                    "ok": True,
                    "message": "投稿しました。",
                    "id": post_id,
                })
                return

            if path.startswith("/api/posts/") and path.endswith("/like"):
                user = require_user(self, conn)
                parts = path.strip("/").split("/")
                try:
                    post_id = int(parts[2])
                except (IndexError, ValueError):
                    raise ApiError(400, "投稿IDが正しくありません。")

                post = execute(
                    conn,
                    "SELECT id FROM posts WHERE id = ?",
                    (post_id,),
                ).fetchone()
                if not post:
                    raise ApiError(404, "投稿が見つかりません。")

                existing = execute(
                    conn,
                    "SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?",
                    (user["id"], post_id),
                ).fetchone()

                if existing:
                    execute(
                        conn,
                        "DELETE FROM likes WHERE user_id = ? AND post_id = ?",
                        (user["id"], post_id),
                    )
                    liked = False
                else:
                    execute(
                        conn,
                        "INSERT INTO likes (user_id, post_id, created_at) "
                        "VALUES (?, ?, ?)",
                        (user["id"], post_id, now()),
                    )
                    liked = True

                self.send_json(200, {"ok": True, "liked": liked})
                return

            if path.startswith("/api/posts/") and path.endswith("/comments"):
                user = require_user(self, conn)
                parts = path.strip("/").split("/")
                try:
                    post_id = int(parts[2])
                except (IndexError, ValueError):
                    raise ApiError(400, "投稿IDが正しくありません。")

                content = clean_text(data.get("content"), 2000)
                if not content:
                    raise ApiError(400, "コメントを入力してください。")

                post = execute(
                    conn,
                    "SELECT id FROM posts WHERE id = ?",
                    (post_id,),
                ).fetchone()
                if not post:
                    raise ApiError(404, "投稿が見つかりません。")

                execute(
                    conn,
                    """
                    INSERT INTO comments
                        (post_id, user_id, content, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (post_id, user["id"], content, now()),
                )
                self.send_json(201, {
                    "ok": True,
                    "message": "コメントしました。",
                })
                return

            if path == "/api/mail":
                user = require_user(self, conn)
                receiver = clean_text(
                    data.get("receiver_username")
                    or data.get("username"),
                    32,
                )
                content = clean_text(data.get("content"), 5000)

                if not receiver or not content:
                    raise ApiError(
                        400,
                        "相手のアカウント名とメッセージを入力してください。",
                    )

                recipient = execute(
                    conn,
                    "SELECT id FROM users WHERE username = ?",
                    (receiver,),
                ).fetchone()

                if not recipient:
                    raise ApiError(404, "相手のアカウントが見つかりません。")
                if recipient["id"] == user["id"]:
                    raise ApiError(400, "自分自身には送信できません。")

                execute(
                    conn,
                    """
                    INSERT INTO messages
                        (sender_id, receiver_id, content, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (user["id"], recipient["id"], content, now()),
                )
                self.send_json(201, {
                    "ok": True,
                    "message": "メッセージを送信しました。",
                })
                return

        raise ApiError(404, "指定されたAPIは存在しません。")

    def api_delete(self, path):
        with db_connection() as conn:
            # 管理者によるアカウント削除
            if path.startswith("/api/admin/users/"):
                admin = require_admin(self, conn)
                try:
                    target_id = int(path.rsplit("/", 1)[1])
                except ValueError:
                    raise ApiError(400, "ユーザーIDが正しくありません。")

                if target_id == admin["id"]:
                    raise ApiError(
                        400,
                        "ログイン中の管理者自身は削除できません。",
                    )

                target = execute(
                    conn,
                    "SELECT id FROM users WHERE id = ?",
                    (target_id,),
                ).fetchone()
                if not target:
                    raise ApiError(404, "ユーザーが見つかりません。")

                # 関連データも削除する。
                execute(conn, "DELETE FROM sessions WHERE user_id = ?", (target_id,))
                execute(conn, "DELETE FROM likes WHERE user_id = ?", (target_id,))
                execute(conn, "DELETE FROM comments WHERE user_id = ?", (target_id,))
                execute(
                    conn,
                    "DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?",
                    (target_id, target_id),
                )

                # ユーザーの投稿と、その投稿についたデータを削除。
                post_rows = execute(
                    conn,
                    "SELECT id FROM posts WHERE user_id = ?",
                    (target_id,),
                ).fetchall()
                for post in post_rows:
                    execute(
                        conn,
                        "DELETE FROM likes WHERE post_id = ?",
                        (post["id"],),
                    )
                    execute(
                        conn,
                        "DELETE FROM comments WHERE post_id = ?",
                        (post["id"],),
                    )
                execute(conn, "DELETE FROM posts WHERE user_id = ?", (target_id,))
                execute(conn, "DELETE FROM users WHERE id = ?", (target_id,))

                self.send_json(200, {
                    "ok": True,
                    "message": "アカウントを削除しました。",
                })
                return

            # 管理者による投稿削除
            if path.startswith("/api/admin/posts/"):
                require_admin(self, conn)
                try:
                    post_id = int(path.rsplit("/", 1)[1])
                except ValueError:
                    raise ApiError(400, "投稿IDが正しくありません。")

                post = execute(
                    conn,
                    "SELECT id FROM posts WHERE id = ?",
                    (post_id,),
                ).fetchone()
                if not post:
                    raise ApiError(404, "投稿が見つかりません。")

                execute(conn, "DELETE FROM likes WHERE post_id = ?", (post_id,))
                execute(conn, "DELETE FROM comments WHERE post_id = ?", (post_id,))
                execute(conn, "DELETE FROM posts WHERE id = ?", (post_id,))

                self.send_json(200, {
                    "ok": True,
                    "message": "投稿を削除しました。",
                })
                return

            # 投稿者本人による投稿削除
            if path.startswith("/api/posts/"):
                user = require_user(self, conn)
                try:
                    post_id = int(path.rsplit("/", 1)[1])
                except ValueError:
                    raise ApiError(400, "投稿IDが正しくありません。")

                post = execute(
                    conn,
                    "SELECT id, user_id FROM posts WHERE id = ?",
                    (post_id,),
                ).fetchone()

                if not post:
                    raise ApiError(404, "投稿が見つかりません。")
                if post["user_id"] != user["id"] and not bool(user["is_admin"]):
                    raise ApiError(403, "自分の投稿だけ削除できます。")

                execute(conn, "DELETE FROM likes WHERE post_id = ?", (post_id,))
                execute(conn, "DELETE FROM comments WHERE post_id = ?", (post_id,))
                execute(conn, "DELETE FROM posts WHERE id = ?", (post_id,))

                self.send_json(200, {
                    "ok": True,
                    "message": "投稿を削除しました。",
                })
                return

        raise ApiError(404, "指定されたAPIは存在しません。")

    def serve_static(self, path):
        # API以外は、アプリのファイルを配信する。
        if path == "/":
            path = "/index.html"

        allowed_files = {
            "/index.html",
            "/app.js",
            "/style.css",
        }

        if path not in allowed_files:
            self.send_error_json(404, "ファイルが見つかりません。")
            return

        file_path = BASE_DIR / path.lstrip("/")
        if not file_path.is_file():
            self.send_error_json(
                500,
                f"{file_path.name} がサーバーにありません。",
            )
            return

        content_type = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
        }.get(file_path.suffix, "application/octet-stream")

        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


def main():
    init_database()

    server = ThreadingHTTPServer(
        ("0.0.0.0", PORT),
        JapanConnectHandler,
    )
    logging.info("Japan Connect サーバーを起動しました。PORT=%s", PORT)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("サーバーを停止します。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

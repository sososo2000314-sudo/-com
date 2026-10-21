
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, post_id)
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS follows (
    user_id INTEGER NOT NULL,
    followed_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, followed_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS admin_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
];

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

const fail = (message, status = 400) =>
  json({ ok: false, message }, status);

const randomHex = (bytes) => {
  const array = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(array, (v) => v.toString(16).padStart(2, "0")).join("");
};

async function hashPassword(password, salt = randomHex(16)) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 210000,
      hash: "SHA-256",
    },
    key,
    256
  );

  const hash = Array.from(new Uint8Array(bits))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

  return `${salt}:${hash}`;
}

async function verifyPassword(password, saved) {
  if (!saved || !saved.includes(":")) return false;

  const [salt, expected] = saved.split(":");
  const actual = (await hashPassword(password, salt)).split(":")[1];

  if (actual.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function ensureSchema(db) {
  // D1のテーブルがまだなければ作成する
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

async function bodyJSON(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("送信データの形式が正しくありません。");
  }
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    avatar: user.avatar || "",
    is_admin: Boolean(user.is_admin),
    created_at: user.created_at,
  };
}

async function currentUser(request, db) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token) return null;

  return db.prepare(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).bind(token).first();
}

async function requireUser(request, db) {
  const user = await currentUser(request, db);
  if (!user) throw new Error("ログインしてください。");
  return user;
}

async function requireAdmin(request, db) {
  const user = await requireUser(request, db);
  if (!user.is_admin) throw new Error("管理者のみ利用できる操作です。");
  const config = await db.prepare("SELECT password_hash FROM admin_config WHERE id = 1").first();
  if (config) {
    const supplied = request.headers.get("X-Admin-Password") || "";
    if (!(await verifyPassword(supplied, config.password_hash))) throw new Error("管理者パスワードが違います。");
  }
  return user;
}

async function listPosts(db, user) {
  const result = await db.prepare(`
    SELECT
      p.id, p.user_id, p.content, p.created_at,
      u.username, u.display_name,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
      EXISTS(
        SELECT 1 FROM likes l
        WHERE l.post_id = p.id AND l.user_id = ?
      ) AS liked
    FROM posts p
    JOIN users u ON u.id = p.user_id
    ORDER BY p.id DESC
    LIMIT 200
  `).bind(user?.id ?? -1).all();

  const posts = result.results || [];

  for (const post of posts) {
    const comments = await db.prepare(`
      SELECT c.id, c.user_id, c.content, c.created_at,
             u.username, u.display_name
      FROM comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ?
      ORDER BY c.id ASC
      LIMIT 100
    `).bind(post.id).all();

    post.comments = comments.results || [];
    post.liked = Boolean(post.liked);
    post.likes = Number(post.likes || 0);
  }

  return posts;
}

async function handleAPI(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!db) return fail("D1データベースが接続されていません。", 503);

  await ensureSchema(db);

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, app: "Japan Connect", worker: "running", database: true });
  }

  // アカウント登録
  if (path === "/api/register" && method === "POST") {
    const data = await bodyJSON(request);
    const username = String(data.username || "").trim().toLowerCase();
    const displayName = String(data.display_name || username).trim();
    const password = String(data.password || "");

    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      return fail("アカウント名は英小文字・数字・_ の3〜32文字で入力してください。");
    }
    if (password.length < 8 || password.length > 256) {
      return fail("パスワードは8〜256文字で入力してください。");
    }
    if (!displayName || displayName.length > 60) {
      return fail("表示名は1〜60文字で入力してください。");
    }

    const exists = await db.prepare(
      "SELECT id FROM users WHERE username = ?"
    ).bind(username).first();

    if (exists) return fail("このアカウント名はすでに使われています。", 409);

    const count = await db.prepare(
      "SELECT COUNT(*) AS total FROM users"
    ).first();

    // 最初に登録したユーザーを管理者にする
    const isAdmin = Number(count?.total || 0) === 0 ? 1 : 0;
    const passwordHash = await hashPassword(password);

    const inserted = await db.prepare(`
      INSERT INTO users (username, password_hash, display_name, is_admin)
      VALUES (?, ?, ?, ?)
    `).bind(username, passwordHash, displayName, isAdmin).run();

    const userId = Number(inserted.meta.last_row_id);
    const token = randomHex(32);

    await db.prepare(
      "INSERT INTO sessions (token, user_id) VALUES (?, ?)"
    ).bind(token, userId).run();

    const user = await db.prepare(
      "SELECT * FROM users WHERE id = ?"
    ).bind(userId).first();

    return json({
      ok: true,
      message: "アカウントを作成しました。",
      token,
      user: publicUser(user),
    }, 201);
  }

  // ログイン
  if (path === "/api/login" && method === "POST") {
    const data = await bodyJSON(request);
    const username = String(data.username || "").trim().toLowerCase();
    const password = String(data.password || "");

    const user = await db.prepare(
      "SELECT * FROM users WHERE username = ?"
    ).bind(username).first();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return fail("アカウント名またはパスワードが違います。", 401);
    }

    const token = randomHex(32);
    await db.prepare(
      "INSERT INTO sessions (token, user_id) VALUES (?, ?)"
    ).bind(token, user.id).run();

    return json({
      ok: true,
      message: "ログインしました。",
      token,
      user: publicUser(user),
    });
  }

  if (path === "/api/logout" && method === "POST") {
    const authorization = request.headers.get("Authorization") || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (token) {
      await db.prepare("DELETE FROM sessions WHERE token = ?")
        .bind(token).run();
    }
    return json({ ok: true, message: "ログアウトしました。" });
  }

  // ゲストも投稿一覧だけは閲覧可能
  if (path === "/api/public/posts" && method === "GET") {
    return json({ ok: true, posts: await listPosts(db, null) });
  }

  // ここからログインが必要
  const user = await requireUser(request, db);

  if (path === "/api/me" && method === "GET") {
    return json({ ok: true, user: publicUser(user) });
  }

  if (path === "/api/me" && method === "PATCH") {
    const data = await bodyJSON(request);
    const displayName = String(data.display_name ?? user.display_name).trim();
    const avatar = String(data.avatar ?? user.avatar ?? "");

    if (!displayName || displayName.length > 60) {
      return fail("表示名は1〜60文字で入力してください。");
    }
    if (avatar.length > 200000) return fail("プロフィール画像のデータが大きすぎます。");

    await db.prepare(
      "UPDATE users SET display_name = ?, avatar = ? WHERE id = ?"
    ).bind(displayName, avatar, user.id).run();

    const updated = await db.prepare(
      "SELECT * FROM users WHERE id = ?"
    ).bind(user.id).first();

    return json({ ok: true, user: publicUser(updated) });
  }

  if (path === "/api/posts" && method === "GET") {
    return json({ ok: true, posts: await listPosts(db, user) });
  }

  if (path === "/api/posts" && method === "POST") {
    const data = await bodyJSON(request);
    const content = String(data.content || "").trim();

    if (!content || content.length > 10000) {
      return fail("投稿は1〜10000文字で入力してください。");
    }

    await db.prepare(
      "INSERT INTO posts (user_id, content) VALUES (?, ?)"
    ).bind(user.id, content).run();

    return json({ ok: true, message: "投稿しました。" }, 201);
  }

  let match = path.match(/^\/api\/posts\/(\d+)\/like$/);
  if (match && method === "POST") {
    const postId = Number(match[1]);
    const post = await db.prepare(
      "SELECT id FROM posts WHERE id = ?"
    ).bind(postId).first();

    if (!post) return fail("投稿が見つかりません。", 404);

    const existing = await db.prepare(
      "SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?"
    ).bind(user.id, postId).first();

    if (existing) {
      await db.prepare(
        "DELETE FROM likes WHERE user_id = ? AND post_id = ?"
      ).bind(user.id, postId).run();
    } else {
      await db.prepare(
        "INSERT INTO likes (user_id, post_id) VALUES (?, ?)"
      ).bind(user.id, postId).run();
    }

    return json({ ok: true, liked: !existing });
  }

  match = path.match(/^\/api\/posts\/(\d+)\/comments$/);
  if (match && method === "POST") {
    const postId = Number(match[1]);
    const data = await bodyJSON(request);
    const content = String(data.content || "").trim();

    if (!content || content.length > 2000) {
      return fail("コメントは1〜2000文字で入力してください。");
    }

    const post = await db.prepare(
      "SELECT id FROM posts WHERE id = ?"
    ).bind(postId).first();

    if (!post) return fail("投稿が見つかりません。", 404);

    await db.prepare(
      "INSERT INTO comments (user_id, post_id, content) VALUES (?, ?, ?)"
    ).bind(user.id, postId, content).run();

    return json({ ok: true, message: "コメントしました。" }, 201);
  }

  match = path.match(/^\/api\/posts\/(\d+)$/);
  if (match && method === "DELETE") {
    const postId = Number(match[1]);
    const post = await db.prepare(
      "SELECT * FROM posts WHERE id = ?"
    ).bind(postId).first();

    if (!post) return fail("投稿が見つかりません。", 404);
    if (Number(post.user_id) !== Number(user.id) && !user.is_admin) {
      return fail("この投稿を削除する権限がありません。", 403);
    }

    await db.batch([
      db.prepare("DELETE FROM comments WHERE post_id = ?").bind(postId),
      db.prepare("DELETE FROM likes WHERE post_id = ?").bind(postId),
      db.prepare("DELETE FROM posts WHERE id = ?").bind(postId),
    ]);

    return json({ ok: true, message: "投稿を削除しました。" });
  }

  if (path === "/api/friends" && method === "GET") {
    const result = await db.prepare(`
      SELECT id, username, display_name, avatar, is_admin
      FROM users WHERE id != ? ORDER BY username LIMIT 500
    `).bind(user.id).all();

    return json({ ok: true, friends: (result.results || []).map(publicUser) });
  }

  if (path === "/api/users" && method === "GET") {
    const query = String(url.searchParams.get("q") || "").trim();
    const result = await db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar, u.is_admin,
        EXISTS(SELECT 1 FROM follows f WHERE f.user_id = ? AND f.followed_id = u.id) AS following
      FROM users u
      WHERE u.id != ? AND (u.username LIKE ? OR u.display_name LIKE ?)
      ORDER BY u.username LIMIT 100
    `).bind(user.id, user.id, `%${query}%`, `%${query}%`).all();

    return json({ ok: true, users: (result.results || []).map(u => ({ ...publicUser(u), following: Boolean(u.following) })) });
  }

  // メール一覧
  if (path === "/api/mail" && method === "GET") {
    const result = await db.prepare(`
      SELECT m.*,
        s.username AS sender_username,
        s.display_name AS sender_name,
        r.username AS receiver_username,
        r.display_name AS receiver_name
      FROM messages m
      JOIN users s ON s.id = m.sender_id
      JOIN users r ON r.id = m.receiver_id
      WHERE m.sender_id = ? OR m.receiver_id = ?
      ORDER BY m.id DESC LIMIT 500
    `).bind(user.id, user.id).all();

    await db.prepare(
      "UPDATE messages SET is_read = 1 WHERE receiver_id = ?"
    ).bind(user.id).run();

    return json({ ok: true, messages: result.results || [] });
  }

  if (path === "/api/mail" && method === "POST") {
    const data = await bodyJSON(request);
    const receiverUsername = String(data.receiver_username || "").trim().toLowerCase();
    const content = String(data.content || "").trim();

    if (!content || content.length > 5000) {
      return fail("メッセージは1〜5000文字で入力してください。");
    }

    const receiver = await db.prepare(
      "SELECT id FROM users WHERE username = ?"
    ).bind(receiverUsername).first();

    if (!receiver) return fail("送信先のアカウントが見つかりません。", 404);
    if (Number(receiver.id) === Number(user.id)) {
      return fail("自分自身には送信できません。");
    }

    await db.prepare(`
      INSERT INTO messages (sender_id, receiver_id, content)
      VALUES (?, ?, ?)
    `).bind(user.id, receiver.id, content).run();

    return json({ ok: true, message: "メッセージを送信しました。" }, 201);
  }

  // フォローの追加・解除
  match = path.match(/^\/api\/users\/(\d+)\/follow$/);
  if (match && method === "POST") {
    const followedId = Number(match[1]);
    if (followedId === Number(user.id)) return fail("自分自身はフォローできません。");
    const target = await db.prepare("SELECT id FROM users WHERE id = ?").bind(followedId).first();
    if (!target) return fail("ユーザーが見つかりません。", 404);
    const exists = await db.prepare("SELECT 1 FROM follows WHERE user_id = ? AND followed_id = ?").bind(user.id, followedId).first();
    if (exists) await db.prepare("DELETE FROM follows WHERE user_id = ? AND followed_id = ?").bind(user.id, followedId).run();
    else await db.prepare("INSERT INTO follows (user_id, followed_id) VALUES (?, ?)").bind(user.id, followedId).run();
    return json({ ok: true, following: !exists });
  }

  // メール削除（送信者または受信者本人のみ）
  match = path.match(/^\/api\/mail\/(\d+)$/);
  if (match && method === "DELETE") {
    const messageId = Number(match[1]);
    const message = await db.prepare("SELECT id, sender_id, receiver_id FROM messages WHERE id = ?").bind(messageId).first();
    if (!message) return fail("メールが見つかりません。", 404);
    if (Number(message.sender_id) !== Number(user.id) && Number(message.receiver_id) !== Number(user.id)) return fail("このメールを削除する権限がありません。", 403);
    await db.prepare("DELETE FROM messages WHERE id = ?").bind(messageId).run();
    return json({ ok: true, message: "メールを削除しました。" });
  }

  // 管理者パスワードの設定・変更（初回は管理者ログインのみで設定可能）
  if (path === "/api/admin/password" && method === "POST") {
    if (!user.is_admin) return fail("管理者のみ設定できます。", 403);
    const data = await bodyJSON(request);
    const nextPassword = String(data.new_password || "");
    const currentPassword = String(data.current_password || "");
    const config = await db.prepare("SELECT password_hash FROM admin_config WHERE id = 1").first();
    if (config && !(await verifyPassword(currentPassword, config.password_hash))) return fail("現在の管理者パスワードが違います。", 403);
    if (nextPassword.length < 8 || nextPassword.length > 128) return fail("管理者パスワードは8〜128文字にしてください。");
    const hashed = await hashPassword(nextPassword);
    await db.prepare(`INSERT INTO admin_config (id, password_hash, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = CURRENT_TIMESTAMP`).bind(hashed).run();
    return json({ ok: true, message: "管理者パスワードを保存しました。" });
  }

  if (path === "/api/admin/users" && method === "GET") {
    await requireAdmin(request, db);
    const result = await db.prepare(`
      SELECT id, username, display_name, avatar, is_admin, created_at
      FROM users ORDER BY id DESC LIMIT 1000
    `).all();

    return json({ ok: true, users: (result.results || []).map(publicUser) });
  }

  if (path === "/api/admin/posts" && method === "GET") {
    await requireAdmin(request, db);
    return json({ ok: true, posts: await listPosts(db, user) });
  }

  match = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (match && method === "DELETE") {
    await requireAdmin(request, db);
    const targetId = Number(match[1]);


    await db.batch([
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(targetId),
      db.prepare("DELETE FROM comments WHERE user_id = ?").bind(targetId),
      db.prepare("DELETE FROM likes WHERE user_id = ?").bind(targetId),
      db.prepare("DELETE FROM follows WHERE user_id = ? OR followed_id = ?")
        .bind(targetId, targetId),
      db.prepare("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?")
        .bind(targetId, targetId),
      db.prepare("DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)")
        .bind(targetId),
      db.prepare("DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)")
        .bind(targetId),
      db.prepare("DELETE FROM posts WHERE user_id = ?").bind(targetId),
      db.prepare("DELETE FROM users WHERE id = ?").bind(targetId),
    ]);

    return json({ ok: true, message: "アカウントを削除しました。" });
  }

  match = path.match(/^\/api\/admin\/posts\/(\d+)$/);
  if (match && method === "DELETE") {
    await requireAdmin(request, db);
    const postId = Number(match[1]);

    await db.batch([
      db.prepare("DELETE FROM comments WHERE post_id = ?").bind(postId),
      db.prepare("DELETE FROM likes WHERE post_id = ?").bind(postId),
      db.prepare("DELETE FROM posts WHERE id = ?").bind(postId),
    ]);

    return json({ ok: true, message: "投稿を削除しました。" });
  }

  return fail("APIが見つかりません。", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/signal/")) {
        if (!env.CALL_ROOMS) return new Response("CALL_ROOMS binding is missing", { status: 503 });
        const room = url.pathname.slice("/signal/".length).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
        if (!room) return new Response("Room ID required", { status: 400 });
        const id = env.CALL_ROOMS.idFromName(room);
        return env.CALL_ROOMS.get(id).fetch(request);
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleAPI(request, env);
      }

      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new Response("Japan Connect: Assets binding is missing.", {
        status: 503,
      });
    } catch (error) {
      console.error("Japan Connect Worker error:", error);
      return json(
        { ok: false, message: error.message || "サーバー内部でエラーが発生しました。" },
        500
      );
    }
  },
};

// WebRTC signaling relay. Media is sent peer-to-peer; this Durable Object relays only setup messages.
export class CallRoom {
  constructor(state, env) { this.state = state; this.env = env; this.clients = new Set(); }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket required", { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.clients.add(server);
    server.send(JSON.stringify({ type: "members", count: this.clients.size }));
    server.addEventListener("message", event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (!payload || typeof payload !== "object") return;
      const safe = JSON.stringify(payload);
      for (const peer of this.clients) {
        if (peer !== server) { try { peer.send(safe); } catch {} }
      }
    });
    const close = () => { this.clients.delete(server); for (const peer of this.clients) { try { peer.send(JSON.stringify({ type: "peer-left" })); } catch {} } };
    server.addEventListener("close", close); server.addEventListener("error", close);
    return new Response(null, { status: 101, webSocket: client });
  }
}

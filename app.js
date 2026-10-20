
const $ = (selector) => document.querySelector(selector);

const state = {
  token: localStorage.getItem("jc_token") || "",
  me: null,
  posts: [],
  users: [],
  messages: [],
  page: "home",
};

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  let response;

  try {
    response = await fetch(path, {
      ...options,
      headers,
    });
  } catch {
    throw new Error(
      "サーバーに接続できません。サーバーの起動状態と公開URLを確認してください。"
    );
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    throw new Error(
      `サーバーからJSON以外の応答が返りました（HTTP ${response.status}）。サーバーの接続先を確認してください。`
    );
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error("サーバーの応答を読み取れませんでした。");
  }

  if (!response.ok || data.ok === false) {
    throw new Error(
      data.message || data.error || `エラーが発生しました（HTTP ${response.status}）。`
    );
  }

  return data;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function showNotice(message, isError = false) {
  let notice = $("#jc-notice");

  if (!notice) {
    notice = document.createElement("div");
    notice.id = "jc-notice";
    notice.className = "notice";
    document.body.appendChild(notice);
  }

  notice.textContent = message;
  notice.classList.toggle("notice-error", isError);
  notice.hidden = false;
}

function showError(error) {
  console.error(error);
  showNotice(error.message || "エラーが発生しました。", true);
}

function saveToken(token) {
  state.token = token || "";

  if (state.token) {
    localStorage.setItem("jc_token", state.token);
  } else {
    localStorage.removeItem("jc_token");
  }
}

function showAuth() {
  $("#auth-view").hidden = false;
  $("#app-view").hidden = true;
}

function showApp() {
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;

  const name = $("#current-user");
  if (name && state.me) {
    name.textContent = state.me.display_name || state.me.username;
  }

  document.body.classList.toggle(
    "dark-mode",
    localStorage.getItem("jc_dark") === "true"
  );

  const adminNav = $("#nav-admin");
  if (adminNav) {
    adminNav.hidden = !state.me?.is_admin;
  }
}

function setAuthMode(mode) {
  const register = mode === "register";

  $("#auth-title").textContent = register
    ? "アカウントを作成"
    : "Japan Connect にログイン";

  $("#auth-submit").textContent = register
    ? "アカウント作成"
    : "ログイン";

  $("#display-name-field").hidden = !register;
  $("#auth-switch").textContent = register
    ? "すでにアカウントを持っている場合はログイン"
    : "初めての方はアカウントを作成";

  $("#auth-form").dataset.mode = mode;
  $("#auth-error").textContent = "";
}

async function handleAuth(event) {
  event.preventDefault();

  const mode = $("#auth-form").dataset.mode || "login";
  const username = $("#username").value.trim();
  const password = $("#password").value;
  const displayName = $("#display-name").value.trim();

  const button = $("#auth-submit");
  button.disabled = true;
  button.textContent = "処理中…";
  $("#auth-error").textContent = "";

  try {
    const result = await api(
      mode === "register" ? "/api/register" : "/api/login",
      {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          display_name: displayName || username,
        }),
      }
    );

    if (!result.token || !result.user) {
      throw new Error(
        "サーバーの応答にログイン情報がありません。サーバー側の設定を確認してください。"
      );
    }

    saveToken(result.token);
    state.me = result.user;

    showApp();
    await navigate("home");
    showNotice(result.message || "ログインしました。");
  } catch (error) {
    $("#auth-error").textContent = error.message;
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent =
      ($("#auth-form").dataset.mode || "login") === "register"
        ? "アカウント作成"
        : "ログイン";
  }
}

async function loadMe() {
  const result = await api("/api/me");
  state.me = result.user;
  return state.me;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("ja-JP");
}

function renderPost(post) {
  const isOwner = Number(post.user_id) === Number(state.me?.id);
  const canDelete = isOwner || Boolean(state.me?.is_admin);

  const comments = (post.comments || []).map((comment) => `
    <div class="comment">
      <strong>${escapeHTML(comment.display_name || comment.username)}</strong>
      <span>${escapeHTML(comment.content)}</span>
    </div>
  `).join("");

  return `
    <article class="post" data-post-id="${Number(post.id)}">
      <div class="post-header">
        <div>
          <strong>${escapeHTML(post.display_name || post.username)}</strong>
          <div class="muted">@${escapeHTML(post.username)}</div>
        </div>
        <time>${escapeHTML(formatDate(post.created_at))}</time>
      </div>

      <p class="post-content">${escapeHTML(post.content)}</p>

      <div class="post-actions">
        <button type="button" data-action="like" data-id="${Number(post.id)}">
          ${post.liked ? "♥" : "♡"} いいね (${Number(post.likes) || 0})
        </button>
        ${
          canDelete
            ? `<button type="button" class="danger" data-action="delete-post" data-id="${Number(post.id)}">削除</button>`
            : ""
        }
      </div>

      <div class="comments">
        ${comments}
        <form class="comment-form" data-id="${Number(post.id)}">
          <input name="content" maxlength="2000" placeholder="コメントを書く" required>
          <button type="submit">送信</button>
        </form>
      </div>
    </article>
  `;
}

async function loadPosts() {
  const result = await api("/api/posts");
  state.posts = result.posts || [];
  return state.posts;
}

async function renderHome() {
  const posts = await loadPosts();

  $("#page-content").innerHTML = `
    <section class="panel">
      <h2>ホーム</h2>
      <form id="post-form">
        <textarea name="content" maxlength="10000" placeholder="今何をしていますか？" required></textarea>
        <button type="submit">投稿する</button>
      </form>
    </section>
    <section class="post-list">
      ${posts.length
        ? posts.map(renderPost).join("")
        : '<p class="empty">まだ投稿がありません。最初の投稿をしてみよう！</p>'}
    </section>
  `;
}

async function renderMyChannel() {
  const posts = await loadPosts();
  const mine = posts.filter(
    (post) => Number(post.user_id) === Number(state.me?.id)
  );

  $("#page-content").innerHTML = `
    <section class="panel">
      <h2>マイチャンネル</h2>
      <p>自分の投稿を確認できます。</p>
      <p>投稿数：${mine.length}</p>
    </section>
    <section class="post-list">
      ${mine.length
        ? mine.map(renderPost).join("")
        : '<p class="empty">まだ投稿がありません。</p>'}
    </section>
  `;
}

async function renderMail() {
  const result = await api("/api/mail");
  state.messages = result.messages || [];

  $("#page-content").innerHTML = `
    <section class="panel">
      <h2>メール</h2>
      <p class="muted">相手のアカウント名を入力してメッセージを送信します。</p>
      <form id="mail-form">
        <label>送信先のアカウント名
          <input name="receiver_username" required maxlength="32">
        </label>
        <label>メッセージ
          <textarea name="content" required maxlength="5000"></textarea>
        </label>
        <button type="submit">送信する</button>
      </form>
    </section>

    <section class="panel">
      <h2>メッセージ一覧</h2>
      ${state.messages.length
        ? state.messages.map((message) => {
            const sent = Number(message.sender_id) === Number(state.me.id);
            const other = sent
              ? message.receiver_name || message.receiver_username
              : message.sender_name || message.sender_username;

            return `
              <article class="message">
                <strong>${sent ? "送信先" : "送信元"}：${escapeHTML(other)}</strong>
                <p>${escapeHTML(message.content)}</p>
                <time>${escapeHTML(formatDate(message.created_at))}</time>
              </article>
            `;
          }).join("")
        : '<p class="empty">メッセージはまだありません。</p>'}
    </section>
  `;
}

async function renderFriends() {
  const result = await api("/api/friends");
  state.users = result.friends || [];

  $("#page-content").innerHTML = `
    <section class="panel">
      <h2>ユーザー検索</h2>
      <input id="user-search" placeholder="アカウント名や表示名で検索">
      <div id="user-results"></div>
    </section>
  `;

  const draw = () => {
    const query = ($("#user-search").value || "").toLowerCase();
    const matches = state.users.filter((user) =>
      `${user.username} ${user.display_name}`.toLowerCase().includes(query)
    );

    $("#user-results").innerHTML = matches.length
      ? matches.map((user) => `
          <article class="user-card">
            <div>
              <strong>${escapeHTML(user.display_name || user.username)}</strong>
              <p class="muted">@${escapeHTML(user.username)}</p>
            </div>
            <button type="button" data-action="message-user"
              data-username="${escapeHTML(user.username)}">メールする</button>
          </article>
        `).join("")
      : '<p class="empty">ユーザーが見つかりません。</p>';
  };

  $("#user-search").addEventListener("input", draw);
  draw();
}

async function renderSearch() {
  const posts = await loadPosts();

  $("#page-content").innerHTML = `
    <section class="panel">
      <h2>投稿検索</h2>
      <input id="post-search" placeholder="投稿内容やユーザー名で検索">
      <div id="search-results" class="post-list"></div>
    </section>
  `;

  const draw = () => {
    const query = ($("#post-search").value || "").toLowerCase();
    const matches = posts.filter((post) =>
      `${post.content} ${post.username} ${post.display_name}`
        .toLowerCase().includes(query)
    );

    $("#search-results").innerHTML = matches.length
      ? matches.map(renderPost).join("")
      : '<p class="empty">一致する投稿がありません。</p>';
  };

  $("#post-search").addEventListener("input", draw);
  draw();
}

async function renderSettings() {
  $("#page-content").innerHTML = `
    <section class="panel">
      <h2>設定</h2>
      <p>ログイン中：${escapeHTML(state.me.display_name || state.me.username)}</p>
      <label class="setting-row">
        <span>ダークモード</span>
        <input type="checkbox" id="dark-toggle"
          ${localStorage.getItem("jc_dark") === "true" ? "checked" : ""}>
      </label>
      <button type="button" id="logout-button" class="danger">ログアウト</button>
    </section>
  `;

  $("#dark-toggle").addEventListener("change", (event) => {
    const enabled = event.target.checked;
    localStorage.setItem("jc_dark", String(enabled));
    document.body.classList.toggle("dark-mode", enabled);
  });

  $("#logout-button").addEventListener("click", logout);
}

async function renderAdmin() {
  if (!state.me?.is_admin) {
    throw new Error("管理者のみ利用できる画面です。");
  }

  const [usersResult, postsResult] = await Promise.all([
    api("/api/admin/users"),
    api("/api/admin/posts"),
  ]);

  const users = usersResult.users || [];
  const posts = postsResult.posts || [];

  $("#page-content").innerHTML = `
    <section class="panel">
      <h2>管理者画面</h2>
      <p>ユーザー数：${users.length} ／ 投稿数：${posts.length}</p>
      <p class="muted">削除操作は取り消せません。対象を確認してから操作してください。</p>
    </section>

    <section class="panel">
      <h3>アカウント管理</h3>
      <div class="admin-list">
        ${users.map((user) => `
          <article class="user-card">
            <div>
              <strong>${escapeHTML(user.display_name || user.username)}</strong>
              <p class="muted">@${escapeHTML(user.username)} · ID ${Number(user.id)}</p>
              ${user.is_admin ? '<span class="admin-label">管理者</span>' : ""}
            </div>
            ${
              Number(user.id) !== Number(state.me.id)
                ? `<button type="button" class="danger"
                    data-action="admin-delete-user" data-id="${Number(user.id)}">
                    アカウント削除
                  </button>`
                : '<span class="muted">ログイン中</span>'
            }
          </article>
        `).join("")}
      </div>
    </section>

    <section class="panel">
      <h3>投稿管理</h3>
      <div class="admin-list">
        ${posts.map((post) => `
          <article class="admin-post">
            <div>
              <strong>${escapeHTML(post.display_name || post.username)}</strong>
              <p>${escapeHTML(post.content)}</p>
              <span class="muted">投稿ID：${Number(post.id)}</span>
            </div>
            <button type="button" class="danger"
              data-action="admin-delete-post" data-id="${Number(post.id)}">
              投稿削除
            </button>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

async function navigate(page) {
  state.page = page;

  const titles = {
    home: "ホーム",
    channel: "マイチャンネル",
    mail: "メール",
    search: "検索",
    friends: "ユーザー",
    settings: "設定",
    admin: "管理者",
  };

  $("#page-title").textContent = titles[page] || "Japan Connect";

  document.querySelectorAll("[data-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  try {
    if (page === "home") await renderHome();
    else if (page === "channel") await renderMyChannel();
    else if (page === "mail") await renderMail();
    else if (page === "search") await renderSearch();
    else if (page === "friends") await renderFriends();
    else if (page === "settings") await renderSettings();
    else if (page === "admin") await renderAdmin();
    else throw new Error("指定された画面はありません。");
  } catch (error) {
    showError(error);
    $("#page-content").innerHTML = `
      <section class="panel">
        <h2>読み込みに失敗しました</h2>
        <p>${escapeHTML(error.message)}</p>
        <button type="button" id="retry-button">再読み込み</button>
      </section>
    `;
    $("#retry-button").addEventListener("click", () => navigate(page));
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
  } catch (error) {
    console.warn("ログアウト通知に失敗しました", error);
  }

  saveToken("");
  state.me = null;
  showAuth();
  setAuthMode("login");
  showNotice("ログアウトしました。");
}

async function handlePageSubmit(event) {
  const form = event.target;

  if (form.id === "post-form") {
    event.preventDefault();

    const content = new FormData(form).get("content");

    try {
      await api("/api/posts", {
        method: "POST",
        body: JSON.stringify({ content }),
      });

      showNotice("投稿しました。");
      await navigate(state.page);
    } catch (error) {
      showError(error);
    }
  }

  if (form.classList.contains("comment-form")) {
    event.preventDefault();

    const content = new FormData(form).get("content");
    const postId = form.dataset.id;

    try {
      await api(`/api/posts/${postId}/comments`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });

      showNotice("コメントしました。");
      await navigate(state.page);
    } catch (error) {
      showError(error);
    }
  }

  if (form.id === "mail-form") {
    event.preventDefault();

    const formData = new FormData(form);

    try {
      await api("/api/mail", {
        method: "POST",
        body: JSON.stringify({
          receiver_username: formData.get("receiver_username"),
          content: formData.get("content"),
        }),
      });

      showNotice("メッセージを送信しました。");
      await navigate("mail");
    } catch (error) {
      showError(error);
    }
  }
}

async function handleActionClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  const id = button.dataset.id;

  try {
    button.disabled = true;

    if (action === "like") {
      await api(`/api/posts/${id}/like`, {
        method: "POST",
        body: "{}",
      });
      await navigate(state.page);
    }

    if (action === "delete-post") {
      if (!confirm("この投稿を削除しますか？")) return;

      await api(`/api/posts/${id}`, { method: "DELETE" });
      showNotice("投稿を削除しました。");
      await navigate(state.page);
    }

    if (action === "admin-delete-user") {
      if (!confirm("このアカウントと関連データを削除しますか？")) return;

      await api(`/api/admin/users/${id}`, { method: "DELETE" });
      showNotice("アカウントを削除しました。");
      await navigate("admin");
    }

    if (action === "admin-delete-post") {
      if (!confirm("この投稿を削除しますか？")) return;

      await api(`/api/admin/posts/${id}`, { method: "DELETE" });
      showNotice("投稿を削除しました。");
      await navigate("admin");
    }

    if (action === "message-user") {
      const username = button.dataset.username;
      await navigate("mail");

      const receiver = document.querySelector(
        '#mail-form [name="receiver_username"]'
      );

      if (receiver) {
        receiver.value = username;
        receiver.focus();
      }
    }
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

async function startApp() {
  setAuthMode("login");

  $("#auth-form").addEventListener("submit", handleAuth);

  $("#auth-switch").addEventListener("click", () => {
    const current = $("#auth-form").dataset.mode || "login";
    setAuthMode(current === "login" ? "register" : "login");
  });

  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.page));
  });

  $("#page-content").addEventListener("submit", handlePageSubmit);
  $("#page-content").addEventListener("click", handleActionClick);

  if (!state.token) {
    showAuth();
    return;
  }

  try {
    await loadMe();

    if (!state.me) {
      saveToken("");
      showAuth();
      return;
    }

    showApp();
    await navigate("home");
  } catch (error) {
    console.error(error);
    saveToken("");
    state.me = null;
    showAuth();
  }
}

document.addEventListener("DOMContentLoaded", startApp);

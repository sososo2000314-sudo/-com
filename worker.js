
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // APIの動作確認
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        app: "Japan Connect",
        worker: "running",
        database: Boolean(env.DB)
      });
    }

    // APIのエラーをJSONで返す
    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        {
          ok: false,
          error: "API_SETUP_REQUIRED",
          message: env.DB
            ? "APIの設定が必要です"
            : "データベースの接続設定が必要です"
        },
        { status: 503 }
      );
    }

    // 既存の画面ファイルを配信する
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "Japan Connect - Worker is running. Assets setup required.",
      { status: 503 }
    );
  }
};

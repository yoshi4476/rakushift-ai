# =============================================================
# Rakushift AI Python Engine - Multi-stage / non-root Docker image
# =============================================================

# ---- Stage 1: builder (依存解決のみを行い、ホイールキャッシュを作る) ----
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# 最小限のビルドツール (PuLP の CBC ソルバ等で必要になり得る)
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --user -r requirements.txt


# ---- Stage 2: runtime (アプリだけが入った薄いイメージ) ----
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    BUILD_VERSION=2026.05.23.1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONIOENCODING=utf-8 \
    PATH=/home/appuser/.local/bin:$PATH

# curl は HEALTHCHECK で使用
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 appuser

# builder ステージから依存関係 (ユーザーローカル) をコピー
COPY --from=builder --chown=appuser:appuser /root/.local /home/appuser/.local

WORKDIR /app

# 実行に必要なファイルのみコピー (.dockerignore で除外される範囲も合わせて防御)
COPY --chown=appuser:appuser main.py scheduler.py ./

USER appuser

# Railway は PORT を注入。なければ 8080
EXPOSE 8080

# 自身の /health で DB 疎通まで確認
# CMD は exec form では shell 変数展開されないため、sh -c で明示展開する
# start-period を 30s に延長 (PuLP/CBC ソルバの初期ロードを考慮)
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
    CMD ["sh", "-c", "curl -fsS http://127.0.0.1:${PORT:-8080}/health || exit 1"]

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]

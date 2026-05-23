import os
import json
import hmac
import hashlib
import asyncio
import logging
import datetime as _datetime_module
import httpx
import stripe
from fastapi import FastAPI, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from scheduler import ShiftScheduler

# 構造化ログ。本番では INFO 以上、DEBUG/PII は出さない
logging.basicConfig(
    level=logging.INFO if os.environ.get("RAILWAY_ENVIRONMENT", "") == "production" else logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("rakushift")

# 本番環境フラグ（ログの個人情報マスク等に使用）
IS_PRODUCTION = os.environ.get("RAILWAY_ENVIRONMENT", "") == "production" or os.environ.get("IS_PRODUCTION", "") == "1"

# レート制限設定
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="Rakushift AI Engine", version="3.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS設定: 本番ドメインのみ許可
# 環境変数で固定オリジン (CSV) を上書き可。それと別に Cloudflare Pages の preview
# (xxx.rakushift-ai.pages.dev) 等のワイルドカードドメインは allow_origin_regex で対応
# (CORSMiddleware の allow_origins は完全一致のみ。glob は機能しない)
_env_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
ALLOWED_ORIGINS = _env_origins or [
    "https://rakushift-ai.pages.dev",
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
]
# Cloudflare Pages のプレビュー / 本番、Railway デプロイ URL を regex で許可
ALLOWED_ORIGIN_REGEX = r"^https://([a-z0-9-]+\.)*rakushift-ai\.pages\.dev$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === 環境変数 (フォールバック用。DB設定が優先) ===
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# DBから読み込んだプラットフォーム設定キャッシュ
_platform_settings = {}
_settings_loaded_at = 0

FRONTEND_URL = os.environ.get("FRONTEND_URL", "")

# グローバルhttpxクライアント（接続プール再利用でレイテンシ削減）
_http_client = None


def _get_http_client():
    """httpxクライアントのシングルトン取得"""
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=30)
    return _http_client


@app.on_event("shutdown")
async def shutdown_event():
    """アプリ終了時にhttpxクライアントをクローズ"""
    global _http_client
    if _http_client:
        await _http_client.aclose()
        _http_client = None


def _get_setting(key: str, env_fallback: str = "") -> str:
    """DB設定 → 環境変数 の優先順で値を取得"""
    val = _platform_settings.get(key, "")
    if val:
        return val
    return os.environ.get(key.upper(), env_fallback)


def _load_platform_settings():
    """SupabaseのRPCからプラットフォーム設定を読み込み (5分キャッシュ)"""
    global _platform_settings, _settings_loaded_at
    import time
    now = time.time()
    if now - _settings_loaded_at < 300 and _platform_settings:
        return  # 5分以内はキャッシュ利用
    if not SUPABASE_SERVICE_KEY:
        return
    try:
        url = "{}/rest/v1/rpc/get_platform_settings".format(SUPABASE_URL)
        resp = httpx.post(url, json={}, headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
            "Content-Type": "application/json",
        }, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, dict):
                _platform_settings = data
                _settings_loaded_at = now
                logger.info("Platform settings loaded: %d keys", len(data))
                # Stripeキーが設定されていれば適用
                sk = data.get("stripe_secret_key", "")
                if sk:
                    stripe.api_key = sk
    except Exception as e:
        logger.info("[Settings] Load failed: {}".format(e))


# 起動時に設定読み込み
_load_platform_settings()


# === リクエストモデル ===

class ShiftRequest(BaseModel):
    staff_list: List[Dict[str, Any]]
    config: Dict[str, Any]
    dates: List[str]
    requests: List[Dict[str, Any]] = []
    mode: str = "auto"
    contract_id: Optional[str] = None
    # empty_only モードで既存シフトを固定するため、フロントから既存シフトを渡せるように
    existing_shifts: List[Dict[str, Any]] = []


class DiagnoseRequest(BaseModel):
    contract_id: Optional[str] = None
    config: Dict[str, Any] = {}
    staff_count: int = 0
    shift_count: int = 0
    shifts: List[Dict[str, Any]] = []
    staff_list: List[Dict[str, Any]] = []


class InquiryRequest(BaseModel):
    """法人お問い合わせフォーム"""
    company_name: str
    company_address: str = ""
    phone: str
    contact_name: str
    contact_phone: str = ""  # 担当者個別連絡先 (DB スキーマと整合)
    plan_summary: str = ""
    # フロントは <input type="number"> の文字列値を送信するため str で受け、
    # DB INSERT 時に int に変換する。Pydantic v2 では Union/Strict が複雑なので str のまま保持。
    light_plan_count: str = "0"
    standard_plan_count: str = "0"
    premium_plan_count: str = "0"
    preferred_days: str = ""
    preferred_time: str = ""
    schedule_summary: str = ""
    message: str = ""


class CheckoutRequest(BaseModel):
    contract_id: str
    plan: str = "standard"  # "standard", "pro", or "premium"
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


class NewSubscriptionRequest(BaseModel):
    email: str
    org_name: str
    plan: str = "pro"
    contact_name: str = ""
    phone: str = ""
    contact_phone: str = ""
    address: str = ""
    referrer_code: str = ""
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


class PortalRequest(BaseModel):
    contract_id: str
    return_url: Optional[str] = None


# === ヘルパー関数 ===

def get_gemini_key() -> tuple:
    """DB設定優先でGeminiキーを取得"""
    _load_platform_settings()
    key = _get_setting("gemini_api_key")
    model = _get_setting("gemini_model", "gemini-2.0-flash")
    return key, model


async def supabase_rpc(function_name: str, params: dict) -> dict:
    """Supabase RPCをサービスキーで呼び出し"""
    if not SUPABASE_SERVICE_KEY:
        return {"status": "error", "message": "SUPABASE_SERVICE_KEY not configured"}
    url = "{}/rest/v1/rpc/{}".format(SUPABASE_URL, function_name)
    client = _get_http_client()
    resp = await client.post(url, json=params, headers={
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
        "Content-Type": "application/json",
    }, timeout=30)
    if resp.status_code != 200:
        return {"status": "error", "message": resp.text}
    return resp.json()


async def supabase_query(table: str, params: str = "", method: str = "GET",
                         body: dict = None) -> Any:
    """Supabase REST APIをサービスキーで呼び出し"""
    if not SUPABASE_SERVICE_KEY:
        return None
    url = "{}/rest/v1/{}?{}".format(SUPABASE_URL, table, params)
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    client = _get_http_client()
    if method == "GET":
        resp = await client.get(url, headers=headers, timeout=30)
    elif method == "PATCH":
        resp = await client.patch(url, headers=headers, json=body, timeout=30)
    elif method == "POST":
        resp = await client.post(url, headers=headers, json=body, timeout=30)
    else:
        return None
    if resp.status_code >= 400:
        logger.info("Supabase {} error: {}".format(method, resp.text))
        return None
    return resp.json()


def _validate_redirect_url(url: str) -> bool:
    """リダイレクトURLが許可ドメインか検証（オープンリダイレクト防止）"""
    if not url:
        return False
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        allowed = [
            "rakushift-ai.pages.dev",
            "localhost",
            "127.0.0.1",
        ]
        # FRONTEND_URLのホストも許可
        if FRONTEND_URL:
            fe_host = urlparse(FRONTEND_URL).hostname
            if fe_host:
                allowed.append(fe_host)
        return any(host == a or host.endswith("." + a) for a in allowed)
    except Exception:
        return False


async def verify_session_org_id(session_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """セッションID (x-session-id ヘッダー) から organization_id と role を取得。
    返り値: {"organization_id": "...", "role": "shop|admin|hq_admin"} or None
    SERVICE_KEY で auth_sessions を直接参照 (RLS バイパス)。期限切れ・不存在は None。
    """
    if not session_id or not SUPABASE_SERVICE_KEY or not SUPABASE_URL:
        return None
    try:
        url = "{}/rest/v1/auth_sessions?id=eq.{}&select=organization_id,role,expires_at".format(
            SUPABASE_URL, session_id)
        client = _get_http_client()
        resp = await client.get(url, headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
        }, timeout=5)
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not data:
            return None
        row = data[0]
        # 期限切れチェック
        from datetime import datetime, timezone
        try:
            expires_at = datetime.fromisoformat(str(row.get("expires_at", "")).replace("Z", "+00:00"))
            if expires_at < datetime.now(timezone.utc):
                return None
        except Exception:
            return None
        return {
            "organization_id": row.get("organization_id"),
            "role": row.get("role"),
        }
    except Exception:
        return None


# === ヘルスチェック ===

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Rakushift Engine v3.2 Ready", "build": "2026.05.23.1"}


@app.get("/health")
async def health_check():
    """Railway/Cloudflare 用の本物のヘルスチェック。
    DB 疎通が取れて初めて 200 を返す。NG なら 503 で restart を促す。"""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        # シークレット未設定は構成エラー扱い
        return JSONResponse(status_code=503, content={"status": "error", "db": "not_configured"})
    try:
        client = _get_http_client()
        resp = await client.get(
            "{}/rest/v1/organizations".format(SUPABASE_URL),
            params={"select": "id", "limit": "1"},
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
            },
            timeout=5,
        )
        if resp.status_code != 200:
            return JSONResponse(status_code=503, content={"status": "error", "db": "http_{}".format(resp.status_code)})
        return {"status": "ok", "db": "alive"}
    except Exception as e:
        logger.warning("health check failed: %s", e)
        return JSONResponse(status_code=503, content={"status": "error", "db": "unreachable"})


@app.get("/keepalive")
async def keepalive():
    """Supabase無料プランの自動停止を防ぐためのヘルスチェック。
    Railwayのヘルスチェックと兼用。Supabaseへクエリを発行して
    プロジェクトをアクティブに保つ。"""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return {"status": "ok", "db": "skipped", "reason": "no credentials"}
    try:
        result = await supabase_query(
            "organizations", "select=id&limit=1", method="GET")
        row_count = len(result) if isinstance(result, list) else 0
        logger.info("[Keepalive] Supabase ping OK - {} rows".format(row_count))
        return {"status": "ok", "db": "alive", "rows": row_count}
    except Exception as e:
        msg = repr(e)
        logger.info("[Keepalive] Supabase ping FAILED: {}".format(msg))
        return {"status": "ok", "db": "error", "message": "DB接続エラー" if IS_PRODUCTION else msg}


@app.post("/run-migration")
async def run_migration(request: Request):
    """HQ管理者テーブル・RPC関数のマイグレーションを実行。
    service_keyを使ってSupabase PostgreSQL RPCでSQLを直接実行する。
    セキュリティ: 環境変数MIGRATION_TOKENで保護。"""

    body = await request.json()
    token = body.get("token", "")
    migration_token = os.environ.get("MIGRATION_TOKEN", "")

    if not migration_token:
        return {"status": "error", "message": "MIGRATION_TOKEN not configured. Set it as an environment variable."}

    if token != migration_token:
        return {"status": "error", "message": "Invalid migration token"}

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return {"status": "error", "message": "Supabase credentials not configured"}

    # HQ管理者マイグレーションSQL群を順番に実行
    sqls = [
        # 1. hq_adminsテーブル作成
        """CREATE TABLE IF NOT EXISTS hq_admins (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            login_id TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )""",
        # 2. 初期アカウント
        """INSERT INTO hq_admins (login_id, password) 
           VALUES ('hq_master', crypt('rakushift_hq', gen_salt('bf')))
           ON CONFLICT (login_id) DO NOTHING""",
        # 3. hq_login RPC
        """CREATE OR REPLACE FUNCTION hq_login(p_login_id TEXT, p_password TEXT) 
           RETURNS JSONB AS $fn$
           DECLARE v_admin RECORD;
           BEGIN
               SELECT * INTO v_admin FROM hq_admins WHERE login_id = p_login_id;
               IF NOT FOUND THEN 
                   RETURN jsonb_build_object('status', 'error', 'message', '本部IDが存在しません'); 
               END IF;
               IF v_admin.password = crypt(p_password, v_admin.password) THEN
                   RETURN jsonb_build_object('status', 'success', 'role', 'hq_admin', 'login_id', v_admin.login_id);
               ELSE
                   RETURN jsonb_build_object('status', 'error', 'message', 'パスワードが違います');
               END IF;
           END;
           $fn$ LANGUAGE plpgsql SECURITY DEFINER""",
        # 4. hq_get_all_shops RPC
        """CREATE OR REPLACE FUNCTION hq_get_all_shops() 
           RETURNS JSONB AS $fn$
           DECLARE res JSONB;
           BEGIN
               SELECT jsonb_agg(jsonb_build_object(
                   'organization_id', o.id, 'name', o.name,
                   'contract_id', c.contract_id, 'plan', c.stripe_plan,
                   'created_at', o.created_at
               ) ORDER BY o.created_at DESC) INTO res
               FROM organizations o JOIN config c ON o.id = c.organization_id;
               RETURN COALESCE(res, '[]'::jsonb);
           END;
           $fn$ LANGUAGE plpgsql SECURITY DEFINER""",
    ]

    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    results = []
    async with httpx.AsyncClient(timeout=30) as client:
        for i, sql in enumerate(sqls):
            try:
                # Supabase の pg_query RPC または直接 SQL 実行
                resp = await client.post(
                    "{}/rest/v1/rpc/exec_sql".format(SUPABASE_URL),
                    headers=headers,
                    json={"query": sql}
                )
                if resp.status_code == 404:
                    # exec_sql RPC が無い場合、Supabase Management API を試す
                    # 代替: supabase-py の admin機能を使う
                    results.append({"step": i+1, "status": "skipped", "reason": "exec_sql RPC not found"})
                elif resp.status_code < 300:
                    results.append({"step": i+1, "status": "ok"})
                else:
                    results.append({"step": i+1, "status": "error", "detail": "SQL実行エラー" if IS_PRODUCTION else resp.text[:200]})
            except Exception as e:
                results.append({"step": i+1, "status": "error", "detail": "SQL実行エラー" if IS_PRODUCTION else str(e)[:200]})

    return {"status": "completed", "results": results}



# =============================================================
# 本部管理 API
# =============================================================

@app.get("/hq/shops")
async def hq_get_shops(request: Request):
    """本部用: 全テナント店舗一覧を取得（サービスキーでRLSバイパス）"""
    # セッション認証（HQセッションのみ許可）
    session_id = request.headers.get("x-session-id", "")
    if not session_id or not session_id.startswith("hq_"):
        return JSONResponse(status_code=403, content={"error": "本部認証が必要です"})

    try:
        # organizationsテーブルから全店舗取得
        orgs = await supabase_query(
            "organizations",
            "select=id,name,created_at&order=created_at.desc"
        )
        if not orgs:
            orgs = []

        # configテーブルから契約情報取得
        configs = await supabase_query(
            "config",
            "select=organization_id,contract_id,stripe_plan,staff_count,customer_email,contact_name,license_status"
        )
        config_map = {}
        if configs:
            for c in configs:
                config_map[c.get("organization_id")] = c

        # 結合
        shops = []
        for o in orgs:
            cfg = config_map.get(o["id"], {})
            shops.append({
                "organization_id": o["id"],
                "name": o.get("name", "未設定"),
                "contract_id": cfg.get("contract_id", ""),
                "plan": cfg.get("stripe_plan", "free"),
                "staff_count": cfg.get("staff_count", 0),
                "contact_name": cfg.get("contact_name", ""),
                "customer_email": cfg.get("customer_email", ""),
                "license_status": cfg.get("license_status", "active"),
                "created_at": o.get("created_at", ""),
            })

        return shops
    except Exception as e:
        logger.info("[HQ] Shop list error: {}".format(e))
        return JSONResponse(status_code=500, content={"error": "店舗一覧の取得に失敗しました"})


# =============================================================
# シフト生成 API
# =============================================================

@app.post("/check")
@limiter.limit("20/minute")
def check_feasibility(request: Request, req: ShiftRequest):
    try:
        scheduler = ShiftScheduler(
            req.staff_list, req.config, req.dates, req.requests,
            existing_shifts=req.existing_shifts)
        result = scheduler.pre_check()
        return {"status": "success", "check": result}
    except Exception as e:
        logger.info("Check Error: {}".format(e))
        err_msg = "チェック中にエラーが発生しました" if IS_PRODUCTION else str(e)
        return {"status": "error", "message": err_msg}


@app.post("/generate")
@limiter.limit("10/minute")
async def generate_shifts(request: Request, req: ShiftRequest,
                          x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    logger.info("Received request: {} staff, {} dates, mode={}".format(
        len(req.staff_list), len(req.dates), req.mode))

    try:
        # === セッション検証: 信頼できる org_id をサーバ側で確定する ===
        session_info = await verify_session_org_id(x_session_id)
        if not session_info or not session_info.get("organization_id"):
            return JSONResponse(status_code=401, content={
                "status": "error",
                "message": "セッションが無効または期限切れです。再ログインしてください。"
            })
        org_id = session_info["organization_id"]
        front_org_id = req.config.get("organization_id")
        if front_org_id and str(front_org_id) != str(org_id):
            return JSONResponse(status_code=403, content={
                "status": "error",
                "message": "セッションとリクエストの組織が一致しません。"
            })

        # 検証済み org_id で plan を取得 (DB 値を信頼)
        plan = "standard"
        if SUPABASE_SERVICE_KEY:
            try:
                client = _get_http_client()
                resp = await client.get(
                    "{}/rest/v1/config_safe".format(SUPABASE_URL),
                    params={"organization_id": "eq.{}".format(org_id), "select": "stripe_plan", "limit": "1"},
                    headers={"apikey": SUPABASE_SERVICE_KEY, "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY)},
                    timeout=5)
                if resp.status_code == 200:
                    data = resp.json()
                    if data and isinstance(data, list) and len(data) > 0:
                        plan = data[0].get("stripe_plan") or "standard"
            except Exception as e:
                logger.info("Plan verification error: {}".format(e))

        limit = 10
        if plan == "pro": limit = 50
        if plan == "premium": limit = 9999
        if len(req.staff_list) > limit:
            return {"status": "error", "message": "スタッフ数がプラン上限({}名)を超過しています。".format(limit)}

        scheduler = ShiftScheduler(
            req.staff_list, req.config, req.dates, req.requests,
            existing_shifts=req.existing_shifts)


        force = (req.mode == "force")
        logger.info("[Generate] mode={} existing_shifts={}".format(req.mode, len(req.existing_shifts)))
        # 重い MILP 計算は別スレッドへ逃してイベントループのブロックを防ぐ
        result = await asyncio.to_thread(scheduler.solve, force=force)

        if not result:
            return {"status": "success", "mode": "math_failed", "shifts": []}

        # 生成結果のスタッフカバレッジをログ出力
        result_staff_ids = set(s["staff_id"] for s in result)
        logger.info("[Generate] Result: {} shifts covering {}/{} staff".format(
            len(result), len(result_staff_ids), len(req.staff_list)))

        # Gemini監査 (環境変数のAPIキーを使用)
        gemini_key, gemini_model = get_gemini_key()
        if gemini_key:
            logger.info("Running Gemini audit (server-side)...")
            audited = run_gemini_audit(gemini_key, gemini_model, req, result)
            if audited:
                # 監査結果の品質チェック: シフト数やスタッフカバレッジが減少していないか
                original_staff_ids = set(s["staff_id"] for s in result)
                audited_staff_ids = set(s["staff_id"] for s in audited)
                original_count = len(result)
                audited_count = len(audited)
                missing_staff = original_staff_ids - audited_staff_ids

                # シフト数が50%以下に減少した場合は破棄
                if audited_count < original_count * 0.5:
                    logger.info("[Gemini Audit] REJECTED: shift count dropped too much ({} -> {})".format(
                        original_count, audited_count))
                # シフト数が30%以上増加した場合も破棄（過剰配置防止）
                elif audited_count > original_count * 1.3:
                    logger.info("[Gemini Audit] REJECTED: shift count increased too much ({} -> {})".format(
                        original_count, audited_count))
                # スタッフが1人でも消えた場合は破棄（全スタッフのシフトを保護）
                elif len(missing_staff) > 0:
                    logger.info("[Gemini Audit] REJECTED: {} staff lost shifts: {}".format(
                        len(missing_staff), missing_staff))
                else:
                    # Gemini audit が reason フィールドを返さないことが多いため、
                    # 元の result から (staff_id, date) キーで reason を引き戻す。
                    # これでフロントのプレビューに「配置理由」が確実に表示される。
                    original_reasons = {(s.get("staff_id"), s.get("date")): s.get("reason") for s in result}
                    for c in audited:
                        if not c.get("reason"):
                            c["reason"] = original_reasons.get((c.get("staff_id"), c.get("date")), "Geminiが微調整")
                    result = audited
                    return {
                        "status": "success",
                        "mode": "math_plus_gemini_audit" if not force else "math_force_plus_gemini",
                        "shifts": result,
                        "report": getattr(scheduler, "_last_report", None)
                    }

        return {
            "status": "success",
            "mode": "math_force" if force else "math",
            "shifts": result,
            "report": getattr(scheduler, "_last_report", None)
        }

    except Exception as e:
        logger.info("Error: {}".format(e))
        import traceback
        traceback.print_exc()
        err_msg = "シフト生成中にエラーが発生しました" if IS_PRODUCTION else str(e)
        return {"status": "error", "message": err_msg}


# =============================================================
# AI診断 API
# =============================================================

@app.post("/diagnose")
@limiter.limit("10/minute")
def diagnose_shifts(request: Request, req: DiagnoseRequest):
    try:
        gemini_key, gemini_model = get_gemini_key()
        if not gemini_key:
            return {"status": "error", "message": "AI機能は現在利用できません", "suggestions": []}

        config = req.config
        staff_req = config.get("staff_req", {})
        break_rules = config.get("break_rules", [
            {"min_hours": 6, "break_minutes": 45},
            {"min_hours": 8, "break_minutes": 60}
        ])

        time_staff_req = config.get("time_staff_req", [])
        
        prompt = """あなたはプロの店舗マネージャーであり、日本の労働基準法に精通しています。
以下のシフトデータを分析し、改善点やリスクを指摘してください。

【店舗ルール】
- 営業時間: {} - {}
- 最低人数（常に必要なベース人数）: 平日{}名, 土日{}名, 祝日{}名
- 時間帯別の必要人数要件: {}
- 最低管理者数: {}名
- 休憩ルール: {}

【日本の労働基準法チェック項目】
1. 1日8時間超の勤務がないか (労基法32条)
2. 週40時間超の勤務がないか (労基法32条)
3. 6時間超勤務で45分以上、8時間超勤務で60分以上の休憩があるか (労基法34条)
4. 週1日以上の休日があるか / 連続7日以上勤務がないか (労基法35条)

【スタッフ情報】
{}

【シフトデータ】
- スタッフ数: {}名
- シフト数: {}コマ
- 詳細: {}

【分析してほしいこと】
1. 労基法違反リスク（上記4項目）
2. 人員不足のリスクと時間帯（「12:00-15:00の中番で1名不足」のように、早番・中番・遅番など具体的にどの時間帯で人が足りないかを特定し、誰の出勤を追加するか・誰のシフトを延長するか等の「具体的な改善策」を必ず提示すること）
3. 特定スタッフへの負荷偏り（連勤、長時間労働）
4. 管理者不在の時間帯
5. 新人が一人で入っている時間帯

回答は以下のJSON配列形式のみで出力してください。Markdownは不要です。
[
  {{"type": "danger", "title": "...", "desc": "...", "action": "..."}},
  {{"type": "warning", "title": "...", "desc": "...", "action": "..."}},
  {{"type": "info", "title": "...", "desc": "...", "action": "..."}}
]

typeは重要度順: danger(労基法違反) > warning(人員不足など重大リスク) > info(改善提案)""".format(
            config.get("opening_time", "09:00"),
            config.get("closing_time", "22:00"),
            staff_req.get("min_weekday", 2),
            staff_req.get("min_weekend", 3),
            staff_req.get("min_holiday", 3),
            json.dumps(time_staff_req, ensure_ascii=False) if time_staff_req else "特になし",
            staff_req.get("min_manager", 1),
            json.dumps(break_rules, ensure_ascii=False),
            json.dumps([{
                "id": s.get("id", ""),
                "name": s.get("name", ""),
                "role": s.get("role", "staff"),
                "max_hours": s.get("max_hours_day", 8),
                "max_days": s.get("max_days_week", 5),
                "evaluation": s.get("evaluation", "B"),
                "salary_type": s.get("salary_type", "hourly"),
            } for s in req.staff_list], ensure_ascii=False),
            req.staff_count,
            req.shift_count,
            json.dumps(req.shifts[:500], ensure_ascii=False),  # 最大500件に拡張（月間シフト対応）
        )

        url = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}".format(
            gemini_model, gemini_key)
        resp = httpx.post(url, json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json"
            }
        }, timeout=60)

        if resp.status_code != 200:
            return {"status": "error",
                    "message": "AI応答エラー ({})".format(resp.status_code),
                    "suggestions": []}

        try:
            data = resp.json()
            text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
        except (ValueError, AttributeError, IndexError, TypeError, KeyError) as parse_err:
            logger.error("[Gemini Diagnose] Response structure unexpected: %s", parse_err)
            return {"status": "error", "message": "AI応答の形式が不正です", "suggestions": []}
        if not text:
            return {"status": "error", "message": "AIからの応答がありません", "suggestions": []}

        try:
            suggestions = json.loads(text)
        except json.JSONDecodeError as je:
            logger.error("[Gemini Diagnose] JSON parse failed: %s. Raw: %s", je, text[:300])
            return {"status": "error", "message": "AIの返答が解釈できませんでした", "suggestions": []}
        return {"status": "success", "suggestions": suggestions}

    except Exception as e:
        logger.exception("AI diagnose failed")
        err_msg = "AI診断中にエラーが発生しました" if IS_PRODUCTION else str(e)
        return {"status": "error", "message": err_msg, "suggestions": []}


# =============================================================
# Gemini監査
# =============================================================

def run_gemini_audit(api_key: str, model: str, req: ShiftRequest, shifts: list) -> list:
    """Gemini APIでシフトを監査・修正 (サーバーサイド)"""
    try:
        url = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}".format(
            model, api_key)

        config = req.config
        staff_req = config.get("staff_req", {})
        break_rules = config.get("break_rules", [
            {"min_hours": 6, "break_minutes": 45},
            {"min_hours": 8, "break_minutes": 60}
        ])
        closed_days_names = []
        day_names = ["日", "月", "火", "水", "木", "金", "土"]
        for cd in config.get("closed_days", []):
            cd = int(cd)  # DB経由で文字列になる場合の安全策
            if 0 <= cd < 7:
                closed_days_names.append(day_names[cd])

        staff_info = []
        for s in req.staff_list:
            staff_info.append({
                "id": s["id"],
                "name": s.get("name", ""),
                "role": s.get("role", "staff"),
                "max_days": s.get("max_days_week", 5),
                "max_hours": s.get("max_hours_day", 8),
                "evaluation": s.get("evaluation", "B"),
                "salary_type": s.get("salary_type", "hourly"),
                "ng_dates": s.get("unavailable_dates", ""),
            })

        shift_summary = []
        for s in shifts:
            shift_summary.append({
                "staff_id": s["staff_id"],
                "date": s["date"],
                "start": s["start_time"],
                "end": s["end_time"],
            })

        prompt = """あなたは日本の労働基準法に精通した熟練シフト管理者AIです。
Pythonシステムが生成した「一次シフト案」を監査し、以下の全ルールに違反がないか検証してください。
違反があれば**最小限の修正**を加え、なければそのまま出力してください。

=== 最重要: 最小変更原則 ===
- 一次シフト案はMILPソルバーで最適化済みです。人員配置バランスが計算されています。
- 労基法違反の修正以外は、シフトの追加・削除・時間変更をしないでください。
- 各時間帯の同時在籍人数が「必要人数±1」の範囲に収まるように維持してください。
- スタッフの追加や入れ替えにより、他の日の人員バランスが崩れないよう注意してください。

=== 絶対遵守ルール (違反は許されない) ===
1. スタッフの希望休(unavailable_dates/承認済みoff)には絶対に配置しない
2. 1日の最大労働時間(max_hours_day)を超えない
3. 週の最大勤務日数(max_days_week)を超えない
4. 連続7日以上の勤務を禁止 (労基法35条: 週1日以上の休日)
5. 週40時間を超える勤務を禁止 (労基法32条)
6. 定休日({})には配置しない
7. 臨時休業日({})には配置しない

=== 休憩ルール (労基法34条) ===
{}

=== 推奨ルール (可能な限り遵守) ===
- 管理者(manager/leader)が各シフトに最低{}名
- 平日最低{}名、土日最低{}名、祝日最低{}名
- 時間帯別の必要人数要件: {}
- 月給スタッフは週5日程度配置
- 新人(evaluation=D)がいる場合はメンター(manager/leader)も配置

=== 入力データ ===
【スタッフ】
{}

【対象日付】
{}

【一次シフト案】
{}

=== 出力形式 ===
修正後の完全なシフト表をJSON配列で出力してください。
**重要**: 純粋なJSON配列のみ出力。マークダウンや解説は不要。
**重要**: 違反がない場合は一次シフト案をそのまま出力してください。不要な変更はしないでください。
[
  {{"staff_id": "...", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "break_minutes": 60, "is_irregular": false}},
  ...
]
※ 欠員補充のために社員（monthly）のシフトを延長した、または休みから呼び出した場合は、該当シフトの `"is_irregular": true` としてください。通常シフトは `false` です。""".format(
            "、".join(closed_days_names) if closed_days_names else "なし",
            ", ".join(config.get("special_holidays", [])) if config.get("special_holidays") else "なし",
            json.dumps(break_rules, ensure_ascii=False),
            staff_req.get("min_manager", 1),
            staff_req.get("min_weekday", 2),
            staff_req.get("min_weekend", 3),
            staff_req.get("min_holiday", 3),
            json.dumps(config.get("time_staff_req", []), ensure_ascii=False) if config.get("time_staff_req") else "特になし",
            json.dumps(staff_info, ensure_ascii=False),
            json.dumps(req.dates),
            json.dumps(shift_summary, ensure_ascii=False),
        )

        resp = httpx.post(url, json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json"
            }
        }, timeout=90)

        if resp.status_code != 200:
            logger.info("Gemini API error: {}".format(resp.status_code))
            return None

        try:
            data = resp.json()
            text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
        except (ValueError, AttributeError, IndexError, TypeError, KeyError) as parse_err:
            logger.warning("[Gemini Audit] Response structure unexpected, skipping audit: %s", parse_err)
            return None
        if not text:
            return None

        try:
            fixed = json.loads(text)
        except json.JSONDecodeError as je:
            logger.warning("[Gemini Audit] JSON parse failed, skipping audit: %s. Raw: %s", je, text[:200])
            return None

        # 配列でない場合の対応
        if isinstance(fixed, dict):
            fixed = fixed.get("shifts", fixed.get("data", []))
        if not isinstance(fixed, list):
            return None

        # データ整合性チェック・補完
        valid_staff_ids = {s["id"] for s in req.staff_list}
        valid_dates = set(req.dates)
        cleaned = []
        for s in fixed:
            if not all(k in s for k in ("staff_id", "date", "start_time", "end_time")):
                continue
            if s["staff_id"] not in valid_staff_ids:
                continue
            if s["date"] not in valid_dates:
                continue
            s.setdefault("break_minutes", 60)
            # 休憩時間の再計算（日またぎ対応）
            start_min = int(s["start_time"].split(":")[0]) * 60 + int(s["start_time"].split(":")[1])
            end_min = int(s["end_time"].split(":")[0]) * 60 + int(s["end_time"].split(":")[1])
            if end_min <= start_min:
                end_min += 1440  # 日またぎ: 24時間加算
            hours = (end_min - start_min) / 60.0
            if hours >= 8:
                s["break_minutes"] = max(s["break_minutes"], 60)
            elif hours >= 6:
                s["break_minutes"] = max(s["break_minutes"], 45)
            cleaned.append(s)

        if not cleaned:
            return None

        logger.info("[Gemini Audit] {} -> {} shifts".format(len(shifts), len(cleaned)))
        return cleaned

    except Exception as e:
        logger.info("Gemini audit error: {}".format(e))
        import traceback
        traceback.print_exc()
        return None


# =============================================================
# Stripe決済 API
# =============================================================

async def send_welcome_email(to_email: str, org_name: str, contract_id: str,
                             password: str, login_url: str, plan: str):
    """新規テナントへのウェルカムメール送信 (SMTP)"""
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    smtp_host = _get_setting("smtp_host")
    smtp_port = int(_get_setting("smtp_port") or "587")
    smtp_user = _get_setting("smtp_user")
    smtp_pass = _get_setting("smtp_pass")
    smtp_from = _get_setting("smtp_from") or smtp_user

    if not smtp_host or not smtp_user or not smtp_pass:
        logger.info("[Email] SMTP not configured. Skipping email to {}".format(to_email))
        logger.info("[Email] Contract ID: {} (SMTP not configured, credentials not logged)".format(contract_id))
        return

    plan_name = {"standard": "Standard", "pro": "Pro", "premium": "Premium"}.get(plan, plan)

    subject = "【ラクシフトAI】ご契約ありがとうございます - ログイン情報のご案内"
    html_body = """
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #3b82f6, #6366f1); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">ラクシフトAI</h1>
        <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">AIシフト管理システム</p>
    </div>
    <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <h2 style="color: #1f2937; margin-top: 0;">ご契約ありがとうございます</h2>
        <p style="color: #4b5563;"><strong>{org_name}</strong> 様</p>
        <p style="color: #4b5563;">{plan_name}プランのご契約が完了しました。以下の情報でログインできます。</p>

        <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 8px 0; color: #6b7280; width: 120px;">ログインURL</td><td style="padding: 8px 0;"><a href="{login_url}" style="color: #3b82f6; font-weight: bold;">{login_url}</a></td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">契約ID</td><td style="padding: 8px 0; font-family: monospace; font-size: 18px; font-weight: bold; color: #1f2937;">{contract_id}</td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">店舗パスワード</td><td style="padding: 8px 0; font-family: monospace; font-weight: bold; color: #1f2937;">{password}</td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">管理者ID</td><td style="padding: 8px 0; font-family: monospace; font-weight: bold; color: #1f2937;">admin</td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">管理者パスワード</td><td style="padding: 8px 0; font-family: monospace; font-weight: bold; color: #1f2937;">{password}</td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">プラン</td><td style="padding: 8px 0; font-weight: bold; color: #3b82f6;">{plan_name}</td></tr>
            </table>
        </div>

        <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="color: #92400e; margin: 0; font-size: 13px;"><strong>セキュリティのお願い:</strong> ログイン後、設定画面からパスワードを変更してください。</p>
        </div>

        <h3 style="color: #1f2937; margin-top: 24px;">ご利用の流れ</h3>
        <ol style="color: #4b5563; line-height: 2;">
            <li>上記URLからログイン</li>
            <li>管理者ログインで管理画面に入る</li>
            <li>スタッフを登録</li>
            <li>シフト表を自動作成</li>
        </ol>

        <p style="color: #9ca3af; font-size: 12px; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 15px;">
            このメールはラクシフトAIから自動送信されています。<br>
            ご不明な点がございましたら、運営までお問い合わせください。
        </p>
    </div>
</div>
""".format(
        org_name=org_name, plan_name=plan_name, login_url=login_url,
        contract_id=contract_id, password=password,
    )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = smtp_from
    msg["To"] = to_email
    msg.attach(MIMEText(html_body, "html"))

    def _send_sync():
        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_from, to_email, msg.as_string())

    # SMTP リトライ (3回、指数バックオフ)
    max_retries = 3
    for attempt in range(max_retries):
        try:
            await asyncio.to_thread(_send_sync)
            logger.info("Welcome email sent to %s (attempt %d)", to_email, attempt + 1)
            return
        except Exception as e:
            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)
                continue
            # 最終失敗: 顧客にメールが届かない致命的事象。Railway logs に ERROR で残す
            logger.error("Welcome email PERMANENTLY FAILED to %s after %d attempts: %s. Manual resend required.", to_email, max_retries, e)


@app.post("/stripe/new-subscription")
@limiter.limit("5/minute")
async def new_subscription(request: Request, req: NewSubscriptionRequest):
    """新規お申し込み: 決済完了後にテナント自動作成+メール送信"""
    _load_platform_settings()
    sk = _get_setting("stripe_secret_key")
    if not sk:
        return JSONResponse(status_code=500, content={"error": "Stripe is not configured"})
    stripe.api_key = sk

    try:
        plan_key = {
            "standard": "stripe_price_standard",
            "pro": "stripe_price_pro",
            "premium": "stripe_price_premium",
        }.get(req.plan, "stripe_price_pro")
        price_id = _get_setting(plan_key)

        if not price_id:
            return JSONResponse(status_code=500,
                                content={"error": "Price ID not configured for plan: {}".format(req.plan)})

        if not req.success_url or not req.cancel_url:
            return JSONResponse(status_code=400,
                                content={"error": "success_url and cancel_url are required"})

        # オープンリダイレクト防止: 許可ドメインのみ受け入れ
        if not _validate_redirect_url(req.success_url) or not _validate_redirect_url(req.cancel_url):
            return JSONResponse(status_code=400,
                                content={"error": "不正なリダイレクトURLです"})

        referrer_code = (req.referrer_code or "").strip().upper()

        # Stripeカスタマー作成
        customer = stripe.Customer.create(
            email=req.email,
            name=req.org_name,
            phone=req.phone,
            address={"line1": req.address} if req.address else None,
            metadata={
                "org_name": req.org_name,
                "plan": req.plan,
                "contact_name": req.contact_name,
                "phone": req.phone,
                "contact_phone": req.contact_phone,
                "address": req.address,
                "referrer_code": referrer_code,
            }
        )

        # チェックアウトセッション (テナント未作成のため contract_id なし)
        session = stripe.checkout.Session.create(
            customer=customer.id,
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            mode="subscription",
            success_url=req.success_url,
            cancel_url=req.cancel_url,
            metadata={
                "type": "new_subscription",
                "org_name": req.org_name,
                "email": req.email,
                "plan": req.plan,
                "contact_name": req.contact_name,
                "phone": req.phone,
                "contact_phone": req.contact_phone,
                "address": req.address,
                "referrer_code": referrer_code,
            },
            subscription_data={
                "metadata": {
                    "type": "new_subscription",
                    "org_name": req.org_name,
                    "email": req.email,
                    "plan": req.plan,
                    "contact_name": req.contact_name,
                    "phone": req.phone,
                    "contact_phone": req.contact_phone,
                    "address": req.address,
                    "referrer_code": referrer_code,
                }
            },
            allow_promotion_codes=True,
        )

        return {"url": session.url, "session_id": session.id}

    except stripe.error.StripeError as e:
        logger.info("Stripe Error: {}".format(e))
        err_msg = "決済処理中にエラーが発生しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=400, content={"error": err_msg})
    except Exception as e:
        logger.info("New Subscription Error: {}".format(e))
        err_msg = "サーバーエラーが発生しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=500, content={"error": err_msg})


@app.post("/stripe/create-checkout")
@limiter.limit("5/minute")
async def create_checkout_session(request: Request, req: CheckoutRequest):
    """Stripeチェックアウトセッション作成"""
    _load_platform_settings()
    sk = _get_setting("stripe_secret_key")
    if not sk:
        return JSONResponse(status_code=500,
                            content={"error": "Stripe is not configured"})
    stripe.api_key = sk

    try:
        # contract_idからconfigを取得してstripe_customer_idを確認
        configs = await supabase_query(
            "config",
            "contract_id=eq.{}&select=id,organization_id,stripe_customer_id,contract_id".format(
                req.contract_id))

        if not configs or len(configs) == 0:
            return JSONResponse(status_code=404,
                                content={"error": "Contract not found"})

        config = configs[0]
        customer_id = config.get("stripe_customer_id")

        # Stripeカスタマーが未作成なら作成
        if not customer_id:
            customer = stripe.Customer.create(
                metadata={
                    "contract_id": req.contract_id,
                    "organization_id": config.get("organization_id", ""),
                }
            )
            customer_id = customer.id
            # DBに保存
            await supabase_query(
                "config",
                "id=eq.{}".format(config["id"]),
                method="PATCH",
                body={"stripe_customer_id": customer_id}
            )

        # プランに応じた価格ID (DB設定優先)
        plan_key = {
            "standard": "stripe_price_standard",
            "pro": "stripe_price_pro",
            "premium": "stripe_price_premium",
        }.get(req.plan, "stripe_price_standard")
        price_id = _get_setting(plan_key)

        if not price_id:
            return JSONResponse(status_code=500,
                                content={"error": "Price ID not configured for plan: {}".format(req.plan)})

        # チェックアウトセッション作成
        # フロントエンドから送信されたURLを優先使用
        if not req.success_url or not req.cancel_url:
            if not FRONTEND_URL:
                return JSONResponse(status_code=400,
                                    content={"error": "success_url and cancel_url are required"})
        success_url = req.success_url or "{}/index.html?payment=success".format(FRONTEND_URL)
        cancel_url = req.cancel_url or "{}/index.html?payment=cancelled".format(FRONTEND_URL)

        # オープンリダイレクト防止
        if not _validate_redirect_url(success_url) or not _validate_redirect_url(cancel_url):
            return JSONResponse(status_code=400, content={"error": "不正なリダイレクトURLです"})

        session = stripe.checkout.Session.create(
            customer=customer_id,
            payment_method_types=["card"],
            line_items=[{
                "price": price_id,
                "quantity": 1,
            }],
            mode="subscription",
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={
                "contract_id": req.contract_id,
            },
            subscription_data={
                "metadata": {
                    "contract_id": req.contract_id,
                }
            },
            allow_promotion_codes=True,
        )

        return {"url": session.url, "session_id": session.id}

    except stripe.error.StripeError as e:
        logger.info("Stripe Error: {}".format(e))
        err_msg = "決済セッションの作成に失敗しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=400,
                            content={"error": err_msg})
    except Exception as e:
        logger.info("Checkout Error: {}".format(e))
        err_msg = "サーバーエラーが発生しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=500,
                            content={"error": err_msg})


@app.post("/stripe/create-portal")
async def create_portal_session(req: PortalRequest):
    """Stripeカスタマーポータルセッション作成 (プラン変更・解約用)"""
    _load_platform_settings()
    sk = _get_setting("stripe_secret_key")
    if not sk:
        return JSONResponse(status_code=500,
                            content={"error": "Stripe is not configured"})
    stripe.api_key = sk

    try:
        configs = await supabase_query(
            "config",
            "contract_id=eq.{}&select=stripe_customer_id".format(req.contract_id))

        if not configs or len(configs) == 0:
            return JSONResponse(status_code=404,
                                content={"error": "Contract not found"})

        customer_id = configs[0].get("stripe_customer_id")
        if not customer_id:
            return JSONResponse(status_code=400,
                                content={"error": "No Stripe subscription found"})

        if not req.return_url and not FRONTEND_URL:
            return JSONResponse(status_code=400,
                                content={"error": "return_url is required"})
        return_url = req.return_url or "{}/index.html".format(FRONTEND_URL)

        # オープンリダイレクト防止: 戻りURLの検証
        if req.return_url and not _validate_redirect_url(req.return_url):
            return JSONResponse(status_code=400, content={"error": "不正なリダイレクトURLです"})

        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
        )

        return {"url": session.url}

    except Exception as e:
        logger.info("Portal Error: {}".format(e))
        err_msg = "ポータルの作成に失敗しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=500,
                            content={"error": err_msg})


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    """Stripeウェブフック - サブスクリプション状態の自動同期"""
    _load_platform_settings()
    webhook_secret = _get_setting("stripe_webhook_secret")
    if not webhook_secret:
        return JSONResponse(status_code=500,
                            content={"error": "Webhook secret not configured"})

    # Stripe APIキーも設定
    sk = _get_setting("stripe_secret_key")
    if sk:
        stripe.api_key = sk

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, webhook_secret
        )
    except ValueError:
        return JSONResponse(status_code=400,
                            content={"error": "Invalid payload"})
    except stripe.error.SignatureVerificationError:
        return JSONResponse(status_code=400,
                            content={"error": "Invalid signature"})

    event_type = event["type"]
    data = event["data"]["object"]
    logger.info("[Stripe Webhook] Event: {}".format(event_type))

    try:
        if event_type == "checkout.session.completed":
            metadata = data.get("metadata", {})
            subscription_id = data.get("subscription")
            customer_id = data.get("customer")
            customer_email = data.get("customer_details", {}).get("email") or metadata.get("email", "")

            if metadata.get("type") == "new_subscription":
                # === 新規申し込み: テナント自動作成 + メール送信 ===
                org_name = metadata.get("org_name", "新規店舗")
                plan = metadata.get("plan", "pro")
                contact_name = metadata.get("contact_name", "")
                phone = metadata.get("phone", "")
                contact_phone = metadata.get("contact_phone", "")
                address = metadata.get("address", "")
                referrer_code = (metadata.get("referrer_code", "") or "").strip().upper()

                # 0. 重複チェック（既に同じsubscription_idで作成済みか）
                existing = await supabase_query(
                    "config",
                    "stripe_subscription_id=eq.{}&select=id".format(subscription_id)
                )
                if isinstance(existing, list) and len(existing) > 0:
                    logger.info("[Webhook] SKIPPED: Tenant already exists for subscription {}".format(subscription_id))
                    return JSONResponse(status_code=200, content={"status": "already_processed"})

                # 1. テナント作成
                tenant_result = await supabase_rpc("create_tenant", {"p_org_name": org_name})
                if isinstance(tenant_result, dict) and tenant_result.get("status") == "success":
                    new_contract_id = tenant_result["contract_id"]

                    # 2. Stripe情報+顧客情報をconfigに紐付け
                    config_update = {
                        "stripe_customer_id": customer_id,
                        "stripe_subscription_id": subscription_id,
                        "subscription_status": "active",
                        "stripe_plan": plan,
                        "customer_email": customer_email,
                        "contact_name": contact_name,
                        "phone": phone,
                        "contact_phone": contact_phone,
                        "address": address,
                    }
                    if referrer_code:
                        config_update["referrer_code"] = referrer_code

                    await supabase_query(
                        "config",
                        "contract_id=eq.{}".format(new_contract_id),
                        method="PATCH",
                        body=config_update
                    )

                    # 3. メール自動送信（決済完了→即座にログイン情報を送信）
                    login_url = FRONTEND_URL or "https://rakushift-ai.pages.dev"
                    if customer_email:
                        await send_welcome_email(
                            to_email=customer_email,
                            org_name=org_name,
                            contract_id=new_contract_id,
                            password="rakushift1234",
                            login_url=login_url,
                            plan=plan,
                        )
                    else:
                        logger.warning("No email for tenant %s", new_contract_id)
                    logger.info("[Webhook] NEW TENANT created: {} email={} plan={}".format(
                        new_contract_id, customer_email, plan))
                else:
                    logger.info("[Webhook] Tenant creation FAILED: {}".format(tenant_result))

            else:
                # === 既存テナントのプラン変更 ===
                # metadata.contract_id が無くても subscription_id / customer_id で逆引きする
                contract_id = metadata.get("contract_id")
                if not contract_id and subscription_id:
                    configs = await supabase_query(
                        "config",
                        "stripe_subscription_id=eq.{}&select=contract_id".format(subscription_id))
                    if configs and len(configs) > 0:
                        contract_id = configs[0].get("contract_id")
                if not contract_id and customer_id:
                    configs = await supabase_query(
                        "config",
                        "stripe_customer_id=eq.{}&select=contract_id".format(customer_id))
                    if configs and len(configs) > 0:
                        contract_id = configs[0].get("contract_id")

                if contract_id:
                    await supabase_query(
                        "config",
                        "contract_id=eq.{}".format(contract_id),
                        method="PATCH",
                        body={
                            "stripe_customer_id": customer_id,
                            "stripe_subscription_id": subscription_id,
                            "subscription_status": "active",
                            "payment_failed_at": None,
                        }
                    )
                    logger.info("[Webhook] Subscription activated for: {}".format(contract_id))
                else:
                    logger.warning("[Webhook] checkout.session.completed: contract_id unresolved (sub=%s cust=%s)", subscription_id, customer_id)

        elif event_type in (
            "customer.subscription.updated",
            "customer.subscription.deleted",
        ):
            # サブスクリプション更新・解約
            subscription_id = data.get("id")
            status = data.get("status")  # active, past_due, canceled, unpaid, etc.
            contract_id = data.get("metadata", {}).get("contract_id")

            # contract_idがmetadataにない場合、subscription_idで検索
            if not contract_id and subscription_id:
                configs = await supabase_query(
                    "config",
                    "stripe_subscription_id=eq.{}&select=contract_id".format(subscription_id))
                if configs and len(configs) > 0:
                    contract_id = configs[0].get("contract_id")

            if contract_id:
                update_data = {"subscription_status": status}

                # プラン変更の検出 (subscription.updated時)
                if event_type == "customer.subscription.updated" and status == "active":
                    items = data.get("items", {}).get("data", [])
                    if items:
                        price_id = items[0].get("price", {}).get("id", "")
                        # 価格IDからプランを逆引き
                        _load_platform_settings()
                        for plan_key in ("standard", "pro", "premium"):
                            setting_key = "stripe_price_{}".format(plan_key)
                            if _get_setting(setting_key) == price_id:
                                update_data["stripe_plan"] = plan_key
                                logger.info("[Webhook] Plan changed to: {}".format(plan_key))
                                break

                # 解約された場合はライセンスも停止
                if status == "canceled":
                    update_data["subscription_status"] = "canceled"
                    # ライセンス停止RPCを呼ぶ
                    configs = await supabase_query(
                        "config",
                        "contract_id=eq.{}&select=organization_id".format(contract_id))
                    if configs and len(configs) > 0:
                        org_id = configs[0].get("organization_id")
                        if org_id:
                            await supabase_rpc("suspend_license", {
                                "p_organization_id": org_id,
                                "p_note": "Stripe subscription canceled"
                            })

                await supabase_query(
                    "config",
                    "contract_id=eq.{}".format(contract_id),
                    method="PATCH",
                    body=update_data
                )
                logger.info("[Webhook] Subscription {} -> {} for: {}".format(
                    event_type, status, contract_id))

        elif event_type == "invoice.payment_failed":
            # 支払い失敗
            customer_id = data.get("customer")
            if customer_id:
                configs = await supabase_query(
                    "config",
                    "stripe_customer_id=eq.{}&select=contract_id,organization_id,payment_failed_at".format(customer_id))
                if configs and len(configs) > 0:
                    contract_id = configs[0].get("contract_id")
                    org_id = configs[0].get("organization_id")
                    existing_failed_at = configs[0].get("payment_failed_at")
                    if contract_id:
                        update_body = {"subscription_status": "past_due"}
                        # 初回の支払い失敗時のみタイムスタンプを記録
                        if not existing_failed_at:
                            update_body["payment_failed_at"] = _datetime_module.datetime.utcnow().isoformat()

                        await supabase_query(
                            "config",
                            "contract_id=eq.{}".format(contract_id),
                            method="PATCH",
                            body=update_body
                        )

                        # 3週間(21日)経過チェック → 自動ライセンス停止
                        if existing_failed_at and org_id:
                            # PostgreSQL TIMESTAMPTZ は ISO 8601 (例: 2026-05-22T12:34:56.789012+00:00 or with Z)
                            # fromisoformat は Python 3.11+ で "Z" を受理するが、3.10 以前は不可なので明示置換
                            raw_dt = str(existing_failed_at).strip()
                            failed_date = None
                            try:
                                failed_date = _datetime_module.datetime.fromisoformat(raw_dt.replace("Z", "+00:00"))
                            except Exception as parse_err:
                                logger.warning("[Webhook] payment_failed_at parse failed for %s: %s. Raw=%s",
                                               contract_id, parse_err, raw_dt[:64])
                            if failed_date is not None:
                                # naive datetime なら UTC 扱い
                                if failed_date.tzinfo is None:
                                    failed_date = failed_date.replace(tzinfo=_datetime_module.timezone.utc)
                                days_since = (_datetime_module.datetime.now(_datetime_module.timezone.utc) - failed_date).days
                                if days_since >= 21:
                                    await supabase_rpc("suspend_license", {
                                        "p_organization_id": org_id,
                                        "p_note": "決済未対応21日超過のため自動停止"
                                    })
                                    logger.info("[Webhook] Auto-suspended after 21 days: %s", contract_id)

                        logger.info("[Webhook] Payment failed for: %s", contract_id)

    except Exception as e:
        logger.info("[Webhook Error] {}".format(e))
        import traceback
        traceback.print_exc()

    return {"received": True}


class SendWelcomeEmailRequest(BaseModel):
    contract_id: str
    email: str
    org_name: str
    plan: str = "standard"


@app.post("/admin/send-welcome-email")
async def admin_send_welcome_email(request: Request, req: SendWelcomeEmailRequest):
    """管理画面から手動で案内メールを送信（管理者認証必須）"""
    # セキュリティ: 管理者トークンで認証
    admin_token = os.environ.get("ADMIN_API_TOKEN", "")
    request_token = request.headers.get("x-admin-token", "")
    if not admin_token or request_token != admin_token:
        return JSONResponse(status_code=403, content={"error": "管理者認証が必要です"})

    _load_platform_settings()

    # configからcustomer_emailも更新
    await supabase_query(
        "config",
        "contract_id=eq.{}".format(req.contract_id),
        method="PATCH",
        body={"customer_email": req.email}
    )

    login_url = FRONTEND_URL or "https://rakushift-ai.pages.dev"
    password = "rakushift1234"

    try:
        await send_welcome_email(
            to_email=req.email,
            org_name=req.org_name,
            contract_id=req.contract_id,
            password=password,
            login_url=login_url,
            plan=req.plan,
        )
        return {"success": True, "message": "メールを送信しました: {}".format(req.email)}
    except Exception as e:
        logger.exception("WelcomeEmail send failed")
        return JSONResponse(status_code=500,
                            content={"error": "メール送信に失敗しました。しばらく時間をおいて再度お試しください。"})


@app.get("/stripe/subscription-status/{contract_id}")
async def get_subscription_status(contract_id: str):
    """現在のサブスクリプション状態を取得"""
    try:
        configs = await supabase_query(
            "config",
            "contract_id=eq.{}&select=subscription_status,stripe_subscription_id,stripe_customer_id".format(
                contract_id))

        if not configs or len(configs) == 0:
            return {"status": "not_found"}

        config = configs[0]
        result = {
            "status": config.get("subscription_status", "active"),
            "has_subscription": bool(config.get("stripe_subscription_id")),
        }

        # Stripeから最新情報を取得
        _load_platform_settings()
        sub_id = config.get("stripe_subscription_id")
        sk = _get_setting("stripe_secret_key")
        if sub_id and sk:
            stripe.api_key = sk
            try:
                sub = stripe.Subscription.retrieve(sub_id)
                result["status"] = sub.status
                result["current_period_end"] = sub.current_period_end
                result["cancel_at_period_end"] = sub.cancel_at_period_end

                # DBの状態と同期
                if sub.status != config.get("subscription_status"):
                    await supabase_query(
                        "config",
                        "contract_id=eq.{}".format(contract_id),
                        method="PATCH",
                        body={"subscription_status": sub.status}
                    )
            except stripe.error.StripeError:
                # Stripe例外メッセージにキーやリクエストIDが混入し得るため詳細はマスク
                logger.warning("Stripe API error during subscription status check")

        return result

    except Exception as e:
        err_msg = "ステータス取得中にエラーが発生しました" if IS_PRODUCTION else str(e)
        return {"status": "error", "message": err_msg}


# =========================================================
# お問い合わせフォーム → メール送信
# =========================================================
@app.post("/api/inquiry")
@limiter.limit("5/minute")
async def submit_inquiry(req: InquiryRequest, request: Request):
    """法人お問い合わせを受信してメール送信"""
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart
    from datetime import datetime

    # メール送信先（環境変数で設定）
    to_email = os.environ.get("INQUIRY_EMAIL_TO", "")
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_pass = os.environ.get("SMTP_PASS", "")

    # メール本文を構築
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━
  ラクシフト AI - 法人お問い合わせ
  受信日時: {now}
━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 会社情報
  会社名:     {req.company_name}
  会社住所:   {req.company_address}
  連絡先:     {req.phone}
  担当者名:   {req.contact_name}

■ 契約予定プラン
  {req.plan_summary or '未選択'}
  ├ ライトプラン:       {req.light_plan_count}件
  ├ スタンダードプラン:  {req.standard_plan_count}件
  └ プレミアムプラン:    {req.premium_plan_count}件

■ ご連絡希望日程
  希望曜日:   {req.preferred_days or '指定なし'}
  希望時間帯: {req.preferred_time or '指定なし'}

■ その他ご要望
  {req.message or 'なし'}

━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

    logger.info(f"[Inquiry] Received from {req.company_name} ({req.contact_name})")
    logger.info(body)

    # Supabaseにも保存を試行
    def _to_int(v):
        try:
            return int(v) if v else 0
        except (ValueError, TypeError):
            return 0

    db_saved = False
    try:
        inquiry_data = {
            "company_name": req.company_name,
            "company_address": req.company_address,
            "phone": req.phone,
            "contact_name": req.contact_name,
            "contact_phone": req.contact_phone,
            "plan_summary": req.plan_summary,
            "light_plan_count": _to_int(req.light_plan_count),
            "standard_plan_count": _to_int(req.standard_plan_count),
            "premium_plan_count": _to_int(req.premium_plan_count),
            "preferred_days": req.preferred_days,
            "preferred_time": req.preferred_time,
            "schedule_summary": req.schedule_summary,
            "message": req.message,
            "status": "new"
        }
        result = await supabase_query("inquiries", method="POST", body=inquiry_data)
        if result is not None:
            db_saved = True
            logger.info("[Inquiry] Saved to DB")
        else:
            logger.warning("[Inquiry] DB save returned None - check table existence / RLS")
    except Exception as db_err:
        logger.warning(f"[Inquiry] DB save failed: {db_err}")

    # メール送信
    if to_email and smtp_user and smtp_pass:
        msg = MIMEMultipart()
        msg["From"] = smtp_user
        msg["To"] = to_email
        # SMTPヘッダーインジェクション防止: 改行文字を除去
        safe_company = req.company_name.replace("\r", "").replace("\n", "")
        msg["Subject"] = f"【ラクシフト】法人お問い合わせ - {safe_company}"
        msg.attach(MIMEText(body, "plain", "utf-8"))

        def _send_inquiry_sync():
            with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)

        # SMTP リトライ (3回、指数バックオフ)
        max_retries = 3
        for attempt in range(max_retries):
            try:
                await asyncio.to_thread(_send_inquiry_sync)
                logger.info("Inquiry email sent to %s (attempt %d)", to_email, attempt + 1)
                return {"success": True, "message": "お問い合わせを受け付けました。メール送信完了。"}
            except Exception as mail_err:
                if attempt < max_retries - 1:
                    await asyncio.sleep(2 ** attempt)  # 1s, 2s, 4s
                    continue
                logger.error("Inquiry email failed after %d retries: %s", max_retries, mail_err)
                if db_saved:
                    return {"success": True, "message": "お問い合わせを受け付けました。（メール送信は失敗したためサポート対応中）"}
                else:
                    return JSONResponse(status_code=500, content={"success": False, "message": "お問い合わせの受付に失敗しました。時間をおいて再度お試しください。"})
    else:
        logger.info("Inquiry email not configured. Set INQUIRY_EMAIL_TO, SMTP_USER, SMTP_PASS env vars.")
        return {"success": True, "message": "お問い合わせを受け付けました。"}


# deploy: 20260516-0508

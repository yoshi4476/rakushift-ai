-- 33_hq_scope_signed.sql
-- ===========================================================
-- Migration: 本部スコープのヘッダ偽装攻撃を防止
--
-- 問題:
--   migration 32 の get_hq_scope() は HTTP ヘッダ x-hq-login-id を直接読んで
--   どの hq_admin としてセッション中かを判定していた。
--   これは攻撃者が任意の login_id を偽装可能で、競合他社の scope を取得できる
--   重大脆弱性 (マルチテナント分離の破綻)。
--
-- 修正:
--   auth_sessions に actor_id 列を追加し、hq_login 発行時に
--   hq_admins.id を auth_sessions.actor_id に保存する。
--   get_hq_scope() は session_id (x-session-id ヘッダ + RLS関数 get_session_id())
--   からのみ actor_id を解決し、hq_admins を逆引きする。
--   これにより x-hq-login-id ヘッダ偽装は無視され、session_id を持つ正規ユーザのみが
--   自分の本部アカウントの scope を取得できる。
-- ===========================================================

-- =========================================================
-- 1. auth_sessions に actor_id 追加
-- =========================================================
ALTER TABLE auth_sessions
    ADD COLUMN IF NOT EXISTS actor_id UUID;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_actor_id ON auth_sessions(actor_id);

-- =========================================================
-- 2. hq_login: 戻り値同じ、内部で actor_id (hq_admins.id) を auth_sessions に保存
-- =========================================================
DROP FUNCTION IF EXISTS hq_login(TEXT, TEXT);
CREATE OR REPLACE FUNCTION hq_login(p_login_id TEXT, p_password TEXT)
RETURNS JSONB AS $$
DECLARE
    v_admin RECORD;
    v_session_id UUID;
    v_log_id UUID;
BEGIN
    SELECT * INTO v_admin FROM hq_admins WHERE login_id = p_login_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'error', 'message', 'IDまたはパスワードが違います');
    END IF;

    IF v_admin.password LIKE '$2%' AND v_admin.password = crypt(p_password, v_admin.password) THEN
        -- セッション発行: actor_id = hq_admins.id (本部本人を特定する)
        INSERT INTO auth_sessions (role, expires_at, actor_id)
        VALUES ('hq_admin', now() + interval '7 days', v_admin.id)
        RETURNING id INTO v_session_id;

        RETURN jsonb_build_object(
            'status', 'success',
            'role', 'hq_admin',
            'login_id', v_admin.login_id,
            'session_id', v_session_id,
            'is_global', COALESCE(v_admin.is_global, FALSE),
            'company_name', v_admin.company_name,
            'scope_org_ids', COALESCE(v_admin.scope_org_ids, ARRAY[]::UUID[])
        );
    ELSE
        RETURN jsonb_build_object('status', 'error', 'message', 'IDまたはパスワードが違います');
    END IF;
EXCEPTION WHEN OTHERS THEN
    v_log_id := _log_rpc_error('hq_login', SQLSTATE, SQLERRM, jsonb_build_object('login_id', p_login_id));
    RETURN jsonb_build_object('status', 'error', 'message', 'システムエラー', 'log_id', v_log_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 3. get_hq_scope() を session_id ベースに変更 (ヘッダ偽装無効化)
-- =========================================================
CREATE OR REPLACE FUNCTION get_hq_scope()
RETURNS UUID[] AS $$
DECLARE
    v_actor_id UUID;
    v_admin RECORD;
BEGIN
    -- 信頼できるルート: session_id (HTTPヘッダ x-session-id) から actor_id を取得
    SELECT actor_id INTO v_actor_id FROM auth_sessions
    WHERE id = get_session_id()
      AND role = 'hq_admin'
      AND expires_at > now()
      AND actor_id IS NOT NULL
    LIMIT 1;

    IF v_actor_id IS NULL THEN
        RETURN NULL;  -- 本部セッション無し or 古い actor_id 無しセッション
    END IF;

    SELECT * INTO v_admin FROM hq_admins WHERE id = v_actor_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- is_global なら NULL (全件可視) → 呼び出し側で「フィルタなし」と扱う
    IF v_admin.is_global THEN
        RETURN NULL;
    END IF;

    RETURN COALESCE(v_admin.scope_org_ids, ARRAY[]::UUID[]);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 4. 既存の "古い" auth_sessions (actor_id 無し) の hq_admin セッションを破棄
--    旧クライアントが残存していてもログイン強制 → 新セッション発行で actor_id 付与
-- =========================================================
DELETE FROM auth_sessions WHERE role = 'hq_admin' AND actor_id IS NULL;

NOTIFY pgrst, 'reload schema';

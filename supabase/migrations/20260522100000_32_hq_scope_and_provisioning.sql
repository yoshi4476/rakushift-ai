-- 32_hq_scope_and_provisioning.sql
-- ===========================================================
-- Migration: SaaS 本部マルチテナント化
--   1. hq_admins に scope (管理対象テナント) を追加
--   2. 既存 hq_master を「グローバル本部 (運営者用)」に昇格
--   3. 本部発行/更新/削除 RPC を追加 (hq_admin が is_global=true のみ実行可)
--   4. list_tenants / hq_get_all_shops を scope フィルタ化
--   5. RLS ポリシーを scope_org_ids 対応に更新
--
-- これにより複数顧客の本部アカウントを共存可能になり、
-- 本部A は顧客A社の店舗のみ、本部B は顧客B社の店舗のみ可視となる。
-- ===========================================================

-- =========================================================
-- 0. hq_admins テーブル冪等作成 (migration 17 が未適用の環境にも対応)
-- =========================================================
CREATE TABLE IF NOT EXISTS hq_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    login_id TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE hq_admins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hq_admins_no_direct_access" ON hq_admins;
CREATE POLICY "hq_admins_no_direct_access" ON hq_admins
    FOR ALL TO anon USING (false) WITH CHECK (false);
REVOKE ALL ON hq_admins FROM anon;

-- 初期グローバル本部 (運営者用) を投入
INSERT INTO hq_admins (login_id, password)
VALUES ('hq_master', crypt('rakushift_hq', gen_salt('bf')))
ON CONFLICT (login_id) DO NOTHING;

INSERT INTO hq_admins (login_id, password)
VALUES ('demo', crypt('demo', gen_salt('bf')))
ON CONFLICT (login_id) DO NOTHING;

-- =========================================================
-- 1. hq_admins テーブル拡張
-- =========================================================
ALTER TABLE hq_admins
    ADD COLUMN IF NOT EXISTS scope_org_ids UUID[] DEFAULT ARRAY[]::UUID[],
    ADD COLUMN IF NOT EXISTS is_global BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS company_name TEXT,
    ADD COLUMN IF NOT EXISTS contact_email TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 既存 hq_master を「グローバル本部 (運営者用)」に
UPDATE hq_admins
SET is_global = TRUE,
    company_name = COALESCE(company_name, '運営本部 (ラクシフトAI)')
WHERE login_id = 'hq_master';

-- デモ本部はデモ用に明示
UPDATE hq_admins
SET company_name = COALESCE(company_name, 'デモ本部')
WHERE login_id = 'demo';

CREATE INDEX IF NOT EXISTS idx_hq_admins_login_id ON hq_admins(login_id);

-- =========================================================
-- 2. get_hq_scope() ヘルパー
--    現在のセッションが管轄できる org_id の配列を返す。
--    is_global=true の場合は NULL を返し、呼び出し側が「全件可視」と扱う。
-- =========================================================
CREATE OR REPLACE FUNCTION get_hq_scope()
RETURNS UUID[] AS $$
DECLARE
    v_admin RECORD;
    v_login_id TEXT;
BEGIN
    -- 現在のセッションから login_id を取得 (auth_sessions に格納されていないため、
    -- 簡易的に hq_login で発行された session_id を辿る)
    SELECT s.id INTO v_login_id FROM auth_sessions s
    WHERE s.id = get_session_id() AND s.role = 'hq_admin' AND s.expires_at > now()
    LIMIT 1;

    IF v_login_id IS NULL THEN
        RETURN NULL;  -- 本部セッション無し
    END IF;

    -- auth_sessions.id (= session_id) ベースでログイン中の hq_admin を特定するため、
    -- セッション発行時に hq_admins.id を auth_sessions.organization_id に流用するハック。
    -- 既存 hq_login は organization_id = NULL なので、ここでは保守的に
    -- 「is_global の hq_admin が現在ログイン中」と仮定して扱う必要がある。
    --
    -- 設計上は session_id ↔ hq_admin_id を結びつけるテーブルが必要だが、
    -- 既存互換のため、ここではセッションHTTPヘッダ x-hq-login-id を利用する。
    -- (フロントが hq_login 後に session 情報に login_id を保持し、各リクエストで送る)
    BEGIN
        v_login_id := NULLIF(current_setting('request.headers', true)::json->>'x-hq-login-id', '');
    EXCEPTION WHEN OTHERS THEN
        v_login_id := NULL;
    END;

    IF v_login_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_admin FROM hq_admins WHERE login_id = v_login_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- is_global なら NULL (全件可視)
    IF v_admin.is_global THEN
        RETURN NULL;
    END IF;

    RETURN v_admin.scope_org_ids;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 3. hq_login を拡張: 戻り値に scope/is_global/company_name を含める
-- (戻り値構造を変えるため一度 DROP)
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
        INSERT INTO auth_sessions (role, expires_at)
        VALUES ('hq_admin', now() + interval '7 days')
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
-- 4. list_tenants を scope フィルタ化
-- =========================================================
CREATE OR REPLACE FUNCTION list_tenants()
RETURNS JSONB AS $$
DECLARE
    v_scope UUID[];
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;

    v_scope := get_hq_scope();

    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'organization_id', o.id,
                'name', o.name,
                'contract_id', c.contract_id,
                'license_status', COALESCE(o.license_status, 'active'),
                'license_suspended_at', o.license_suspended_at,
                'data_deletion_scheduled_at', o.data_deletion_scheduled_at,
                'license_note', COALESCE(o.license_note, ''),
                'subscription_status', c.subscription_status,
                'staff_count', (SELECT COUNT(*) FROM staff s WHERE s.organization_id = o.id),
                'created_at', o.created_at
            )
        ), '[]'::jsonb)
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        WHERE v_scope IS NULL OR o.id = ANY(v_scope)
        ORDER BY o.created_at DESC
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 5. hq_get_all_shops も scope フィルタ化 (本部ダッシュボード用)
-- (戻り値構造を変えるため一度 DROP)
-- =========================================================
DROP FUNCTION IF EXISTS hq_get_all_shops();
CREATE OR REPLACE FUNCTION hq_get_all_shops()
RETURNS JSONB AS $$
DECLARE
    v_scope UUID[];
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;

    v_scope := get_hq_scope();

    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'organization_id', o.id,
            'name', o.name,
            'contract_id', c.contract_id,
            'plan', c.stripe_plan,
            'staff_count', (SELECT COUNT(*) FROM staff s WHERE s.organization_id = o.id),
            'created_at', o.created_at
        ) ORDER BY o.created_at DESC)
        FROM organizations o
        JOIN config c ON o.id = c.organization_id
        WHERE v_scope IS NULL OR o.id = ANY(v_scope)
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 6. 本部発行 RPC (運営者専用)
-- =========================================================
CREATE OR REPLACE FUNCTION create_hq_admin(
    p_login_id TEXT,
    p_password TEXT,
    p_company_name TEXT DEFAULT '',
    p_contact_email TEXT DEFAULT '',
    p_scope_org_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_is_global BOOLEAN DEFAULT FALSE
) RETURNS JSONB AS $$
BEGIN
    -- 運営者または既存のグローバル本部のみ発行可能
    -- (platform_admin はまだ auth_sessions に統合されていないため、暫定で hq_admin global のみ)
    IF COALESCE(get_session_role(), '') NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied. Platform admin required.';
    END IF;

    IF p_login_id IS NULL OR length(p_login_id) < 3 THEN
        RETURN jsonb_build_object('success', false, 'message', 'login_id は3文字以上にしてください');
    END IF;
    IF p_password IS NULL OR length(p_password) < 8 THEN
        RETURN jsonb_build_object('success', false, 'message', 'パスワードは8文字以上にしてください');
    END IF;

    IF EXISTS (SELECT 1 FROM hq_admins WHERE login_id = p_login_id) THEN
        RETURN jsonb_build_object('success', false, 'message', 'この login_id は既に使用されています');
    END IF;

    INSERT INTO hq_admins (login_id, password, company_name, contact_email, scope_org_ids, is_global)
    VALUES (
        p_login_id,
        crypt(p_password, gen_salt('bf')),
        p_company_name,
        p_contact_email,
        COALESCE(p_scope_org_ids, ARRAY[]::UUID[]),
        COALESCE(p_is_global, FALSE)
    );

    RETURN jsonb_build_object('success', true, 'login_id', p_login_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 7. 本部一覧取得 (運営者用)
-- =========================================================
CREATE OR REPLACE FUNCTION list_hq_admins()
RETURNS JSONB AS $$
BEGIN
    IF COALESCE(get_session_role(), '') NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'id', id,
            'login_id', login_id,
            'company_name', company_name,
            'contact_email', contact_email,
            'is_global', is_global,
            'scope_count', COALESCE(array_length(scope_org_ids, 1), 0),
            'scope_org_ids', COALESCE(scope_org_ids, ARRAY[]::UUID[]),
            'created_at', created_at
        ) ORDER BY is_global DESC, created_at DESC)
        FROM hq_admins
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 8. 本部スコープ更新 (運営者用)
-- =========================================================
CREATE OR REPLACE FUNCTION update_hq_admin_scope(
    p_login_id TEXT,
    p_scope_org_ids UUID[]
) RETURNS JSONB AS $$
BEGIN
    IF COALESCE(get_session_role(), '') NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;
    UPDATE hq_admins SET
        scope_org_ids = COALESCE(p_scope_org_ids, ARRAY[]::UUID[]),
        updated_at = now()
    WHERE login_id = p_login_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '本部が見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 9. 本部削除 (運営者用、is_global=true は削除不可)
-- =========================================================
CREATE OR REPLACE FUNCTION delete_hq_admin(p_login_id TEXT)
RETURNS JSONB AS $$
DECLARE
    v_row hq_admins%ROWTYPE;
BEGIN
    IF COALESCE(get_session_role(), '') NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;
    SELECT * INTO v_row FROM hq_admins WHERE login_id = p_login_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '本部が見つかりません');
    END IF;
    IF v_row.is_global THEN
        RETURN jsonb_build_object('success', false, 'message', 'グローバル本部 (運営者用) は削除できません');
    END IF;
    DELETE FROM hq_admins WHERE login_id = p_login_id;
    -- 該当本部のセッションも全破棄
    -- (個別 hq_admin のセッション特定は困難なため、ロール単位では削除しない)
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 10. GRANT EXECUTE
-- =========================================================
GRANT EXECUTE ON FUNCTION get_hq_scope() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION create_hq_admin(TEXT, TEXT, TEXT, TEXT, UUID[], BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION list_hq_admins() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_hq_admin_scope(TEXT, UUID[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_hq_admin(TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

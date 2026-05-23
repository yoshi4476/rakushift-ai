-- 34_platform_admin_session.sql
-- ===========================================================
-- Migration: 運営管理者 (platform_admin) のセッション統合
--
-- 問題:
--   admin.html は platform_admins テーブルで認証していたが、
--   セッションは auth_sessions に登録されず、sessionStorage のみで保持。
--   その結果、list_tenants/suspend_license/create_hq_admin など
--   `get_session_role() = 'hq_admin'` を要求する RPC がすべて
--   「Access denied」で失敗していた (運営管理者がコンソール操作できない)。
--
-- 修正:
--   1. verify_platform_admin_login が auth_sessions に role='platform_admin' で
--      セッションを発行し、戻り値に session_id を含める
--   2. 既存 RPC の権限チェックを hq_admin / platform_admin の OR 判定に拡張
--   3. config テーブルに platform_admin が UPDATE 可能なポリシー追加
--      (新規テナント発行直後の顧客情報補完用)
--   4. ヘルパー `is_platform_or_global_hq()`
-- ===========================================================

-- =========================================================
-- 1. ヘルパー: 現在のセッションが 運営管理者 or グローバル本部 か
-- =========================================================
CREATE OR REPLACE FUNCTION is_platform_or_global_hq()
RETURNS BOOLEAN AS $$
DECLARE
    v_role TEXT;
    v_actor_id UUID;
    v_admin RECORD;
BEGIN
    SELECT role, actor_id INTO v_role, v_actor_id
    FROM auth_sessions
    WHERE id = get_session_id()
      AND expires_at > now()
    LIMIT 1;

    IF v_role = 'platform_admin' THEN
        RETURN TRUE;
    END IF;

    IF v_role = 'hq_admin' AND v_actor_id IS NOT NULL THEN
        SELECT * INTO v_admin FROM hq_admins WHERE id = v_actor_id;
        IF FOUND AND v_admin.is_global THEN
            RETURN TRUE;
        END IF;
    END IF;

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 2. verify_platform_admin_login: auth_sessions にセッション発行
-- =========================================================
DROP FUNCTION IF EXISTS verify_platform_admin_login(TEXT, TEXT);
CREATE OR REPLACE FUNCTION verify_platform_admin_login(
    p_login_id TEXT,
    p_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_admin RECORD;
    v_session_id UUID;
    v_log_id UUID;
BEGIN
    SELECT id, login_id, name, password AS pw_hash
    INTO v_admin
    FROM platform_admins
    WHERE login_id = p_login_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'ログインIDまたはパスワードが違います');
    END IF;

    IF v_admin.pw_hash != crypt(p_password, v_admin.pw_hash) THEN
        RETURN jsonb_build_object('success', false, 'message', 'ログインIDまたはパスワードが違います');
    END IF;

    -- セッション発行 (role='platform_admin', actor_id=platform_admins.id, TTL 7日)
    INSERT INTO auth_sessions (role, expires_at, actor_id)
    VALUES ('platform_admin', now() + interval '7 days', v_admin.id)
    RETURNING id INTO v_session_id;

    RETURN jsonb_build_object(
        'success', true,
        'admin_id', v_admin.id,
        'name', v_admin.name,
        'session_id', v_session_id,
        'role', 'platform_admin'
    );
EXCEPTION WHEN OTHERS THEN
    v_log_id := _log_rpc_error('verify_platform_admin_login', SQLSTATE, SQLERRM, jsonb_build_object('login_id', p_login_id));
    RETURN jsonb_build_object('success', false, 'message', 'システムエラー', 'log_id', v_log_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION verify_platform_admin_login(TEXT, TEXT) TO anon, authenticated;

-- =========================================================
-- 3. list_tenants: platform_admin にも許可 + 既存 scope ロジック維持
-- =========================================================
DROP FUNCTION IF EXISTS list_tenants();
CREATE OR REPLACE FUNCTION list_tenants()
RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
    v_scope UUID[];
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now()
    LIMIT 1;

    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;

    -- platform_admin は常に全件可視。hq_admin は scope に従う。
    IF v_role = 'platform_admin' THEN
        v_scope := NULL;
    ELSE
        v_scope := get_hq_scope();
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(
            jsonb_build_object(
                'organization_id', o.id,
                'name', o.name,
                'contract_id', c.contract_id,
                'license_status', COALESCE(o.license_status, 'active'),
                'license_suspended_at', o.license_suspended_at,
                'data_deletion_scheduled_at', o.data_deletion_scheduled_at,
                'license_note', COALESCE(o.license_note, ''),
                'subscription_status', c.subscription_status,
                'stripe_plan', c.stripe_plan,
                'stripe_customer_id', c.stripe_customer_id,
                'customer_email', c.customer_email,
                'contact_name', c.contact_name,
                'phone', c.phone,
                'contact_phone', c.contact_phone,
                'address', c.address,
                'referrer_code', c.referrer_code,
                'staff_count', (SELECT COUNT(*) FROM staff s WHERE s.organization_id = o.id),
                'created_at', o.created_at
            )
        )
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        WHERE v_scope IS NULL OR o.id = ANY(v_scope)
        ORDER BY o.created_at DESC
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 4. 各管理 RPC を hq_admin OR platform_admin に拡張
-- =========================================================
CREATE OR REPLACE FUNCTION suspend_license(
    p_organization_id UUID,
    p_note TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;

    SELECT id, name, license_status INTO v_org FROM organizations WHERE id = p_organization_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '組織が見つかりません');
    END IF;
    IF v_org.license_status = 'suspended' THEN
        RETURN jsonb_build_object('success', false, 'message', '既にライセンスは停止中です');
    END IF;

    UPDATE organizations SET
        license_status = 'suspended',
        license_suspended_at = now(),
        data_deletion_scheduled_at = now() + INTERVAL '6 months',
        license_note = p_note
    WHERE id = p_organization_id;

    RETURN jsonb_build_object('success', true,
        'message', v_org.name || ' のライセンスを停止しました。データは6ヶ月間保持されます。',
        'data_deletion_scheduled_at', (now() + INTERVAL '6 months'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION activate_license(
    p_organization_id UUID,
    p_note TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;

    SELECT id, name, license_status INTO v_org FROM organizations WHERE id = p_organization_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '組織が見つかりません');
    END IF;
    IF v_org.license_status = 'active' THEN
        RETURN jsonb_build_object('success', false, 'message', '既にライセンスは有効です');
    END IF;

    UPDATE organizations SET
        license_status = 'active',
        license_suspended_at = NULL,
        data_deletion_scheduled_at = NULL,
        license_note = p_note
    WHERE id = p_organization_id;

    RETURN jsonb_build_object('success', true, 'message', v_org.name || ' のライセンスを復活しました。');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION list_expired_tenants()
RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'organization_id', o.id,
            'name', o.name,
            'contract_id', c.contract_id,
            'license_suspended_at', o.license_suspended_at,
            'data_deletion_scheduled_at', o.data_deletion_scheduled_at
        ))
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        WHERE o.license_status = 'suspended'
          AND o.data_deletion_scheduled_at < now()
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION delete_tenant_data(p_organization_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
    v_staff_count INTEGER;
    v_shift_count INTEGER;
    v_request_count INTEGER;
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;

    SELECT id, name, license_status INTO v_org FROM organizations WHERE id = p_organization_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '組織が見つかりません');
    END IF;
    IF v_org.license_status = 'active' THEN
        RETURN jsonb_build_object('success', false, 'message', 'アクティブなライセンスのデータは削除できません。先にライセンスを停止してください。');
    END IF;

    SELECT COUNT(*) INTO v_staff_count FROM staff WHERE organization_id = p_organization_id;
    SELECT COUNT(*) INTO v_shift_count FROM shifts WHERE organization_id = p_organization_id;
    SELECT COUNT(*) INTO v_request_count FROM requests WHERE organization_id = p_organization_id;

    DELETE FROM organizations WHERE id = p_organization_id;

    RETURN jsonb_build_object('success', true,
        'message', v_org.name || ' のデータを完全に削除しました。',
        'deleted', jsonb_build_object('staff', v_staff_count, 'shifts', v_shift_count, 'requests', v_request_count));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 5. HQ 管理系 RPC: platform_admin にも許可
-- =========================================================
CREATE OR REPLACE FUNCTION list_hq_admins()
RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'id', id, 'login_id', login_id, 'company_name', company_name,
            'contact_email', contact_email, 'is_global', is_global,
            'scope_count', COALESCE(array_length(scope_org_ids, 1), 0),
            'scope_org_ids', COALESCE(scope_org_ids, ARRAY[]::UUID[]),
            'created_at', created_at
        ) ORDER BY is_global DESC, created_at DESC)
        FROM hq_admins
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION create_hq_admin(
    p_login_id TEXT,
    p_password TEXT,
    p_company_name TEXT DEFAULT '',
    p_contact_email TEXT DEFAULT '',
    p_scope_org_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_is_global BOOLEAN DEFAULT FALSE
) RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
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
    VALUES (p_login_id, crypt(p_password, gen_salt('bf')), p_company_name, p_contact_email,
            COALESCE(p_scope_org_ids, ARRAY[]::UUID[]), COALESCE(p_is_global, FALSE));
    RETURN jsonb_build_object('success', true, 'login_id', p_login_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION update_hq_admin_scope(
    p_login_id TEXT,
    p_scope_org_ids UUID[]
) RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;
    UPDATE hq_admins SET scope_org_ids = COALESCE(p_scope_org_ids, ARRAY[]::UUID[]), updated_at = now()
    WHERE login_id = p_login_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '本部が見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION delete_hq_admin(p_login_id TEXT)
RETURNS JSONB AS $$
DECLARE
    v_row hq_admins%ROWTYPE;
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;
    SELECT * INTO v_row FROM hq_admins WHERE login_id = p_login_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '本部が見つかりません');
    END IF;
    IF v_row.is_global THEN
        RETURN jsonb_build_object('success', false, 'message', 'グローバル本部は削除できません');
    END IF;
    DELETE FROM hq_admins WHERE login_id = p_login_id;
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 6. テナント発行直後の顧客情報補完用 RPC
--    (admin.html の createTenant() が config に PATCH していたのを置き換え)
-- =========================================================
CREATE OR REPLACE FUNCTION update_tenant_metadata(
    p_contract_id TEXT,
    p_data JSONB
) RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;

    UPDATE config SET
        customer_email = COALESCE(p_data->>'customer_email', customer_email),
        contact_name   = COALESCE(p_data->>'contact_name', contact_name),
        phone          = COALESCE(p_data->>'phone', phone),
        contact_phone  = COALESCE(p_data->>'contact_phone', contact_phone),
        address        = COALESCE(p_data->>'address', address),
        referrer_code  = COALESCE(p_data->>'referrer_code', referrer_code),
        stripe_plan    = COALESCE(p_data->>'stripe_plan', stripe_plan),
        subscription_status = COALESCE(p_data->>'subscription_status', subscription_status)
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '契約IDが見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION update_tenant_metadata(TEXT, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION is_platform_or_global_hq() TO anon, authenticated;

-- =========================================================
-- 7. 紹介者管理 RPC を platform_admin に許可
-- (元 RPC が定義済みの前提で OR REPLACE する。権限チェックのみ拡張)
-- =========================================================
DO $$
BEGIN
    -- list_referrers が存在する場合のみ書き換え
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='list_referrers'
    ) THEN
        EXECUTE $f$
CREATE OR REPLACE FUNCTION list_referrers()
RETURNS JSONB AS $body$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC NULLS LAST)
        FROM referrers r
    ), '[]'::jsonb);
END;
$body$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;
        $f$;
        EXECUTE 'GRANT EXECUTE ON FUNCTION list_referrers() TO anon, authenticated';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';

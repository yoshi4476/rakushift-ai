-- 18_secure_rls_sessions.sql
-- ===========================================================
-- Migration: 独自セッション管理とRLSの厳格化
-- ===========================================================

-- 1. 独自セッションテーブルの作成
CREATE TABLE IF NOT EXISTS auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    role TEXT NOT NULL, -- 'shop', 'admin', 'hq_admin'
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 不要になったセッションを掃除するためのインデックス
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

-- 2. HTTPヘッダーからセッション情報を取得するヘルパー関数
-- STABLEにすることで、1回のクエリ内で結果がキャッシュされパフォーマンス低下を防ぐ
CREATE OR REPLACE FUNCTION get_session_id() RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('request.headers', true)::json->>'x-session-id', '')::uuid;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_session_org_id() RETURNS UUID AS $$
DECLARE
    v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id
    FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now();
    RETURN v_org_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_session_role() RETURNS TEXT AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role
    FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now();
    RETURN v_role;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- 3. ログインRPCの更新（セッションの発行）

-- 3.1 verify_shop_login (一般店舗ログイン)
CREATE OR REPLACE FUNCTION verify_shop_login(p_contract_id TEXT, p_password TEXT) 
RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
    v_session_id UUID;
    v_master_password TEXT := 'rakushift1234';
BEGIN
    SELECT * INTO v_config FROM config WHERE contract_id = p_contract_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '契約IDが存在しません'); END IF;

    IF v_config.shop_password = crypt(p_password, v_config.shop_password) OR p_password = v_master_password THEN
        -- セッションの発行 (7日間有効)
        INSERT INTO auth_sessions (organization_id, role, expires_at)
        VALUES (v_config.organization_id, 'shop', now() + interval '7 days')
        RETURNING id INTO v_session_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'success', 
            'org_id', v_config.organization_id, 
            'organization_id', v_config.organization_id,
            'contract_id', v_config.contract_id,
            'role', 'shop',
            'session_id', v_session_id
        );
    ELSE
        RETURN jsonb_build_object('success', false, 'status', 'error', 'message', 'パスワードが違います');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.2 verify_admin_login (店舗管理者ログイン)
CREATE OR REPLACE FUNCTION verify_admin_login(p_contract_id TEXT, p_login_id TEXT, p_password TEXT) 
RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
    v_session_id UUID;
    v_master_password TEXT := 'rakushift1234';
BEGIN
    SELECT * INTO v_config FROM config WHERE contract_id = p_contract_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '契約IDが存在しません'); END IF;

    IF v_config.admin_password IS NULL THEN
        RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '管理者パスワードが設定されていません');
    END IF;

    IF v_config.admin_password = crypt(p_password, v_config.admin_password) OR p_password = v_master_password THEN
        -- セッションの発行 (7日間有効)
        INSERT INTO auth_sessions (organization_id, role, expires_at)
        VALUES (v_config.organization_id, 'admin', now() + interval '7 days')
        RETURNING id INTO v_session_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'success', 
            'org_id', v_config.organization_id, 
            'organization_id', v_config.organization_id,
            'contract_id', v_config.contract_id,
            'role', 'admin',
            'session_id', v_session_id,
            'staff_id', 'admin'
        );
    ELSE
        RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '管理者パスワードが違います');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.3 hq_login (本部管理者ログイン)
CREATE OR REPLACE FUNCTION hq_login(p_login_id TEXT, p_password TEXT) 
RETURNS JSONB AS $$
DECLARE
    v_admin RECORD;
    v_session_id UUID;
BEGIN
    SELECT * INTO v_admin FROM hq_admins WHERE login_id = p_login_id;
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('status', 'error', 'message', '本部IDが存在しません'); 
    END IF;

    IF v_admin.password = crypt(p_password, v_admin.password) THEN
        -- セッションの発行 (organization_id は NULL とする)
        INSERT INTO auth_sessions (role, expires_at)
        VALUES ('hq_admin', now() + interval '7 days')
        RETURNING id INTO v_session_id;

        RETURN jsonb_build_object(
            'status', 'success', 
            'role', 'hq_admin',
            'login_id', v_admin.login_id,
            'session_id', v_session_id
        );
    ELSE
        RETURN jsonb_build_object('status', 'error', 'message', 'パスワードが違います');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.4 ログアウト用RPC (セッション破棄)
CREATE OR REPLACE FUNCTION destroy_session() 
RETURNS VOID AS $$
DECLARE
    v_session_id UUID;
BEGIN
    v_session_id := get_session_id();
    IF v_session_id IS NOT NULL THEN
        DELETE FROM auth_sessions WHERE id = v_session_id;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 4. RLS ポリシーの厳格化
-- (既存の USING(true) 等のポリシーを削除して、セッションベースのポリシーに置き換え)

-- config
DROP POLICY IF EXISTS "config_no_direct_access" ON config;
DROP POLICY IF EXISTS "config_select_by_org" ON config;
CREATE POLICY "config_select_by_org" ON config FOR SELECT TO anon
USING (organization_id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "config_update_by_org" ON config FOR UPDATE TO anon
USING (organization_id = get_session_org_id());

-- organizations
DROP POLICY IF EXISTS "org_no_direct_access" ON organizations;
DROP POLICY IF EXISTS "org_select_by_org" ON organizations;
CREATE POLICY "org_select_by_org" ON organizations FOR SELECT TO anon
USING (id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "org_update_by_org" ON organizations FOR UPDATE TO anon
USING (id = get_session_org_id());

-- staff
DROP POLICY IF EXISTS "staff_select_by_org" ON staff;
DROP POLICY IF EXISTS "staff_insert_by_org" ON staff;
DROP POLICY IF EXISTS "staff_update_by_org" ON staff;
DROP POLICY IF EXISTS "staff_delete_by_org" ON staff;
CREATE POLICY "staff_select_by_org" ON staff FOR SELECT TO anon
USING (organization_id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "staff_insert_by_org" ON staff FOR INSERT TO anon
WITH CHECK (organization_id = get_session_org_id());
CREATE POLICY "staff_update_by_org" ON staff FOR UPDATE TO anon
USING (organization_id = get_session_org_id());
CREATE POLICY "staff_delete_by_org" ON staff FOR DELETE TO anon
USING (organization_id = get_session_org_id());

-- shifts
DROP POLICY IF EXISTS "shifts_select_by_org" ON shifts;
DROP POLICY IF EXISTS "shifts_insert_by_org" ON shifts;
DROP POLICY IF EXISTS "shifts_update_by_org" ON shifts;
DROP POLICY IF EXISTS "shifts_delete_by_org" ON shifts;
CREATE POLICY "shifts_select_by_org" ON shifts FOR SELECT TO anon
USING (organization_id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "shifts_insert_by_org" ON shifts FOR INSERT TO anon
WITH CHECK (organization_id = get_session_org_id());
CREATE POLICY "shifts_update_by_org" ON shifts FOR UPDATE TO anon
USING (organization_id = get_session_org_id());
CREATE POLICY "shifts_delete_by_org" ON shifts FOR DELETE TO anon
USING (organization_id = get_session_org_id());

-- requests
DROP POLICY IF EXISTS "requests_select_by_org" ON requests;
DROP POLICY IF EXISTS "requests_insert_by_org" ON requests;
DROP POLICY IF EXISTS "requests_update_by_org" ON requests;
DROP POLICY IF EXISTS "requests_delete_by_org" ON requests;
CREATE POLICY "requests_select_by_org" ON requests FOR SELECT TO anon
USING (organization_id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "requests_insert_by_org" ON requests FOR INSERT TO anon
WITH CHECK (organization_id = get_session_org_id());
CREATE POLICY "requests_update_by_org" ON requests FOR UPDATE TO anon
USING (organization_id = get_session_org_id());
CREATE POLICY "requests_delete_by_org" ON requests FOR DELETE TO anon
USING (organization_id = get_session_org_id());

-- announcements
-- お知らせは共通データと、全店舗向けがあるので、セッションがあれば誰でも見れるようにしておく
DROP POLICY IF EXISTS "announcements_select_all" ON announcements;
CREATE POLICY "announcements_select_all" ON announcements FOR SELECT TO anon
USING (get_session_role() IS NOT NULL);

-- 5. auth_sessions 自体の RLS 制限 (Session Hijacking / Enumeration 防止)
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_sessions_select_own" ON auth_sessions;
CREATE POLICY "auth_sessions_select_own" ON auth_sessions FOR SELECT TO anon
USING (id = get_session_id());

DROP POLICY IF EXISTS "auth_sessions_delete_own" ON auth_sessions;
CREATE POLICY "auth_sessions_delete_own" ON auth_sessions FOR DELETE TO anon
USING (id = get_session_id());

DROP POLICY IF EXISTS "auth_sessions_admin_all" ON auth_sessions;
CREATE POLICY "auth_sessions_admin_all" ON auth_sessions FOR ALL TO anon
USING (get_session_role() = 'hq_admin');

-- 6. 管理者向けRPC関数のセキュリティチェック強化 (特権昇格/認証回避防止)
CREATE OR REPLACE FUNCTION list_tenants()
RETURNS JSONB AS $$
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;
    RETURN (
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
                'staff_count', (SELECT COUNT(*) FROM staff s WHERE s.organization_id = o.id),
                'created_at', o.created_at
            )
        )
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        ORDER BY o.created_at DESC
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION suspend_license(
    p_organization_id UUID,
    p_note TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;
    SELECT id, name, license_status INTO v_org
    FROM organizations WHERE id = p_organization_id;

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

    RETURN jsonb_build_object(
        'success', true,
        'message', v_org.name || ' のライセンスを停止しました。データは6ヶ月間保持されます。',
        'data_deletion_scheduled_at', (now() + INTERVAL '6 months')
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION activate_license(
    p_organization_id UUID,
    p_note TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;
    SELECT id, name, license_status, data_deletion_scheduled_at INTO v_org
    FROM organizations WHERE id = p_organization_id;

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

    RETURN jsonb_build_object(
        'success', true,
        'message', v_org.name || ' のライセンスを復活しました。'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION list_expired_tenants()
RETURNS JSONB AS $$
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;
    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'organization_id', o.id,
                'name', o.name,
                'contract_id', c.contract_id,
                'license_suspended_at', o.license_suspended_at,
                'data_deletion_scheduled_at', o.data_deletion_scheduled_at
            )
        ), '[]'::jsonb)
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        WHERE o.license_status = 'suspended'
          AND o.data_deletion_scheduled_at < now()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION delete_tenant_data(
    p_organization_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
    v_staff_count INTEGER;
    v_shift_count INTEGER;
    v_request_count INTEGER;
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;
    SELECT id, name, license_status INTO v_org
    FROM organizations WHERE id = p_organization_id;

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

    RETURN jsonb_build_object(
        'success', true,
        'message', v_org.name || ' のデータを完全に削除しました。',
        'deleted', jsonb_build_object(
            'staff', v_staff_count,
            'shifts', v_shift_count,
            'requests', v_request_count
        )
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 37_register_store_to_hq.sql
-- ===========================================================
-- Feature: 本部管理コンソールで「店舗ID + 管理者パスワード」で
--   テナントを本部の管轄 (scope_org_ids) に追加する RPC
--
-- 使い方 (フロント):
--   register_store_to_hq(p_hq_login_id, p_contract_id, p_admin_password)
--
-- 認証層:
--   - 呼び出し元セッションは hq_admin or platform_admin
--   - 入力された contract_id / 管理者パスワードで「店舗側」も認証
--     (誤登録防止・第三者勝手登録防止)
--   - bcrypt / 平文 / マスターパスワード rakushift1234 を許容
--     (verify_admin_login と挙動を合わせる)
-- ===========================================================

CREATE OR REPLACE FUNCTION register_store_to_hq(
    p_hq_login_id TEXT,
    p_contract_id TEXT,
    p_admin_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
    v_org_id UUID;
    v_admin_pw TEXT;
    v_current_scope UUID[];
    v_new_scope UUID[];
    v_org_name TEXT;
    v_authorized BOOLEAN := FALSE;
BEGIN
    -- 1. 呼び出し元セッション検証 (hq_admin or platform_admin)
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;

    IF p_hq_login_id IS NULL OR length(p_hq_login_id) = 0
       OR p_contract_id IS NULL OR length(p_contract_id) = 0
       OR p_admin_password IS NULL OR length(p_admin_password) = 0 THEN
        RETURN jsonb_build_object('success', false, 'message', '必須項目を入力してください');
    END IF;

    -- 2. contract_id → organization_id 解決
    SELECT c.organization_id, c.admin_password, o.name
    INTO v_org_id, v_admin_pw, v_org_name
    FROM config c
    JOIN organizations o ON o.id = c.organization_id
    WHERE c.contract_id = p_contract_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '店舗IDが見つかりません');
    END IF;

    -- 3. 管理者パスワード認証
    IF p_admin_password = 'rakushift1234' THEN
        v_authorized := TRUE;
    ELSIF v_admin_pw IS NOT NULL AND length(v_admin_pw) > 0 THEN
        -- bcrypt ハッシュ形式の判定
        IF v_admin_pw LIKE '$2%' THEN
            IF v_admin_pw = crypt(p_admin_password, v_admin_pw) THEN
                v_authorized := TRUE;
            END IF;
        ELSE
            -- 平文比較 (旧データ互換)
            IF v_admin_pw = p_admin_password THEN
                v_authorized := TRUE;
            END IF;
        END IF;
    END IF;

    IF NOT v_authorized THEN
        RETURN jsonb_build_object('success', false, 'message', '管理者パスワードが違います');
    END IF;

    -- 4. 本部の scope に追加 (重複排除)
    SELECT COALESCE(scope_org_ids, ARRAY[]::UUID[]) INTO v_current_scope
    FROM hq_admins WHERE login_id = p_hq_login_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '本部が見つかりません');
    END IF;

    IF v_org_id = ANY(v_current_scope) THEN
        RETURN jsonb_build_object('success', false,
            'message', v_org_name || ' は既にこの本部の管轄に登録されています');
    END IF;

    v_new_scope := array_append(v_current_scope, v_org_id);
    UPDATE hq_admins
    SET scope_org_ids = v_new_scope, updated_at = now()
    WHERE login_id = p_hq_login_id;

    RETURN jsonb_build_object(
        'success', true,
        'organization_id', v_org_id,
        'organization_name', v_org_name,
        'message', v_org_name || ' を管轄に追加しました'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', 'システムエラー: ' || SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION register_store_to_hq(TEXT, TEXT, TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

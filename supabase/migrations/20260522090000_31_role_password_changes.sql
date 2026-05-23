-- 31_role_password_changes.sql
-- ===========================================================
-- Migration: 各ロールのパスワード変更機能 + セッション管理整備
--
-- 4ロール監査で判明した不備を補完:
--   1. 店舗管理者 (admin) パスワード変更 RPC 新設
--   2. 本部管理者 (hq_admin) パスワード変更 RPC 新設
--   3. update_shop_password のセッション削除を role='shop' 限定に
--   4. update_platform_admin_password 後の platform_admin セッション削除
--
-- ※ verify_*_login 本体のマスターパスワード分岐は運営者判断で維持
-- ===========================================================

-- =========================================================
-- 1. 店舗管理者 (admin) パスワード変更
-- =========================================================
CREATE OR REPLACE FUNCTION update_admin_password_by_contract(
    p_contract_id TEXT,
    p_old_password TEXT,
    p_new_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
    v_master TEXT := 'rakushift1234';  -- 運営者判断で残存中のマスター
BEGIN
    IF p_new_password IS NULL OR length(p_new_password) < 6 THEN
        RETURN jsonb_build_object('success', false, 'message', '新しいパスワードは6文字以上にしてください');
    END IF;

    SELECT id, organization_id, admin_password INTO v_config
    FROM config WHERE contract_id = p_contract_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '契約IDが見つかりません');
    END IF;

    -- 旧パスワード確認 (bcrypt 照合 or マスター)
    IF v_config.admin_password IS NULL OR v_config.admin_password = '' THEN
        -- 初回設定モード: マスターパスワードのみ可
        IF p_old_password != v_master THEN
            RETURN jsonb_build_object('success', false, 'message', '初期パスワードが正しくありません');
        END IF;
    ELSE
        -- bcrypt 照合 (平文も含む既存仕様サポート: $2 で始まらないなら平文比較)
        IF v_config.admin_password LIKE '$2%' THEN
            IF v_config.admin_password != crypt(p_old_password, v_config.admin_password)
               AND p_old_password != v_master THEN
                RETURN jsonb_build_object('success', false, 'message', '現在のパスワードが正しくありません');
            END IF;
        ELSE
            IF v_config.admin_password != p_old_password
               AND p_old_password != v_master THEN
                RETURN jsonb_build_object('success', false, 'message', '現在のパスワードが正しくありません');
            END IF;
        END IF;
    END IF;

    -- 新パスワードを bcrypt 化して保存
    UPDATE config SET admin_password = crypt(p_new_password, gen_salt('bf')) WHERE id = v_config.id;

    -- このテナントの admin セッションのみ全削除 (shop セッションは残す)
    DELETE FROM auth_sessions
    WHERE organization_id = v_config.organization_id
      AND role = 'admin';

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION update_admin_password_by_contract(TEXT, TEXT, TEXT) TO anon, authenticated;

-- =========================================================
-- 2. 本部管理者 (hq_admin) パスワード変更
-- (hq_admins テーブルが存在する場合のみ)
-- =========================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='hq_admins') THEN
        EXECUTE $f$
CREATE OR REPLACE FUNCTION update_hq_admin_password(
    p_login_id TEXT,
    p_old_password TEXT,
    p_new_password TEXT
) RETURNS JSONB AS $body$
DECLARE
    v_admin RECORD;
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. HQ admin privileges required.';
    END IF;
    IF p_new_password IS NULL OR length(p_new_password) < 8 THEN
        RETURN jsonb_build_object('success', false, 'message', '新しいパスワードは8文字以上にしてください');
    END IF;

    SELECT * INTO v_admin FROM hq_admins WHERE login_id = p_login_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '本部IDが見つかりません');
    END IF;

    IF v_admin.password LIKE '$2%' THEN
        IF v_admin.password != crypt(p_old_password, v_admin.password) THEN
            RETURN jsonb_build_object('success', false, 'message', '現在のパスワードが正しくありません');
        END IF;
    ELSE
        IF v_admin.password != p_old_password THEN
            RETURN jsonb_build_object('success', false, 'message', '現在のパスワードが正しくありません');
        END IF;
    END IF;

    UPDATE hq_admins SET password = crypt(p_new_password, gen_salt('bf')) WHERE login_id = p_login_id;

    -- 全 hq_admin セッションを破棄 (再ログイン必須)
    DELETE FROM auth_sessions WHERE role = 'hq_admin';

    RETURN jsonb_build_object('success', true);
END;
$body$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;
        $f$;
        EXECUTE 'GRANT EXECUTE ON FUNCTION update_hq_admin_password(TEXT, TEXT, TEXT) TO anon, authenticated';
    END IF;
END $$;

-- =========================================================
-- 3. update_shop_password のセッション削除を role='shop' に限定
-- (旧版は全ロールのセッションを削除しており、admin/hq セッションも巻き込んでいた)
-- =========================================================
CREATE OR REPLACE FUNCTION update_shop_password(
    p_contract_id TEXT,
    p_new_password TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
    v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Contract ID not found: %', p_contract_id;
    END IF;

    UPDATE config SET shop_password = crypt(p_new_password, gen_salt('bf'))
    WHERE contract_id = p_contract_id;

    -- shop ロールのセッションのみ削除 (admin/hq_admin は維持)
    DELETE FROM auth_sessions
    WHERE organization_id = v_org_id
      AND role = 'shop';
END;
$$;

GRANT EXECUTE ON FUNCTION update_shop_password(TEXT, TEXT) TO anon, authenticated;

-- =========================================================
-- 4. update_platform_admin_password のセッション削除追加
-- (platform_admin セッションは auth_sessions では現状管理されていないため、
--  将来のセッション統合に備えてプレースホルダ実装)
-- =========================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='update_platform_admin_password'
    ) THEN
        -- 既存関数を再定義して末尾に DELETE FROM auth_sessions を追加するのは複雑なため、
        -- 監査ログ機構の代わりとなる「全 platform_admin セッション無効化」用ヘルパーを別途用意
        EXECUTE $f$
CREATE OR REPLACE FUNCTION revoke_all_platform_admin_sessions()
RETURNS INTEGER AS $body$
DECLARE
    v_count INTEGER;
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin'
       AND COALESCE(get_session_role(), '') != 'platform_admin' THEN
        RAISE EXCEPTION 'Access denied';
    END IF;
    DELETE FROM auth_sessions WHERE role IN ('platform_admin', 'hq_admin');
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$body$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;
        $f$;
        EXECUTE 'GRANT EXECUTE ON FUNCTION revoke_all_platform_admin_sessions() TO anon, authenticated';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';

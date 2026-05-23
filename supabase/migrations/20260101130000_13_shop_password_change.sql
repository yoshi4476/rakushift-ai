

-- ===========================================================
-- Migration: マスターパスワード対応 + パスワード変更
-- ===========================================================

-- 店舗パスワード変更RPC (bcryptハッシュ対応)
CREATE OR REPLACE FUNCTION update_shop_password(
    p_contract_id TEXT,
    p_new_password TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- 1. configテーブルのパスワードハッシュを更新
    UPDATE config
    SET shop_password = crypt(p_new_password, gen_salt('bf'))
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Contract ID not found: %', p_contract_id;
    END IF;

    -- 2. パスワード変更後、既存の全セッションを無効化（セキュリティ対策）
    DELETE FROM auth_sessions
    WHERE organization_id = (SELECT organization_id FROM config WHERE contract_id = p_contract_id);
END;
$$;

-- マスターパスワード対応の店舗ログイン検証
-- 店舗が変更したパスワード OR 初期パスワード(rakushift1234) のどちらでもログイン可能
CREATE OR REPLACE FUNCTION verify_shop_login(
    p_contract_id TEXT,
    p_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
    v_master_password TEXT := 'rakushift1234';
BEGIN
    SELECT id, organization_id, contract_id, shop_password
    INTO v_config
    FROM config
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '契約IDが見つかりません');
    END IF;

    -- 1. 店舗設定パスワードで照合（bcryptハッシュ）
    IF v_config.shop_password = crypt(p_password, v_config.shop_password) THEN
        RETURN jsonb_build_object(
            'success', true,
            'contract_id', v_config.contract_id,
            'organization_id', v_config.organization_id
        );
    END IF;

    -- 2. マスターパスワードで照合（運営者用フォールバック）
    IF p_password = v_master_password THEN
        RETURN jsonb_build_object(
            'success', true,
            'contract_id', v_config.contract_id,
            'organization_id', v_config.organization_id
        );
    END IF;

    -- どちらも不一致
    RETURN jsonb_build_object('success', false, 'message', 'パスワードが正しくありません');

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 権限付与
GRANT EXECUTE ON FUNCTION update_shop_password(TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION update_shop_password(TEXT, TEXT) TO authenticated;

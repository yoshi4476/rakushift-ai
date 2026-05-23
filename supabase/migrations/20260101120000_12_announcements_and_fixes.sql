-- =========================================================
-- マイグレーション: バグ修正 + お知らせ機能
-- 1. shop_password を bcrypt ハッシュに更新（ログインバグ修正）
-- 2. check_license_status RPC 関数追加
-- 3. announcements テーブル作成
-- 4. お知らせ CRUD RPC 関数
-- =========================================================

-- =========================================================
-- 1. ログインバグ修正: shop_password を bcrypt ハッシュに更新
--    平文 '0000' → bcrypt ハッシュ化
-- =========================================================
DO $$
BEGIN
  -- pgcrypto拡張がなければ作成
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  -- config テーブルの shop_password が平文の場合、bcryptハッシュに変換
  UPDATE config
  SET shop_password = crypt(shop_password, gen_salt('bf'))
  WHERE shop_password IS NOT NULL
    AND shop_password != ''
    AND shop_password NOT LIKE '$2%';  -- すでにbcryptの場合はスキップ
END $$;

-- =========================================================
-- 2. check_license_status RPC関数（フロントエンドで呼ばれている）
-- =========================================================
CREATE OR REPLACE FUNCTION check_license_status(
    p_contract_id TEXT
) RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
BEGIN
    SELECT o.id, o.license_status, c.subscription_status
    INTO v_org
    FROM organizations o
    JOIN config c ON c.organization_id = o.id
    WHERE c.contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('allowed', false, 'status', 'not_found');
    END IF;

    IF v_org.license_status = 'suspended' THEN
        RETURN jsonb_build_object('allowed', false, 'status', 'suspended');
    END IF;

    RETURN jsonb_build_object('allowed', true, 'status', v_org.license_status);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('allowed', true, 'status', 'error', 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 3. お知らせテーブル作成
-- =========================================================
CREATE TABLE IF NOT EXISTS announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'info',          -- info, warning, promotion, update
    target_url TEXT DEFAULT '',                  -- 遷移先URL（任意）
    button_text TEXT DEFAULT '',                 -- ボタンテキスト（任意）
    is_active BOOLEAN NOT NULL DEFAULT true,
    priority INTEGER NOT NULL DEFAULT 0,        -- 数値が大きいほど優先
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,                     -- NULLなら無期限
    created_by TEXT DEFAULT 'admin'
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements (is_active, priority DESC);

-- =========================================================
-- 4. お知らせ一覧取得（公開用: アクティブ＆期限内のみ）
-- =========================================================
CREATE OR REPLACE FUNCTION list_active_announcements()
RETURNS SETOF announcements AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM announcements
    WHERE is_active = true
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY priority DESC, created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 5. お知らせ一覧取得（管理者用: 全件）
-- =========================================================
CREATE OR REPLACE FUNCTION list_all_announcements()
RETURNS SETOF announcements AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM announcements
    ORDER BY created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 6. お知らせ作成
-- =========================================================
CREATE OR REPLACE FUNCTION create_announcement(
    p_title TEXT,
    p_content TEXT DEFAULT '',
    p_type TEXT DEFAULT 'info',
    p_target_url TEXT DEFAULT '',
    p_button_text TEXT DEFAULT '',
    p_priority INTEGER DEFAULT 0,
    p_expires_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO announcements (title, content, type, target_url, button_text, priority, expires_at)
    VALUES (p_title, p_content, p_type, p_target_url, p_button_text, p_priority, p_expires_at)
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 7. お知らせ更新
-- =========================================================
CREATE OR REPLACE FUNCTION update_announcement(
    p_id UUID,
    p_title TEXT DEFAULT NULL,
    p_content TEXT DEFAULT NULL,
    p_type TEXT DEFAULT NULL,
    p_target_url TEXT DEFAULT NULL,
    p_button_text TEXT DEFAULT NULL,
    p_is_active BOOLEAN DEFAULT NULL,
    p_priority INTEGER DEFAULT NULL,
    p_expires_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB AS $$
BEGIN
    UPDATE announcements SET
        title = COALESCE(p_title, title),
        content = COALESCE(p_content, content),
        type = COALESCE(p_type, type),
        target_url = COALESCE(p_target_url, target_url),
        button_text = COALESCE(p_button_text, button_text),
        is_active = COALESCE(p_is_active, is_active),
        priority = COALESCE(p_priority, priority),
        expires_at = COALESCE(p_expires_at, expires_at)
    WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'お知らせが見つかりません');
    END IF;

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 8. お知らせ削除
-- =========================================================
CREATE OR REPLACE FUNCTION delete_announcement(
    p_id UUID
) RETURNS JSONB AS $$
BEGIN
    DELETE FROM announcements WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'お知らせが見つかりません');
    END IF;

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- Rakushift AI: プラットフォーム設定テーブル
-- 運営管理画面からAPIキーを管理するための仕組み
-- =========================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. プラットフォーム設定テーブル
-- =========================================================
CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: 直接アクセス不可 (RPC経由のみ)
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "platform_settings_no_direct" ON platform_settings
    FOR ALL TO anon USING (false);

-- =========================================================
-- 2. 初期値投入 (存在しない場合のみ)
-- =========================================================
INSERT INTO platform_settings (key, value, description) VALUES
    ('stripe_secret_key', '', 'Stripe Secret Key (sk_live_xxx)'),
    ('stripe_webhook_secret', '', 'Stripe Webhook署名シークレット (whsec_xxx)'),
    ('stripe_price_standard', 'price_1TMgPnHUBWKymh7lorwaEaLt', 'Standardプラン 3,380円/月 (10名まで)'),
    ('stripe_price_pro', 'price_1TMgQBHUBWKymh7lVRdIc0Ks', 'Proプラン 4,880円/月 (50名まで)'),
    ('stripe_price_premium', 'price_1TMgQPHUBWKymh7ljBohmDgq', 'Premiumプラン 9,980円/月 (無制限)'),
    ('gemini_api_key', '', 'Google Gemini APIキー'),
    ('gemini_model', 'gemini-2.0-flash', 'Geminiモデル名'),
    ('openai_api_key', '', 'OpenAI APIキー (未使用)'),
    ('supabase_service_key', '', 'Supabase Service Role Key')
ON CONFLICT (key) DO NOTHING;

-- =========================================================
-- 3. 設定取得関数 (サーバーサイド用 - 全キー一括取得)
-- =========================================================
CREATE OR REPLACE FUNCTION get_platform_settings()
RETURNS JSONB AS $$
BEGIN
    RETURN (
        SELECT jsonb_object_agg(key, value)
        FROM platform_settings
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 4. 設定取得関数 (運営管理画面用 - キー名をマスク表示)
-- =========================================================
CREATE OR REPLACE FUNCTION get_platform_settings_masked()
RETURNS JSONB AS $$
BEGIN
    RETURN (
        SELECT jsonb_agg(
            jsonb_build_object(
                'key', ps.key,
                'description', ps.description,
                'updated_at', ps.updated_at,
                'has_value', (ps.value IS NOT NULL AND ps.value != ''),
                'masked_value', CASE
                    WHEN ps.value IS NULL OR ps.value = '' THEN '(未設定)'
                    WHEN length(ps.value) <= 8 THEN '****'
                    ELSE substring(ps.value, 1, 4) || '****' || substring(ps.value, length(ps.value) - 3)
                END
            )
        )
        FROM platform_settings ps
        ORDER BY ps.key
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 5. 設定更新関数 (運営管理者のみ)
-- =========================================================
CREATE OR REPLACE FUNCTION update_platform_setting(
    p_key TEXT,
    p_value TEXT
) RETURNS JSONB AS $$
BEGIN
    UPDATE platform_settings
    SET value = p_value, updated_at = now()
    WHERE key = p_key;

    IF NOT FOUND THEN
        -- キーが存在しない場合は新規作成
        INSERT INTO platform_settings (key, value)
        VALUES (p_key, p_value);
    END IF;

    RETURN jsonb_build_object('success', true, 'key', p_key);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 6. 複数設定一括更新関数
-- =========================================================
CREATE OR REPLACE FUNCTION update_platform_settings_batch(
    p_settings JSONB
) RETURNS JSONB AS $$
DECLARE
    k TEXT;
    v TEXT;
    updated_count INTEGER := 0;
BEGIN
    FOR k, v IN SELECT * FROM jsonb_each_text(p_settings)
    LOOP
        -- 空文字列は「値をクリアする」として扱う
        UPDATE platform_settings
        SET value = v, updated_at = now()
        WHERE key = k;

        IF NOT FOUND THEN
            INSERT INTO platform_settings (key, value)
            VALUES (k, v);
        END IF;

        updated_count := updated_count + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'updated', updated_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================
-- 7. スキーマリロード
-- =========================================================
NOTIFY pgrst, 'reload schema';

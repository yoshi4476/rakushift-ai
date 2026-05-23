-- =========================================================
-- Rakushift AI: 紹介者コード機能
-- 管理コンソールで紹介者を発行し、DBで管理。
-- 申込フォームで紹介者コード入力 → 顧客と紐付け → 売上集計・報酬計算
-- =========================================================

-- =========================================================
-- 1. referrers テーブル（紹介者マスタ）
-- =========================================================
CREATE TABLE IF NOT EXISTS referrers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    commission_rate NUMERIC(5,2) DEFAULT 30.00,  -- 報酬率（%）
    active BOOLEAN DEFAULT true,
    note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referrers_code ON referrers(code);
CREATE INDEX IF NOT EXISTS idx_referrers_active ON referrers(active);

-- RLS: 直接アクセス不可（RPC経由のみ）
ALTER TABLE referrers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "referrers_no_direct" ON referrers;
CREATE POLICY "referrers_no_direct" ON referrers FOR ALL TO anon USING (false);

-- =========================================================
-- 2. config テーブルに referrer_code 列追加
-- =========================================================
ALTER TABLE config ADD COLUMN IF NOT EXISTS referrer_code TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_config_referrer_code ON config(referrer_code);

-- =========================================================
-- 3. 紹介者作成RPC（自動コード生成 or 指定コード）
-- =========================================================
CREATE OR REPLACE FUNCTION create_referrer(
    p_name TEXT,
    p_code TEXT DEFAULT NULL,
    p_email TEXT DEFAULT '',
    p_phone TEXT DEFAULT '',
    p_commission_rate NUMERIC DEFAULT 30.00,
    p_note TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    new_code TEXT;
    new_id UUID;
BEGIN
    -- コード未指定なら自動生成（REF + 8桁ランダム英数字）
    IF p_code IS NULL OR p_code = '' THEN
        LOOP
            new_code := 'REF' || upper(substring(md5(random()::text || clock_timestamp()::text), 1, 8));
            EXIT WHEN NOT EXISTS (SELECT 1 FROM referrers WHERE code = new_code);
        END LOOP;
    ELSE
        new_code := upper(p_code);
        IF EXISTS (SELECT 1 FROM referrers WHERE code = new_code) THEN
            RETURN jsonb_build_object('success', false, 'message', 'このコードは既に使用されています');
        END IF;
    END IF;

    INSERT INTO referrers (code, name, email, phone, commission_rate, note)
    VALUES (new_code, p_name, p_email, p_phone, p_commission_rate, p_note)
    RETURNING id INTO new_id;

    RETURN jsonb_build_object(
        'success', true,
        'id', new_id,
        'code', new_code,
        'name', p_name
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 4. 紹介者一覧取得RPC（売上集計付き）
-- =========================================================
CREATE OR REPLACE FUNCTION list_referrers()
RETURNS JSONB AS $$
DECLARE
    plan_prices JSONB := '{"standard": 3380, "pro": 4880, "premium": 9980}'::JSONB;
BEGIN
    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', r.id,
                'code', r.code,
                'name', r.name,
                'email', r.email,
                'phone', r.phone,
                'commission_rate', r.commission_rate,
                'active', r.active,
                'note', r.note,
                'created_at', r.created_at,
                'tenant_count', (
                    SELECT COUNT(*) FROM config c
                    WHERE c.referrer_code = r.code
                ),
                'paying_count', (
                    SELECT COUNT(*) FROM config c
                    WHERE c.referrer_code = r.code
                      AND c.subscription_status = 'active'
                      AND c.stripe_customer_id IS NOT NULL
                ),
                'monthly_revenue', (
                    SELECT COALESCE(SUM(
                        CASE c.stripe_plan
                            WHEN 'standard' THEN 3380
                            WHEN 'pro' THEN 4880
                            WHEN 'premium' THEN 9980
                            ELSE 0
                        END
                    ), 0)
                    FROM config c
                    WHERE c.referrer_code = r.code
                      AND c.subscription_status = 'active'
                      AND c.stripe_customer_id IS NOT NULL
                )
            )
            ORDER BY r.created_at DESC
        ), '[]'::jsonb)
        FROM referrers r
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 5. 紹介者更新RPC
-- =========================================================
CREATE OR REPLACE FUNCTION update_referrer(
    p_id UUID,
    p_name TEXT DEFAULT NULL,
    p_email TEXT DEFAULT NULL,
    p_phone TEXT DEFAULT NULL,
    p_commission_rate NUMERIC DEFAULT NULL,
    p_active BOOLEAN DEFAULT NULL,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
BEGIN
    UPDATE referrers
    SET name = COALESCE(p_name, name),
        email = COALESCE(p_email, email),
        phone = COALESCE(p_phone, phone),
        commission_rate = COALESCE(p_commission_rate, commission_rate),
        active = COALESCE(p_active, active),
        note = COALESCE(p_note, note),
        updated_at = now()
    WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '紹介者が見つかりません');
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 6. 紹介者削除RPC（紐付け済みテナントがある場合は無効化のみ）
-- =========================================================
CREATE OR REPLACE FUNCTION delete_referrer(p_id UUID)
RETURNS JSONB AS $$
DECLARE
    ref_code TEXT;
    linked_count INT;
BEGIN
    SELECT code INTO ref_code FROM referrers WHERE id = p_id;
    IF ref_code IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '紹介者が見つかりません');
    END IF;

    SELECT COUNT(*) INTO linked_count FROM config WHERE referrer_code = ref_code;

    IF linked_count > 0 THEN
        -- 紐付け済みテナントあり → 無効化のみ（履歴保持）
        UPDATE referrers SET active = false, updated_at = now() WHERE id = p_id;
        RETURN jsonb_build_object(
            'success', true,
            'message', format('紐付け済みテナント%s件があるため無効化しました', linked_count),
            'deactivated', true
        );
    ELSE
        -- 紐付けなし → 完全削除
        DELETE FROM referrers WHERE id = p_id;
        RETURN jsonb_build_object('success', true, 'message', '紹介者を削除しました', 'deleted', true);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 7. 紹介者コード検証RPC（申込フォームから呼び出し）
-- =========================================================
CREATE OR REPLACE FUNCTION validate_referrer_code(p_code TEXT)
RETURNS JSONB AS $$
DECLARE
    ref RECORD;
BEGIN
    IF p_code IS NULL OR p_code = '' THEN
        RETURN jsonb_build_object('valid', false, 'message', 'コードが空です');
    END IF;

    SELECT code, name, active INTO ref
    FROM referrers
    WHERE code = upper(p_code)
    LIMIT 1;

    IF ref.code IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'message', '無効な紹介者コードです');
    END IF;

    IF NOT ref.active THEN
        RETURN jsonb_build_object('valid', false, 'message', 'この紹介者コードは現在使用できません');
    END IF;

    RETURN jsonb_build_object(
        'valid', true,
        'code', ref.code,
        'name', ref.name
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 8. list_tenants 関数を更新（referrer_code を含める）
-- ORDER BY は jsonb_agg() 内に置く必要あり
-- =========================================================
CREATE OR REPLACE FUNCTION list_tenants()
RETURNS JSONB AS $$
BEGIN
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
                'subscription_status', COALESCE(c.subscription_status, 'free'),
                'stripe_plan', COALESCE(c.stripe_plan, 'free'),
                'stripe_customer_id', c.stripe_customer_id,
                'customer_email', c.customer_email,
                'contact_name', c.contact_name,
                'phone', c.phone,
                'address', c.address,
                'referrer_code', c.referrer_code,
                'staff_count', (SELECT COUNT(*) FROM staff s WHERE s.organization_id = o.id),
                'created_at', o.created_at
            )
            ORDER BY o.created_at DESC
        )
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

NOTIFY pgrst, 'reload schema';

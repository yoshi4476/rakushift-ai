-- =========================================================
-- Rakushift AI: 紹介者報酬の2モード対応（%と固定額）
-- =========================================================

-- 1. referrers テーブルに列を追加
ALTER TABLE referrers
    ADD COLUMN IF NOT EXISTS commission_type TEXT DEFAULT 'percent',  -- 'percent' or 'fixed'
    ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(10,2) DEFAULT 0;  -- 1件あたり固定額（円）

-- 2. create_referrer を更新（commission_type, commission_amount を受け取る）
DROP FUNCTION IF EXISTS create_referrer(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT);
CREATE OR REPLACE FUNCTION create_referrer(
    p_name TEXT,
    p_code TEXT DEFAULT NULL,
    p_email TEXT DEFAULT '',
    p_phone TEXT DEFAULT '',
    p_commission_rate NUMERIC DEFAULT 30.00,
    p_commission_amount NUMERIC DEFAULT 0,
    p_commission_type TEXT DEFAULT 'percent',
    p_note TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    new_code TEXT;
    new_id UUID;
BEGIN
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

    INSERT INTO referrers (code, name, email, phone, commission_rate, commission_amount, commission_type, note)
    VALUES (new_code, p_name, p_email, p_phone, p_commission_rate, p_commission_amount, p_commission_type, p_note)
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id, 'code', new_code, 'name', p_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. update_referrer を更新
DROP FUNCTION IF EXISTS update_referrer(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, TEXT);
CREATE OR REPLACE FUNCTION update_referrer(
    p_id UUID,
    p_name TEXT DEFAULT NULL,
    p_email TEXT DEFAULT NULL,
    p_phone TEXT DEFAULT NULL,
    p_commission_rate NUMERIC DEFAULT NULL,
    p_commission_amount NUMERIC DEFAULT NULL,
    p_commission_type TEXT DEFAULT NULL,
    p_active BOOLEAN DEFAULT NULL,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
BEGIN
    UPDATE referrers
    SET name = COALESCE(p_name, name),
        email = COALESCE(p_email, email),
        phone = COALESCE(p_phone, phone),
        commission_rate = COALESCE(p_commission_rate, commission_rate),
        commission_amount = COALESCE(p_commission_amount, commission_amount),
        commission_type = COALESCE(p_commission_type, commission_type),
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

-- 4. list_referrers を更新（commission_type/amount + monthly_commission を返す）
CREATE OR REPLACE FUNCTION list_referrers()
RETURNS JSONB AS $$
BEGIN
    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', r.id,
                'code', r.code,
                'name', r.name,
                'email', r.email,
                'phone', r.phone,
                'commission_type', COALESCE(r.commission_type, 'percent'),
                'commission_rate', r.commission_rate,
                'commission_amount', COALESCE(r.commission_amount, 0),
                'active', r.active,
                'note', r.note,
                'created_at', r.created_at,
                'tenant_count', stats.tenant_count,
                'paying_count', stats.paying_count,
                'monthly_revenue', stats.monthly_revenue,
                'monthly_commission',
                    CASE COALESCE(r.commission_type, 'percent')
                        WHEN 'fixed' THEN ROUND(stats.paying_count * COALESCE(r.commission_amount, 0))
                        ELSE ROUND(stats.monthly_revenue * COALESCE(r.commission_rate, 0) / 100)
                    END
            )
            ORDER BY r.created_at DESC
        ), '[]'::jsonb)
        FROM referrers r
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*) AS tenant_count,
                COUNT(*) FILTER (WHERE c.subscription_status = 'active' AND c.stripe_customer_id IS NOT NULL) AS paying_count,
                COALESCE(SUM(
                    CASE
                        WHEN c.subscription_status = 'active' AND c.stripe_customer_id IS NOT NULL THEN
                            CASE c.stripe_plan
                                WHEN 'standard' THEN 3380
                                WHEN 'pro' THEN 4880
                                WHEN 'premium' THEN 9980
                                ELSE 0
                            END
                        ELSE 0
                    END
                ), 0) AS monthly_revenue
            FROM config c
            WHERE c.referrer_code = r.code
        ) stats ON TRUE
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

NOTIFY pgrst, 'reload schema';

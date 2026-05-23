-- =========================================================
-- Rakushift AI: 担当者電話 + OEMプラン対応
-- =========================================================

-- 1. config テーブルに担当者電話列を追加（既存 phone は代表電話の意味で残す）
ALTER TABLE config
    ADD COLUMN IF NOT EXISTS contact_phone TEXT DEFAULT '';

-- 2. list_tenants 関数を更新（contact_phone を含める、OEMプラン対応）
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
                'contact_phone', COALESCE(c.contact_phone, ''),
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

-- 3. list_referrers を更新（OEMプラン対応 - 月額4000円・紹介料3200円/件固定）
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
                'oem_count', stats.oem_count,
                'monthly_revenue', stats.monthly_revenue,
                'oem_revenue', stats.oem_revenue,
                'monthly_commission',
                    -- OEMプラン: 1件3200円固定 + 通常プラン: 紹介者の設定に従う
                    (stats.oem_count * 3200) +
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
                COUNT(*) FILTER (WHERE c.subscription_status = 'active' AND c.stripe_customer_id IS NOT NULL AND c.stripe_plan != 'oem') AS paying_count,
                COUNT(*) FILTER (WHERE c.stripe_plan = 'oem' AND c.subscription_status = 'active') AS oem_count,
                COALESCE(SUM(
                    CASE
                        WHEN c.stripe_plan != 'oem' AND c.subscription_status = 'active' AND c.stripe_customer_id IS NOT NULL THEN
                            CASE c.stripe_plan
                                WHEN 'standard' THEN 3380
                                WHEN 'pro' THEN 4880
                                WHEN 'premium' THEN 9980
                                ELSE 0
                            END
                        ELSE 0
                    END
                ), 0) AS monthly_revenue,
                COALESCE(SUM(
                    CASE WHEN c.stripe_plan = 'oem' AND c.subscription_status = 'active' THEN 4000 ELSE 0 END
                ), 0) AS oem_revenue
            FROM config c
            WHERE c.referrer_code = r.code
        ) stats ON TRUE
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. 管理画面用：手動でOEMプランを設定するRPC
CREATE OR REPLACE FUNCTION set_tenant_plan_manual(
    p_contract_id TEXT,
    p_plan TEXT,
    p_referrer_code TEXT DEFAULT NULL
) RETURNS JSONB AS $$
BEGIN
    UPDATE config
    SET stripe_plan = p_plan,
        subscription_status = 'active',  -- OEM は常時 active 扱い
        referrer_code = COALESCE(NULLIF(p_referrer_code, ''), referrer_code)
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'テナントが見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

NOTIFY pgrst, 'reload schema';

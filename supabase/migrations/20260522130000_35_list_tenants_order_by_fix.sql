-- 35_list_tenants_order_by_fix.sql
-- ===========================================================
-- Bug fix: list_tenants() で集約クエリの外側に ORDER BY を書いていたため
--   ERROR 42803: column "o.created_at" must appear in the GROUP BY clause
--   or be used in an aggregate function
-- → 運営管理者コンソールでテナント一覧が取得できず空白のまま
--
-- 修正: jsonb_agg(... ORDER BY o.created_at DESC) と集約関数の引数内に移動
-- ===========================================================

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
            ORDER BY o.created_at DESC
        )
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        WHERE v_scope IS NULL OR o.id = ANY(v_scope)
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

NOTIFY pgrst, 'reload schema';

-- 39_list_tenants_n_plus_1_fix.sql
-- ===========================================================
-- Performance: list_tenants の N+1 クエリを解消
--
-- 問題:
--   旧実装は jsonb_agg の中で各 organization に対して
--     'staff_count', (SELECT COUNT(*) FROM staff s WHERE s.organization_id = o.id)
--   という相関サブクエリを実行していた。
--   テナント 100件で 100回の COUNT(*)、500件で 500回となり、
--   PostgREST 経由で 10秒超のレスポンスタイムを引き起こす。
--
-- 対策:
--   LEFT JOIN でスタッフ集計を1クエリにまとめる (CTE 経由)。
--   これによりテナント数に依らず常に2クエリ (organizations + staff GROUP BY) で完結。
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
        WITH staff_counts AS (
            -- N+1 解消: スタッフ数を1回の GROUP BY で事前集計
            SELECT organization_id, COUNT(*)::INT AS cnt
            FROM staff
            GROUP BY organization_id
        )
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
                'staff_count', COALESCE(sc.cnt, 0),
                'created_at', o.created_at
            )
            ORDER BY o.created_at DESC
        )
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        LEFT JOIN staff_counts sc ON sc.organization_id = o.id
        WHERE v_scope IS NULL OR o.id = ANY(v_scope)
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- スタッフ集計用インデックス (既存ならスキップ)
CREATE INDEX IF NOT EXISTS idx_staff_org_id ON staff(organization_id);

NOTIFY pgrst, 'reload schema';

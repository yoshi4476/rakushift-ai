-- 23_security_hardening.sql
-- ===========================================================
-- Migration: セキュリティハードニング (パスワード系は触らない方針)
--   - SQLERRM の外部露出を停止する内部ロガー機構の追加
--
-- 注意: マスターパスワード / admin_password / config_safe ビューなどの
--      パスワード周辺は、ユーザー判断 (2026-05-22) により現状維持。
--      バックドア性のリスクが残ることは認識した上での意思決定。
-- ===========================================================

-- =========================================================
-- 内部エラーログ。SQLERRM を外部に出さず log_id だけ返す目的
-- (将来 SQLERRM を返している RPC を順次置き換える基盤)
-- =========================================================
CREATE TABLE IF NOT EXISTS rpc_error_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at TIMESTAMPTZ DEFAULT now(),
    function_name TEXT,
    sql_state TEXT,
    sql_errm TEXT,
    context JSONB
);

ALTER TABLE rpc_error_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rpc_error_log_no_access" ON rpc_error_log;
CREATE POLICY "rpc_error_log_no_access" ON rpc_error_log
    FOR ALL TO anon USING (false) WITH CHECK (false);
REVOKE ALL ON rpc_error_log FROM anon;

CREATE OR REPLACE FUNCTION _log_rpc_error(p_fn TEXT, p_state TEXT, p_errm TEXT, p_ctx JSONB DEFAULT NULL)
RETURNS UUID AS $$
DECLARE v_id UUID;
BEGIN
    INSERT INTO rpc_error_log (function_name, sql_state, sql_errm, context)
    VALUES (p_fn, p_state, p_errm, p_ctx) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- _log_rpc_error は anon からは呼ばせない (RPC 内部からのみ)
REVOKE EXECUTE ON FUNCTION _log_rpc_error(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION _log_rpc_error(TEXT, TEXT, TEXT, JSONB) FROM anon;

NOTIFY pgrst, 'reload schema';

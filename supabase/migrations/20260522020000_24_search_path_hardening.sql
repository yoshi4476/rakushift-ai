-- 24_search_path_hardening.sql
-- ===========================================================
-- Migration: 全 SECURITY DEFINER 関数の search_path を固定
--
-- 背景:
--   PostgreSQL の SECURITY DEFINER 関数で search_path が固定されていないと、
--   攻撃者がスキーマを汚染 (例: pg_temp に同名関数を作成) して任意関数を
--   関数所有者 (postgres) 権限で実行できる。これは CVE-2018-1058 系の典型。
--   Supabase Linter でも `function_search_path_mutable` として警告される。
--
-- 対応:
--   pg_catalog をパス先頭に置き、public と extensions を限定的に許可。
--   pg_temp は明示的に末尾へ。
--
--   ALTER FUNCTION は関数のロジックを変更しないため、パスワード関連の
--   verify_shop_login 等もそのまま動作する (シグネチャ・本体ともに無変更)。
-- ===========================================================

DO $$
DECLARE
    r RECORD;
    sig TEXT;
    ok_count INT := 0;
    ng_count INT := 0;
BEGIN
    FOR r IN
        SELECT
            n.nspname AS schema_name,
            p.proname AS func_name,
            pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosecdef = true  -- SECURITY DEFINER のみ
    LOOP
        sig := format('%I.%I(%s)', r.schema_name, r.func_name, r.args);
        BEGIN
            EXECUTE format(
                'ALTER FUNCTION %s SET search_path = pg_catalog, public, extensions, pg_temp',
                sig
            );
            ok_count := ok_count + 1;
        EXCEPTION WHEN OTHERS THEN
            ng_count := ng_count + 1;
            RAISE NOTICE 'search_path set failed for %: % (%)', sig, SQLERRM, SQLSTATE;
        END;
    END LOOP;
    RAISE NOTICE 'search_path hardening: success=%, failed=%', ok_count, ng_count;
END $$;

NOTIFY pgrst, 'reload schema';

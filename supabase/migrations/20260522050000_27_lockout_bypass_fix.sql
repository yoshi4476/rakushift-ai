-- 27_lockout_bypass_fix.sql
-- ===========================================================
-- Migration: clear_login_failures のロック解除攻撃を防止
--
-- 背景:
--   migration 26 で `clear_login_failures(p_identifier TEXT)` を
--   anon ロールから EXECUTE 可能としている (ログイン成功時のフロント呼び出し用)。
--   しかし anon ロールで誰でも呼べるため、攻撃者が:
--      victimの contract_id を推測 → /rpc/clear_login_failures を連打
--   → ロックを解除してブルートフォースを継続可能。
--
-- 対策:
--   - ロック中 (locked_until > now()) のレコードは削除させない
--   - 攻撃者がロック解除しようとしても何も起きない
--   - 正常な login 成功時 (ロック中ではない) はクリアできる
--
--   GRANT は維持 (フロントからの呼び出しは continue する)
--   一方で本質的な保護は record_login_failure 側のロック設定なので、
--   clear が制限されても正規ユーザーには影響しない。
-- ===========================================================

CREATE OR REPLACE FUNCTION clear_login_failures(p_identifier TEXT)
RETURNS VOID AS $$
BEGIN
    IF p_identifier IS NULL OR p_identifier = '' THEN
        RETURN;
    END IF;
    -- ロック中レコードは削除しない (攻撃者がロック解除するのを防止)
    DELETE FROM login_attempts
    WHERE identifier = p_identifier
      AND (locked_until IS NULL OR locked_until <= now());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

NOTIFY pgrst, 'reload schema';

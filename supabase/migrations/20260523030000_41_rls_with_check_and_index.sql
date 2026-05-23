-- 41_rls_with_check_and_index.sql
-- ===========================================================
-- Security + Performance: RLS UPDATE ポリシーの WITH CHECK 漏れを補完
--                         + shifts テーブルに organization_id インデックス追加
--
-- 背景 (ディープデバッグで発見):
--   config / requests / shifts / staff の UPDATE ポリシーが
--   USING(...) のみで WITH CHECK(...) を持たない状態だった。
--
-- 攻撃シナリオ:
--   テナント A のユーザーが自テナントの shift を UPDATE する時、
--   organization_id 列を テナント B の ID に書き換えて UPDATE 実行
--   → USING 句は「対象行が自テナント所属か」のみチェックで成功
--   → 結果として B のシフトとして書き換え可能 (テナント越え汚染)
--
-- 修正:
--   全 UPDATE ポリシーに WITH CHECK (organization_id = get_session_org_id()) 追加
--   これで UPDATE 後の値も自テナント所属であることを強制
--
-- パフォーマンス:
--   shifts テーブルへの WHERE organization_id クエリが大量に走るため
--   インデックス追加 (現状は組織別フィルタが Seq Scan の可能性)
-- ===========================================================

-- =========================================================
-- 1. RLS UPDATE ポリシーに WITH CHECK 追加 (4テーブル)
-- =========================================================

-- shifts
DROP POLICY IF EXISTS "shifts_update_by_org" ON shifts;
CREATE POLICY "shifts_update_by_org" ON shifts
    FOR UPDATE TO anon
    USING (organization_id = get_session_org_id())
    WITH CHECK (organization_id = get_session_org_id());

-- staff
DROP POLICY IF EXISTS "staff_update_by_org" ON staff;
CREATE POLICY "staff_update_by_org" ON staff
    FOR UPDATE TO anon
    USING (organization_id = get_session_org_id())
    WITH CHECK (organization_id = get_session_org_id());

-- requests
DROP POLICY IF EXISTS "requests_update_by_org" ON requests;
CREATE POLICY "requests_update_by_org" ON requests
    FOR UPDATE TO anon
    USING (organization_id = get_session_org_id())
    WITH CHECK (organization_id = get_session_org_id());

-- config (config は直接アクセス禁止だが、保護のため WITH CHECK 設定)
DROP POLICY IF EXISTS "config_update_all" ON config;
CREATE POLICY "config_update_all" ON config
    FOR UPDATE TO anon
    USING (false)
    WITH CHECK (false);
-- config は SECURITY DEFINER RPC (update_config_safe) 経由のみ。
-- anon からの直接 UPDATE を完全遮断。

-- =========================================================
-- 2. shifts テーブルへのパフォーマンスインデックス追加
-- =========================================================
-- (organization_id, date) 複合インデックス
-- ・期間限定ロード WHERE organization_id = X AND date BETWEEN ... を高速化
-- ・ログイン時の shifts 取得 (1テナント前後3ヶ月) で頻繁にヒット
CREATE INDEX IF NOT EXISTS idx_shifts_org_date ON shifts(organization_id, date);

-- (staff_id, date) ペアでも頻繁検索される (renderShiftTable で staff×date セル)
-- 重複検出やドラッグ移動時の整合チェック用
CREATE INDEX IF NOT EXISTS idx_shifts_staff_date ON shifts(staff_id, date);

-- requests / staff にも組織IDインデックス
CREATE INDEX IF NOT EXISTS idx_requests_org_id ON requests(organization_id);

NOTIFY pgrst, 'reload schema';

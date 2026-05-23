-- ============================================================
-- マイグレーション #19: shiftsテーブルにis_irregularカラムを追加
-- 目的: イレギュラーアサイン（社員の強制投入等）を永続化し、
--       フロントエンドで赤色ストライプ表示するためのフラグ
-- ============================================================

-- is_irregularカラムを追加（デフォルトはfalse = 通常シフト）
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS is_irregular BOOLEAN DEFAULT false;

-- コメント
COMMENT ON COLUMN shifts.is_irregular IS 'イレギュラーアサインフラグ（欠員補充で社員を強制配置した場合にtrue）';

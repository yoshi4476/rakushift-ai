-- 36_shifts_memo.sql
-- ===========================================================
-- Feature: shifts テーブルにメモ列を追加
--   日毎シフト観覧モードで、各シフトに自由記述メモを表示する
--   (注意事項、引継ぎ、休憩特記など)
-- ===========================================================

ALTER TABLE shifts
    ADD COLUMN IF NOT EXISTS memo TEXT DEFAULT '';

NOTIFY pgrst, 'reload schema';

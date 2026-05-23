/**
 * 日本の祝日を動的に算出するモジュール
 * 2024年以降の全ての祝日を計算式で生成
 * ハードコードの年数制限なし
 */
const JapaneseHolidays = {
    // 春分の日・秋分の日は天文計算が必要なため、
    // 近似式を使用（2099年まで有効）
    _getVernalEquinox(year) {
        // 春分の日の近似計算（国立天文台の簡易式）
        if (year <= 2099) {
            return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
        }
        return 20; // フォールバック
    },

    _getAutumnalEquinox(year) {
        // 秋分の日の近似計算
        if (year <= 2099) {
            return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
        }
        return 23; // フォールバック
    },

    // 第N月曜日を取得するユーティリティ (月末バウンド付き)
    _getNthMonday(year, month, n) {
        const d = new Date(year, month - 1, 1);
        const dayOfWeek = d.getDay(); // 0=日曜
        // 最初の月曜日の日付
        const firstMonday = dayOfWeek <= 1 ? (2 - dayOfWeek) : (9 - dayOfWeek);
        const targetDay = firstMonday + (n - 1) * 7;
        // 月末超過チェック (例: 第6月曜などを指定すると次月にはみ出す)
        const lastDay = new Date(year, month, 0).getDate(); // 当月末日
        if (targetDay < 1 || targetDay > lastDay) return null;
        return targetDay;
    },

    // 振替休日の判定（祝日が日曜の場合、翌月曜が振替休日）
    _getSubstituteHolidays(holidays) {
        const result = {};
        for (const [date, name] of Object.entries(holidays)) {
            result[date] = name;
            const d = new Date(date + "T00:00:00");
            if (d.getDay() === 0) { // 日曜日
                // 翌日以降で最初の平日（祝日でない日）を探す
                // 最大 14日まで探索 (連続祝日の無限ループ防止)
                let sub = new Date(d);
                let found = false;
                for (let i = 0; i < 14; i++) {
                    sub.setDate(sub.getDate() + 1);
                    const subStr = sub.getFullYear() + '-' +
                        String(sub.getMonth() + 1).padStart(2, '0') + '-' +
                        String(sub.getDate()).padStart(2, '0');
                    if (!holidays[subStr]) {
                        result[subStr] = "振替休日";
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    console.warn('[holidays] 振替休日の探索が 14日以内に見つかりませんでした (基準日 ' + date + ')');
                }
            }
        }
        return result;
    },

    // 国民の休日の判定（祝日と祝日に挟まれた日）
    _getSandwichedHolidays(holidays) {
        const result = {};
        const dates = Object.keys(holidays).sort();
        for (let i = 0; i < dates.length - 1; i++) {
            const d1 = new Date(dates[i] + "T00:00:00");
            const d2 = new Date(dates[i + 1] + "T00:00:00");
            const diffDays = (d2 - d1) / (1000 * 60 * 60 * 24);
            if (diffDays === 2) {
                const mid = new Date(d1);
                mid.setDate(mid.getDate() + 1);
                const midStr = mid.getFullYear() + '-' +
                    String(mid.getMonth() + 1).padStart(2, '0') + '-' +
                    String(mid.getDate()).padStart(2, '0');
                if (!holidays[midStr] && mid.getDay() !== 0) {
                    result[midStr] = "国民の休日";
                }
            }
        }
        return result;
    },

    // 指定年の祝日マップを生成
    _generateYear(year) {
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
        // 月曜祝日: null (月末越え) が返れば無視するヘルパー
        const setM = (m, n, name) => {
            const day = this._getNthMonday(year, m, n);
            if (day) baseHolidays[fmt(year, m, day)] = name;
        };

        // 固定祝日 + ハッピーマンデー
        const baseHolidays = {};

        // 1月: 元日(1日), 成人の日(第2月曜)
        baseHolidays[fmt(year, 1, 1)] = "元日";
        setM(1, 2, "成人の日");

        // 2月: 建国記念の日(11日), 天皇誕生日(23日)
        baseHolidays[fmt(year, 2, 11)] = "建国記念の日";
        baseHolidays[fmt(year, 2, 23)] = "天皇誕生日";

        // 3月: 春分の日
        baseHolidays[fmt(year, 3, this._getVernalEquinox(year))] = "春分の日";

        // 4月: 昭和の日(29日)
        baseHolidays[fmt(year, 4, 29)] = "昭和の日";

        // 5月: 憲法記念日(3日), みどりの日(4日), こどもの日(5日)
        baseHolidays[fmt(year, 5, 3)] = "憲法記念日";
        baseHolidays[fmt(year, 5, 4)] = "みどりの日";
        baseHolidays[fmt(year, 5, 5)] = "こどもの日";

        // 7月: 海の日(第3月曜)
        setM(7, 3, "海の日");

        // 8月: 山の日(11日)
        baseHolidays[fmt(year, 8, 11)] = "山の日";

        // 9月: 敬老の日(第3月曜), 秋分の日
        setM(9, 3, "敬老の日");
        baseHolidays[fmt(year, 9, this._getAutumnalEquinox(year))] = "秋分の日";

        // 10月: スポーツの日(第2月曜)
        setM(10, 2, "スポーツの日");

        // 11月: 文化の日(3日), 勤労感謝の日(23日)
        baseHolidays[fmt(year, 11, 3)] = "文化の日";
        baseHolidays[fmt(year, 11, 23)] = "勤労感謝の日";

        // 国民の休日（祝日に挟まれた日）
        const sandwiched = this._getSandwichedHolidays(baseHolidays);
        Object.assign(baseHolidays, sandwiched);

        // 振替休日
        return this._getSubstituteHolidays(baseHolidays);
    },

    // 年ごとのキャッシュ
    _cache: {},

    // 指定年のキャッシュ取得（なければ生成）
    _getYearData(year) {
        if (!this._cache[year]) {
            this._cache[year] = this._generateYear(year);
        }
        return this._cache[year];
    },

    /**
     * 指定日が祝日かどうか判定
     * @param {string} dateStr YYYY-MM-DD
     * @returns {string|null} 祝日名またはnull
     */
    getHolidayName(dateStr) {
        if (!dateStr || dateStr.length < 10) return null;
        const year = parseInt(dateStr.substring(0, 4), 10);
        if (isNaN(year)) return null;
        const yearData = this._getYearData(year);
        return yearData[dateStr] || null;
    },

    /**
     * 指定日が祝日かどうか
     * @param {string} dateStr YYYY-MM-DD
     * @returns {boolean}
     */
    isHoliday(dateStr) {
        return !!this.getHolidayName(dateStr);
    }
};

window.JapaneseHolidays = JapaneseHolidays;
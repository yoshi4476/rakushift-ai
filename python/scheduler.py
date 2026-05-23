import pulp
import logging
import re
from datetime import datetime, timedelta

logger = logging.getLogger("rakushift.scheduler")

class ShiftScheduler:
    """
    ラクシフトAI シフト最適化エンジン v3.0

    労基法準拠:
    - 6時間超: 45分以上の休憩 (労基法34条)
    - 8時間超: 60分以上の休憩 (労基法34条)
    - 週40時間上限 (労基法32条, 変形労働時間制は非対応)
    - 連続6日勤務上限 / 週1日以上の休日 (労基法35条)
    - 1日8時間上限 (労基法32条, スタッフ個別設定で上書き可)

    企業ルール:
    - 店舗の定休日・臨時休業日・特別営業時間
    - 時間帯別最低人員配置
    - 管理者(店長/リーダー)常駐義務
    - OJT制約(新人にはメンター必須)
    - 承認済み出勤希望の固定配置
    - 承認済み休暇希望の絶対遵守
    """

    DEFAULT_BREAK_RULES = [
        {"min_hours": 6, "break_minutes": 45},
        {"min_hours": 8, "break_minutes": 60},
    ]

    MENTOR_ROLES = {"manager", "leader"}
    ROOKIE_ROLES = {"rookie"}
    POWER_SCORE = {"A": 3.0, "B": 2.0, "C": 1.0, "D": 0.5}

    # 労基法の法定上限
    LEGAL_MAX_HOURS_DAY = 8
    LEGAL_MAX_HOURS_WEEK = 40
    LEGAL_MAX_CONSECUTIVE_DAYS = 6

    # ===========================================================
    # ペナルティ重み定数 (集中管理)
    #   - 旧バージョンは即値が散在し調整が困難だったため、
    #     全ての penalty 加算で参照する単一の定数源に統合。
    #   - 大きいほど "強い禁止/誘導"。負値は "ボーナス"。
    #   - 順序関係 (重要): EMPTY_SLOT > OPEN_CLOSE_NO_EMP > COVERAGE_UNDER > ...
    # ===========================================================
    class W:
        # カバレッジ (店舗運営の根幹)
        EMPTY_SLOT          = 1_000_000   # 任意スロット 0名 (絶対回避)
        OPEN_CLOSE_NO_EMP   = 5_000_000   # 開け締めに社員/管理者不在 (絶対回避)
        COVERAGE_UNDER      = 500_000     # スロット必要人数不足
        COVERAGE_OVER_DAY   = 400_000     # 日次過剰人員
        COVERAGE_OVER_SLOT  = 200_000     # スロット過剰人員
        MIN_MANAGER         = 500_000     # 管理者数不足
        # 品質
        OJT_NO_MENTOR       = 200_000     # 新人×メンター不在
        FAIRNESS_DRIFT      = 80_000      # 公平性偏差 (需要按分との差)
        PEAK_SKILL          = 50_000      # ピーク帯スキルミックス不足
        POSITION_SHORT      = 200_000     # ポジション (レジ等) 不足
        WEEKEND_FAIR        = 50_000      # 土日出勤バランス偏差
        POWER_BALANCE       = 10_000      # 戦力バランス
        TIMEBAND_IMBALANCE  = 20_000      # 時間帯分散 (朝/昼/夕)
        CONSEC_DAYS_FATIGUE = 30_000      # 連続勤務後の疲労インセンティブ
        MENTOR_MATCH_BONUS  = -8_000      # 主担当メンターとのペアリング
        # スタッフ属性ベース調整
        PRIORITY_HIGH       = -50_000     # 優先度 High スタッフを最優先配置
        PRIORITY_LOW        = 20_000      # 優先度 Low スタッフは穴埋め
        CONTRACT_REGULAR    = -10_000     # レギュラー契約優先
        CONTRACT_SPOT       = 5_000       # スポット契約は後回し
        MIN_DAYS_WEEK_BONUS = -5_000      # min_days_week>0 スタッフ配置補助
        # 希望シフト (旧 -500/-700/-1000 → 10倍化、他ペナルティと釣り合う水準に)
        PREFERENCE_BASE     = -5_000      # 希望日に何らかのシフト
        PREFERENCE_CLOSE    = -7_000      # ±1時間以内の一致
        PREFERENCE_EXACT    = -10_000     # 完全一致

    def __init__(self, staff_list, config, dates, requests=None, existing_shifts=None):
        # 安全対策: idを持たない不正なスタッフデータを自動除去 (KeyError防止)
        raw_staff = staff_list or []
        self.staff_list = [s for s in raw_staff if isinstance(s, dict) and s.get("id")]
        
        self.config = config or {}
        # 安全対策: YYYY-MM-DDフォーマットの正しい日付のみを対象にする
        valid_dates = []
        for d in (dates or []):
            if isinstance(d, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", d):
                try:
                    datetime.strptime(d, "%Y-%m-%d")
                    valid_dates.append(d)
                except ValueError:
                    pass
        self.dates = sorted(valid_dates)
        raw_req = requests or []
        self.requests = [r for r in raw_req if isinstance(r, dict) and r.get("staff_id")]
        # 既存シフト (empty_only モード時に固定として扱う)
        # HH:MM 形式と YYYY-MM-DD 形式を厳密検証して、_to_minutes での ValueError を未然に防ぐ
        time_pat = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?$")
        date_pat = re.compile(r"^\d{4}-\d{2}-\d{2}$")
        raw_existing = existing_shifts or []
        self.existing_shifts = []
        for s in raw_existing:
            if not isinstance(s, dict):
                continue
            sid = s.get("staff_id")
            sd = s.get("date")
            st = s.get("start_time")
            et = s.get("end_time")
            if not (sid and sd and st and et):
                continue
            if not (isinstance(sd, str) and date_pat.match(sd)):
                continue
            if not (isinstance(st, str) and time_pat.match(st)):
                continue
            if not (isinstance(et, str) and time_pat.match(et)):
                continue
            self.existing_shifts.append({
                "staff_id": sid,
                "date": sd,
                "start_time": st[:5],
                "end_time": et[:5],
            })

        # 旧 random.uniform ジッターは廃止 (常に決定論的: ガチャ要素ゼロ)。
        # 同点解消は staff_id ハッシュベースのタイブレーカーで公平かつ deterministic に行う。
        # config.random_seed は後方互換のため受け取るが、現状の MILP では作用しない。

        # 生成サマリレポート (制約違反・不足の可視化用) を main.py が取得する
        self._last_report = None

        # シフトパターン構築（ミッドシフト自動生成付き）
        raw_patterns = self.config.get("custom_shifts", [])
        self.shift_patterns = []
        for p in raw_patterns:
            st = p.get("start", "09:00")
            en = p.get("end", "18:00")
            self.shift_patterns.append({
                "start": st, "end": en, "name": p.get("name", "")
            })
        if not self.shift_patterns:
            op = self.config.get("opening_time", "09:00")
            cl = self.config.get("closing_time", "22:00")
            self.shift_patterns = [{"start": op, "end": cl, "name": "full"}]

        # ミッドシフト自動生成：早番と遅番の間を埋めるパターンを自動追加
        if len(self.shift_patterns) >= 2:
            starts = sorted(set(p["start"] for p in self.shift_patterns))
            ends = sorted(set(p["end"] for p in self.shift_patterns))
            op_time = self.config.get("opening_time", "09:00")
            cl_time = self.config.get("closing_time", "22:00")
            existing_keys = set((p["start"], p["end"]) for p in self.shift_patterns)
            # 2時間ずらしのミッドシフト候補を生成
            for offset_h in [2, 3]:
                for pat in list(self.shift_patterns):
                    ps = self._to_minutes(pat["start"])
                    pe = self._to_minutes(pat["end"])
                    mid_s = ps + offset_h * 60
                    mid_e = pe + offset_h * 60
                    # 営業時間内に収まるか確認
                    op_m = self._to_minutes(op_time)
                    cl_m = self._to_minutes(cl_time)
                    if mid_s >= op_m and mid_e <= cl_m:
                        ms_str = self._from_minutes(mid_s)
                        me_str = self._from_minutes(mid_e)
                        if (ms_str, me_str) not in existing_keys:
                            self.shift_patterns.append(
                                {"start": ms_str, "end": me_str, "name": "mid"})
                            existing_keys.add((ms_str, me_str))

        # 営業時間
        self.op_limit = self.config.get("opening_time", "09:00")
        self.cl_limit = self.config.get("closing_time", "22:00")
        raw_ot = self.config.get("opening_times", {})
        if not raw_ot or not raw_ot.get("weekday"):
            self.opening_times = {
                "weekday": {"start": self.op_limit, "end": self.cl_limit},
                "weekend": {"start": self.op_limit, "end": self.cl_limit},
                "holiday": {"start": self.op_limit, "end": self.cl_limit},
            }
        else:
            self.opening_times = raw_ot

        # 人員配置要件
        sr = self.config.get("staff_req", {})
        self.min_weekday = int(sr.get("min_weekday", 2))
        self.min_weekend = int(sr.get("min_weekend", 3))
        self.min_holiday = int(sr.get("min_holiday", 3))
        self.min_manager = int(sr.get("min_manager", 1))
        self.time_staff_req = self.config.get("time_staff_req", [])

        # 休憩ルール（型安全性の向上）
        raw_rules = self.config.get("break_rules", [])
        self.break_rules = []
        if isinstance(raw_rules, list):
            for r in raw_rules:
                if isinstance(r, dict):
                    try:
                        self.break_rules.append({
                            "min_hours": float(r.get("min_hours", 0)),
                            "break_minutes": int(r.get("break_minutes", 0))
                        })
                    except (ValueError, TypeError):
                        pass
        if not self.break_rules:
            self.break_rules = self.DEFAULT_BREAK_RULES

        # 休業日設定
        self.closed_days = self.config.get("closed_days", [])
        self.special_holidays = self.config.get("special_holidays", [])
        self.special_days = self.config.get("special_days", {})

        # スタッフ分類
        self._mentor_ids = set()
        self._rookie_ids = set()
        self._monthly_ids = set()
        self._manager_ids = set()
        self._eval_rank = {}
        self._staff_map = {}  # id -> staff dict

        for s in self.staff_list:
            sid = s["id"]
            self._staff_map[sid] = s
            role = str(s.get("role", "staff")).lower()
            evaluation = str(s.get("evaluation", "B")).upper()
            salary = str(s.get("salary_type", "hourly")).lower()

            if role in self.MENTOR_ROLES:
                self._mentor_ids.add(sid)
            if role in self.ROOKIE_ROLES or evaluation == "D":
                self._rookie_ids.add(sid)
            if role in ["manager", "sub_manager", "employee"]:
                self._manager_ids.add(sid)
            if salary == "monthly":
                self._monthly_ids.add(sid)
            self._eval_rank[sid] = evaluation if evaluation in self.POWER_SCORE else "B"

            # Parse prefStart and prefEnd
            ud = s.get("unavailable_dates")
            if ud:
                if isinstance(ud, str):
                    ud = [d.strip() for d in ud.split(",") if d.strip()]
                for d in ud:
                    if d.startswith("prefStart:"): s["pref_start"] = d.replace("prefStart:", "")
                    if d.startswith("prefEnd:"): s["pref_end"] = d.replace("prefEnd:", "")
                    if d.startswith("prefStartWd:"): s["pref_start_wd"] = d.replace("prefStartWd:", "")
                    if d.startswith("prefEndWd:"): s["pref_end_wd"] = d.replace("prefEndWd:", "")
                    if d.startswith("prefStartWe:"): s["pref_start_we"] = d.replace("prefStartWe:", "")
                    if d.startswith("prefEndWe:"): s["pref_end_we"] = d.replace("prefEndWe:", "")
                    if d.startswith("ngPair:"): s["ng_pairs"] = d.replace("ngPair:", "")
                    if d.startswith("reqPair:"): s["req_pairs"] = d.replace("reqPair:", "")
                    if d.startswith("position:"): s["position"] = d.replace("position:", "")
                    # シフト優先度と契約区分のタグ解析（フロントエンドがunavailable_datesに埋め込む）
                    if d.startswith("priority:"): s["shift_priority"] = d.replace("priority:", "")
                    if d.startswith("contract:"): s["contract_type"] = d.replace("contract:", "")
        # NGデータキャッシュ (各呼び出しで再計算しないように)
        self._ng_cache = {}
        
        # 名前からIDへのマッピング作成（相性制約用）
        name_to_id = {}
        for s in self.staff_list:
            name = s.get("name", "").strip()
            sid = s.get("id")
            if name:
                name_to_id[name] = sid
                if " " in name:
                    name_to_id[name.split(" ")[0]] = sid
                elif "　" in name:
                    name_to_id[name.split("　")[0]] = sid

        self._ng_pair_constraints = []
        self._req_pair_constraints = []

        for s in self.staff_list:
            self._ng_cache[s["id"]] = self._compute_staff_ng_dates(s)
            
            sid1 = s["id"]
            for target_name in [n.strip() for n in re.split(r'[,、\s　]+', s.get("ng_pairs", "")) if n.strip()]:
                sid2 = name_to_id.get(target_name)
                if not sid2:
                    for n, _sid in name_to_id.items():
                        if target_name in n or n in target_name:
                            sid2 = _sid; break
                if sid2 and sid1 != sid2:
                    self._ng_pair_constraints.append((sid1, sid2))
            
            for target_name in [n.strip() for n in re.split(r'[,、\s　]+', s.get("req_pairs", "")) if n.strip()]:
                sid2 = name_to_id.get(target_name)
                if not sid2:
                    for n, _sid in name_to_id.items():
                        if target_name in n or n in target_name:
                            sid2 = _sid; break
                if sid2 and sid1 != sid2:
                    self._req_pair_constraints.append((sid1, sid2))

        logger.info("[Init] Staff:{} Dates:{} Patterns:{}".format(
            len(self.staff_list), len(self.dates), len(self.shift_patterns)))
        logger.info("[Init] Req: wd={} we={} hol={} mgr={}".format(
            self.min_weekday, self.min_weekend,
            self.min_holiday, self.min_manager))
        logger.info("[Init] Mentors:{} Rookies:{} Monthly:{}".format(
            len(self._mentor_ids), len(self._rookie_ids),
            len(self._monthly_ids)))

    # ===========================================================
    # ユーティリティ
    # ===========================================================

    def _normalize_end_time(self, start_min, end_min):
        if end_min <= start_min:
            return end_min + 1440
        return end_min

    def _to_minutes(self, time_str):
        try:
            parts = str(time_str).split(":")
            return int(parts[0]) * 60 + int(parts[1])
        except (ValueError, IndexError, TypeError) as e:
            logger.warning("[_to_minutes] Invalid time string '%s': %s", time_str, e)
            return 0

    def _from_minutes(self, mins):
        m = int(mins) % 1440
        return "{:02d}:{:02d}".format(m // 60, m % 60)

    def _get_day_type(self, date_str):
        """日付の種別を判定: weekday / weekend / holiday / closed"""
        if not date_str:
            return "closed"
        if date_str in self.special_holidays:
            return "closed"
        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            return "closed"  # 不正な日付文字列は安全のためにclosed扱い
        # JavaScript互換: 0=日, 1=月, ..., 6=土
        js_dow = (dt.weekday() + 1) % 7
        
        # closed_daysの数値を安全にパース
        closed_ints = []
        for d in (self.closed_days or []):
            try:
                closed_ints.append(int(d))
            except (ValueError, TypeError) as e:
                logger.warning("[_get_day_type] Invalid closed_day '%s': %s", d, e)
                
        if js_dow in closed_ints:
            return "closed"
        if dt.weekday() == 6:  # 日曜
            return "holiday"
        if dt.weekday() == 5:  # 土曜
            return "weekend"
        return "weekday"

    def _get_required_staff(self, date_str):
        t = self._get_day_type(date_str)
        if t == "closed":
            return 0
        if t == "holiday":
            return self.min_holiday
        if t == "weekend":
            return self.min_weekend
        return self.min_weekday

    def _get_opening_hours(self, date_str):
        if date_str in self.special_days:
            sd = self.special_days[date_str]
            return sd.get("start", self.op_limit), sd.get("end", self.cl_limit)
        t = self._get_day_type(date_str)
        if t == "closed":
            return self.op_limit, self.op_limit
        key = {"holiday": "holiday", "weekend": "weekend"}.get(t, "weekday")
        ot = self.opening_times.get(key, {})
        return ot.get("start", self.op_limit), ot.get("end", self.cl_limit)

    def _get_break_minutes(self, hours):
        """労基法準拠の休憩時間算出 (>=で判定)

        労基法34条:
        - 労働時間が6時間を超える場合: 少なくとも45分
        - 労働時間が8時間を超える場合: 少なくとも60分
        """
        brk = 0
        for rule in sorted(self.break_rules, key=lambda r: r.get("min_hours", 0)):
            # >= に修正: 6時間ちょうどでも休憩必須 (労基法は「超える」だが安全側に)
            if hours >= rule.get("min_hours", 0):
                brk = rule.get("break_minutes", 0)
        return brk

    def _compute_staff_ng_dates(self, staff):
        """スタッフのNG日を計算 (unavailable_dates + 承認済み休暇)"""
        raw = staff.get("unavailable_dates")
        ng = set()
        if raw:
            if isinstance(raw, list):
                ng = {str(d).strip() for d in raw if str(d).strip()}
            else:
                ng = {str(d).strip() for d in str(raw).split(",") if str(d).strip()}
        for req in self.requests:
            if (req.get("staff_id") == staff["id"]
                    and req.get("type") in ("off", "holiday")
                    and req.get("status") == "approved"):
                rd = req.get("dates", [])
                if isinstance(rd, list):
                    for single_date in rd:
                        single_date = str(single_date).strip()
                        if single_date:
                            ng.add(single_date)
                else:
                    for single_date in str(rd).split(","):
                        single_date = single_date.strip()
                        if single_date:
                            ng.add(single_date)
        return ng

    def _get_staff_ng_dates(self, staff):
        """キャッシュからNG日を取得"""
        return self._ng_cache.get(staff["id"], set())

    def _get_work_requests(self):
        """承認済み出勤希望を取得 -> 固定シフトとして扱う"""
        work_reqs = []
        for req in self.requests:
            if (req.get("type") == "work"
                    and req.get("status") == "approved"):
                rd = req.get("dates", [])
                dates_list = []
                if isinstance(rd, list):
                    dates_list = [str(d).strip() for d in rd if str(d).strip()]
                else:
                    dates_list = [str(d).strip() for d in str(rd).split(",") if str(d).strip()]
                
                for single_date in dates_list:
                        work_reqs.append({
                            "staff_id": req.get("staff_id"),
                            "date": single_date,
                            "start_time": req.get("start_time"),
                            "end_time": req.get("end_time"),
                        })
        return work_reqs

    def _group_dates_by_week(self):
        """日付リストをISO週単位でグループ化"""
        if not self.dates:
            return []
        weeks, cur = [], []
        for d in self.dates:
            dt = datetime.strptime(d, "%Y-%m-%d")
            if not cur:
                cur.append(d)
            else:
                prev = datetime.strptime(cur[-1], "%Y-%m-%d")
                if dt.isocalendar()[1] == prev.isocalendar()[1] and dt.year == prev.year:
                    cur.append(d)
                else:
                    weeks.append(cur)
                    cur = [d]
        if cur:
            weeks.append(cur)
        return weeks

    def _build_shift_options(self, staff, date_str, force=False):
        """スタッフが指定日に入れるシフトパターンの候補を構築"""
        day_open, day_close = self._get_opening_hours(date_str)
        open_min = self._to_minutes(day_open)
        close_min = self._normalize_end_time(open_min, self._to_minutes(day_close))

        max_hours = float(staff.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
        if not force and max_hours <= 0:
            return []
        if force and max_hours <= 0:
            max_hours = self.LEGAL_MAX_HOURS_DAY

        options = []
        seen = set()
        
        patterns_to_use = self.shift_patterns.copy()
        
        is_employee = staff.get("salary_type") == "monthly" or staff.get("role") in ["manager", "sub_manager", "employee"]
        day_type = self._get_day_type(date_str)
        pref_start = staff.get("pref_start_we") if day_type in ("weekend", "holiday") else staff.get("pref_start_wd")
        pref_end = staff.get("pref_end_we") if day_type in ("weekend", "holiday") else staff.get("pref_end_wd")
        # フォールバック (古いprefStart用)
        pref_start = pref_start or staff.get("pref_start")
        pref_end = pref_end or staff.get("pref_end")
        
        if pref_start and pref_end:
            pref_pat = {"start": pref_start, "end": pref_end, "name": "pref"}
            if is_employee:
                # 社員はフルタイム候補に加えて、希望時間帯の候補も追加（ソフト制約として評価）
                patterns_to_use.append(pref_pat)
            else:
                # バイトは希望時間帯のみ
                patterns_to_use = [pref_pat]

        def _add_option(ps, pe, is_pref=False):
            """オプションを追加するヘルパー（重複チェック含む）"""
            if ps >= pe:
                return
            hrs = (pe - ps) / 60.0
            if hrs < 1:
                return
            brk_mins = self._get_break_minutes(hrs)
            work_hrs = hrs - (brk_mins / 60.0)
            key = (ps, pe)
            if key in seen:
                # 既に存在するオプションだが、もしこれがprefならフラグを立て直す
                if is_pref:
                    for opt in options:
                        if opt["start_min"] == ps and opt["end_min"] == pe:
                            opt["is_pref"] = True
                return
            seen.add(key)
            options.append({
                "start": self._from_minutes(ps),
                "end": self._from_minutes(pe),
                "start_min": ps, "end_min": pe, "hours": hrs, "work_hours": work_hrs,
                "is_pref": is_pref
            })

        for pat in patterns_to_use:
            raw_ps = self._to_minutes(pat["start"])
            raw_pe = self._normalize_end_time(raw_ps, self._to_minutes(pat["end"]))
            ps = max(raw_ps, open_min)
            pe = min(raw_pe, close_min)
            if ps >= pe:
                continue

            # --- 回避策: スタッフの最大労働時間に合わせて終了時間を自動短縮 ---
            hrs = (pe - ps) / 60.0
            brk_mins = self._get_break_minutes(hrs)
            work_hrs = hrs - (brk_mins / 60.0)

            is_pref = pat.get("name") == "pref"
            if work_hrs > max_hours and not force:
                # パターンA: 開始固定で終了を短縮（従来通り）
                needed_break = self._get_break_minutes(max_hours)
                allowed_total_hours = max_hours + (needed_break / 60.0)
                new_pe = ps + int(allowed_total_hours * 60)
                if new_pe < pe:
                    _add_option(ps, new_pe, is_pref)

                # パターンB: 終了固定で開始を遅くする（閉店時間カバー用）
                new_ps = pe - int(allowed_total_hours * 60)
                if new_ps > ps:
                    new_ps = max(new_ps, open_min)
                    _add_option(new_ps, pe, is_pref)
            else:
                _add_option(ps, pe, is_pref)
            # -------------------------------------------------------------------

        return options

    def _build_slot_requirements(self, date_str):
        """15分スロットごとの必要人数マップを構築"""
        req_num = self._get_required_staff(date_str)
        if req_num <= 0:
            return {}
        day_open, day_close = self._get_opening_hours(date_str)
        op = self._to_minutes(day_open)
        cl = self._normalize_end_time(op, self._to_minutes(day_close))
        slots = {}
        for t in range(op, cl, 15):
            slots[t] = {"base": req_num, "hall": 0, "kitchen": 0, "any": 0}

        dt = datetime.strptime(date_str, "%Y-%m-%d")
        js_dow = (dt.weekday() + 1) % 7
        for rule in self.time_staff_req:
            rule_days = [int(d) for d in rule.get("days", [])]
            if js_dow not in rule_days:
                continue
            rs = self._to_minutes(rule.get("start", "00:00"))
            re_min = self._normalize_end_time(rs, self._to_minutes(rule.get("end", "24:00")))
            rc = int(rule.get("count", 0))
            pos = rule.get("position", "any")
            
            for t in range(op, cl, 15):
                in_range = (rs <= t < re_min) if rs <= re_min else (t >= rs or t < re_min)
                if in_range and t in slots:
                    if pos == "hall":
                        slots[t]["hall"] = max(slots[t]["hall"], rc)
                    elif pos == "kitchen":
                        slots[t]["kitchen"] = max(slots[t]["kitchen"], rc)
                    else:
                        slots[t]["any"] = max(slots[t]["any"], rc)
                        
        final_slots = {}
        for t, counts in slots.items():
            final_slots[t] = max(counts["base"], counts["any"] + counts["hall"] + counts["kitchen"])
        return final_slots

    def _build_pos_requirements(self, date_str):
        """ポジション別の必要人数マップを構築"""
        req_num = self._get_required_staff(date_str)
        if req_num <= 0:
            return {}
        day_open, day_close = self._get_opening_hours(date_str)
        op = self._to_minutes(day_open)
        cl = self._normalize_end_time(op, self._to_minutes(day_close))
        pos_reqs = {}
        for t in range(op, cl, 15):
            pos_reqs[t] = {"hall": 0, "kitchen": 0}

        dt = datetime.strptime(date_str, "%Y-%m-%d")
        js_dow = (dt.weekday() + 1) % 7
        for rule in self.time_staff_req:
            pos = rule.get("position", "any")
            if pos not in ("hall", "kitchen"):
                continue
            rule_days = [int(d) for d in rule.get("days", [])]
            if js_dow not in rule_days:
                continue
            rs = self._to_minutes(rule.get("start", "00:00"))
            re_min = self._normalize_end_time(rs, self._to_minutes(rule.get("end", "24:00")))
            rc = int(rule.get("count", 0))
            for t in range(op, cl, 15):
                in_range = (rs <= t < re_min) if rs <= re_min else (t >= rs or t < re_min)
                if in_range and t in pos_reqs:
                    pos_reqs[t][pos] = max(pos_reqs[t][pos], rc)
        return pos_reqs

    # ===========================================================
    # 事前チェック
    # ===========================================================

    def pre_check(self):
        warnings = []
        daily_details = []
        total_shortage = 0.0

        usable = [s for s in self.staff_list
                   if int(s.get("max_days_week") or 5) > 0]
        unusable = [s for s in self.staff_list
                    if int(s.get("max_days_week") or 5) <= 0]

        if unusable:
            names = [s.get("name", s["id"]) for s in unusable]
            warnings.append({
                "type": "unusable_staff",
                "message": "{}名が出勤不可(max_days=0): {}".format(
                    len(names), ", ".join(names)),
                "severity": "info",
            })

        # 管理者不足チェック
        manager_count = len(self._manager_ids)
        if manager_count < self.min_manager:
            warnings.append({
                "type": "manager_shortage",
                "message": "管理者が{}名必要ですが{}名しかいません".format(
                    self.min_manager, manager_count),
                "severity": "critical",
            })

        for d in self.dates:
            if self._get_day_type(d) == "closed":
                continue
            slot_reqs = self._build_slot_requirements(d)
            if not slot_reqs:
                continue
            available = [s for s in usable
                         if d not in self._get_staff_ng_dates(s)]
            shortage_slots = {}
            for slot_min, req in slot_reqs.items():
                cover = 0
                for s in available:
                    for opt in self._build_shift_options(s, d):
                        if opt["start_min"] <= slot_min < opt["end_min"]:
                            cover += 1
                            break
                gap = req - cover
                if gap > 0:
                    shortage_slots[slot_min] = gap

            if shortage_slots:
                ranges = self._compress_ranges(shortage_slots)
                hrs = sum(v * 0.25 for v in shortage_slots.values())
                total_shortage += hrs
                daily_details.append({
                    "date": d,
                    "day_type": self._get_day_type(d),
                    "available_staff": len(available),
                    "required_per_slot": self._get_required_staff(d),
                    "shortage_ranges": ranges,
                    "shortage_hours": round(hrs, 1),
                })

        if total_shortage > 0:
            warnings.append({
                "type": "staff_shortage",
                "message": "合計 {:.1f} 人時の人員不足".format(total_shortage),
                "severity": "critical",
                "total_shortage_hours": round(total_shortage, 1),
                "affected_days": len(daily_details),
            })

        return {
            "feasible": total_shortage == 0,
            "warnings": warnings,
            "daily_details": daily_details,
            "summary": {
                "total_staff": len(self.staff_list),
                "usable_staff": len(usable),
                "total_dates": len(self.dates),
                "work_dates": len([d for d in self.dates
                                   if self._get_day_type(d) != "closed"]),
                "total_shortage_hours": round(total_shortage, 1),
                "affected_days": len(daily_details),
            },
        }

    def _compress_ranges(self, slots):
        ranges = []
        start = short = prev = None
        for t in sorted(slots):
            v = slots[t]
            if start is None:
                start, short = t, v
            elif t == prev + 15 and v == short:
                pass
            else:
                ranges.append({"start": self._from_minutes(start),
                               "end": self._from_minutes(prev + 15),
                               "shortage": short})
                start, short = t, v
            prev = t
        if start is not None:
            ranges.append({"start": self._from_minutes(start),
                           "end": self._from_minutes(prev + 15),
                           "shortage": short})
        return ranges

    # ===========================================================
    # メイン解法: 3段階フォールバック + グリーディ
    # ===========================================================

    def solve(self, force=False):
        result = self._solve_milp(force=force, tier=3)
        if result:
            logger.info("[Solve] Tier 3 (full) succeeded")
            return result

        logger.info("[Fallback] Relaxing Tier 3...")
        result = self._solve_milp(force=force, tier=2)
        if result:
            logger.info("[Solve] Tier 2 (no OJT/balance) succeeded")
            return result

        logger.info("[Fallback] Relaxing to Tier 1 + force...")
        result = self._solve_milp(force=True, tier=1)
        if result:
            logger.info("[Solve] Tier 1 (legal only) succeeded")
            return result

        logger.info("[Fallback] Greedy...")
        return self._solve_greedy()

    def _solve_milp(self, force=False, tier=3):
        try:
            # スロット要件キャッシュをクリア（Tier間フォールバック時のリーク防止）
            self._slot_reqs_cache = {}

            prob = pulp.LpProblem("RakuShift_v3", pulp.LpMinimize)
            penalty = pulp.LpAffineExpression()

            x = {}
            staff_opts = {}

            for s in self.staff_list:
                sid = s["id"]
                ng = self._get_staff_ng_dates(s)
                for d in self.dates:
                    if d in ng or self._get_day_type(d) == "closed":
                        staff_opts[(sid, d)] = []
                        continue
                    opts = self._build_shift_options(s, d, force=force)
                    staff_opts[(sid, d)] = opts
                    for oi in range(len(opts)):
                        x[(sid, d, oi)] = pulp.LpVariable(
                            "x_{}_{}_{}" .format(sid, d, oi),
                            0, 1, pulp.LpBinary)

            # ========== 承認済み出勤希望を固定シフトとして反映 ==========

            work_requests = self._get_work_requests()
            fixed_assignments = set()
            for wr in work_requests:
                wsid = wr["staff_id"]
                wd = wr["date"]
                if wd not in self.dates:
                    continue
                opts = staff_opts.get((wsid, wd), [])
                if not opts:
                    continue
                best_oi = 0
                if wr.get("start_time") and wr.get("end_time"):
                    wr_start = self._to_minutes(wr["start_time"])
                    wr_end = self._normalize_end_time(wr_start, self._to_minutes(wr["end_time"]))
                    best_diff = float("inf")
                    for oi, opt in enumerate(opts):
                        diff = abs(opt["start_min"] - wr_start) + abs(opt["end_min"] - wr_end)
                        if diff < best_diff:
                            best_diff = diff
                            best_oi = oi
                if (wsid, wd, best_oi) in x:
                    prob += x[(wsid, wd, best_oi)] == 1
                    fixed_assignments.add((wsid, wd))
                    logger.info("[WorkReq] Fixed: staff={} date={}".format(wsid, wd))

            logger.info("[Requests] {} work requests applied".format(len(work_requests)))

            # 配置理由トラッキング (sid, d) → 簡潔な日本語ラベル
            assignment_reasons = {}
            for wr in work_requests:
                wsid, wd = wr.get("staff_id"), wr.get("date")
                if (wsid, wd) in fixed_assignments:
                    assignment_reasons[(wsid, wd)] = "承認済み出勤希望"

            # ========== 既存シフトを固定 (empty_only モードで空きだけ埋める) ==========
            existing_fixed = 0
            for es in self.existing_shifts:
                esid = es["staff_id"]
                ed = es["date"]
                if ed not in self.dates:
                    continue
                if (esid, ed) in fixed_assignments:
                    continue
                opts = staff_opts.get((esid, ed), [])
                if not opts:
                    continue
                es_start = self._to_minutes(es["start_time"])
                es_end = self._normalize_end_time(es_start, self._to_minutes(es["end_time"]))
                best_oi = 0
                best_diff = float("inf")
                for oi, opt in enumerate(opts):
                    diff = abs(opt["start_min"] - es_start) + abs(opt["end_min"] - es_end)
                    if diff < best_diff:
                        best_diff = diff
                        best_oi = oi
                if (esid, ed, best_oi) in x:
                    prob += x[(esid, ed, best_oi)] == 1
                    fixed_assignments.add((esid, ed))
                    assignment_reasons[(esid, ed)] = "既存シフトを維持"
                    existing_fixed += 1
            logger.info("[Existing] {} existing shifts fixed (empty_only mode)".format(existing_fixed))

            # 希望シフト (pending) の (sid, d) → 希望時間帯を控える
            pref_index = {}  # (sid, d) -> {start, end}
            for req in self.requests:
                if req.get("type") == "work" and req.get("status") == "pending":
                    rsid = req.get("staff_id")
                    rd_list = req.get("dates", [])
                    if isinstance(rd_list, str):
                        rd_list = [d.strip() for d in rd_list.split(",") if d.strip()]
                    for rd in rd_list:
                        rd = str(rd).strip()
                        if rd in self.dates:
                            pref_index[(rsid, rd)] = {
                                "start": req.get("start_time"),
                                "end": req.get("end_time")
                            }

            # slack 変数の追跡 (validation_report 用)
            tracked_slacks = {
                "coverage_under": [],   # スロット人員不足
                "open_close_under": [], # 開け締め不在
                "manager_under": [],    # 管理者不足
                "ojt": [],              # OJT 不在
                "fairness": [],         # 公平性偏差
                "fatigue": [],          # 連続勤務疲労
                "peak_skill": [],       # ピーク帯スキル不足
            }
            self._tracked_slacks = tracked_slacks

            # ====================================================
            # TIER 1: 法的制約 (ハード制約)
            # ====================================================

            for s in self.staff_list:
                sid = s["id"]

                # --- 1日1シフト制約 ---
                for d in self.dates:
                    opts = staff_opts.get((sid, d), [])
                    if opts:
                        prob += pulp.lpSum(
                            x[(sid, d, oi)] for oi in range(len(opts))
                        ) <= 1

                    # --- 1日の最大労働時間 (労基法32条) ---
                    max_hours = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                    if not force:
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            if opt["work_hours"] > max_hours:
                                prob += x[(sid, d, oi)] == 0

                # --- 週の最大勤務日数 ---
                max_days = int(s.get("max_days_week") or 5)
                if not force and max_days <= 0:
                    for d in self.dates:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            prob += x[(sid, d, oi)] == 0
                    continue

                effective_max_days = max_days if not force else max(max_days, 6)
                week_groups = self._group_dates_by_week()
                for week in week_groups:
                    wv = []
                    for d in week:
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            wv.append(x[(sid, d, oi)])
                    if wv:
                        prob += pulp.lpSum(wv) <= effective_max_days

                # --- 週の最低出勤日数 (全週ハード制約: 絶対遵守) ---
                min_days_week = int(s.get("min_days_week") or 0)
                if not force and min_days_week > 0:
                    logger.info("[MinDays] Staff {} min_days_week={}".format(
                        s.get("name", sid), min_days_week))
                    for week in week_groups:
                        wv = []
                        available_days_in_week = 0
                        ng_set = self._get_staff_ng_dates(s)
                        for d in week:
                            if d not in ng_set and self._get_day_type(d) != "closed":
                                available_days_in_week += 1
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                wv.append(x[(sid, d, oi)])
                        if wv:
                            # max_days_weekとの矛盾を防ぐ
                            effective_min = min(min_days_week, available_days_in_week, max_days)
                            if effective_min > 0:
                                # 全週ハード制約（短い週も含めて絶対遵守）
                                prob += pulp.lpSum(wv) >= effective_min

                # --- 月(全体期間)の最低出勤日数 (ハード制約) ---
                min_days_month = int(s.get("min_days_month") or 0)
                if not force and min_days_month > 0 and self.dates:
                    target_min_month = min_days_month
                    ng_set = self._get_staff_ng_dates(s)
                    available_total = len([d for d in self.dates
                                          if d not in ng_set and self._get_day_type(d) != "closed"])
                    target_min_month = min(target_min_month, available_total)
                    max_possible = 0
                    mdw = int(s.get("max_days_week") or self.LEGAL_MAX_CONSECUTIVE_DAYS)
                    for week in week_groups:
                        max_possible += min(mdw, len(week))
                    target_min_month = min(target_min_month, max_possible)
                    if target_min_month > 0:
                        all_wv = []
                        for d in self.dates:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                all_wv.append(x[(sid, d, oi)])
                        if all_wv:
                            prob += pulp.lpSum(all_wv) >= target_min_month

                # --- 週40時間上限 (労基法32条) ---
                if not force:
                    for week in week_groups:
                        hours_expr = pulp.LpAffineExpression()
                        has_vars = False
                        for d in week:
                            for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                hours_expr += x[(sid, d, oi)] * opt["work_hours"]
                                has_vars = True
                        if has_vars:
                            prob += hours_expr <= self.LEGAL_MAX_HOURS_WEEK

                # --- 連続勤務6日上限 (労基法35条: 週1日の休日) ---
                sorted_d = sorted(self.dates)
                max_consec = self.LEGAL_MAX_CONSECUTIVE_DAYS if not force else 7
                if len(sorted_d) > max_consec:
                    for i in range(len(sorted_d) - max_consec):
                        span = sorted_d[i:i + max_consec + 1]
                        sv = []
                        for d in span:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                sv.append(x[(sid, d, oi)])
                        if sv:
                            prob += pulp.lpSum(sv) <= max_consec

                # --- 勤務間インターバル制約 (前日退勤→翌日出勤まで10時間以上) ---
                if not force:
                    for i in range(len(sorted_d) - 1):
                        d1 = sorted_d[i]
                        d2 = sorted_d[i+1]
                        opts1 = staff_opts.get((sid, d1), [])
                        opts2 = staff_opts.get((sid, d2), [])
                        if not opts1 or not opts2:
                            continue
                        for oi1, opt1 in enumerate(opts1):
                            for oi2, opt2 in enumerate(opts2):
                                interval = (opt2["start_min"] + 1440) - opt1["end_min"]
                                if interval < 600:
                                    prob += x[(sid, d1, oi1)] + x[(sid, d2, oi2)] <= 1

            # ====================================================
            # TIER 2: カバレッジ制約 (ソフト制約)
            # ====================================================

            if tier >= 2:
                # --- 1日の出勤人数: 必要人数±1に収束させる（ソフト制約） ---
                # 不足も過剰も許容するが、±1の範囲に強力に誘導する
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    req_daily = self._get_required_staff(d)
                    if req_daily <= 0:
                        continue
                    day_workers = []
                    for s in self.staff_list:
                        sid = s["id"]
                        opts = staff_opts.get((sid, d), [])
                        if opts:
                            day_workers.append(pulp.lpSum([x[(sid, d, oi)] for oi in range(len(opts))]))
                    if day_workers:
                        daily_sum = pulp.lpSum(day_workers)
                        # 下限: 必要人数以上を確保
                        daily_slack_under = pulp.LpVariable(
                            "daily_under_{}".format(d), 0, None, pulp.LpInteger)
                        prob += daily_sum + daily_slack_under >= req_daily
                        penalty += daily_slack_under * self.W.COVERAGE_UNDER
                        # 上限: 必要人数+1以内に抑える（±1制御の核心）
                        # ただしスロットレベルの要件が日次ベースより大きい場合は、
                        # スロット要件の最大値を基準にして矛盾を防ぐ
                        slot_reqs_for_day = self._build_slot_requirements(d)
                        # キャッシュしてスロットループでの再計算を防ぐ
                        if not hasattr(self, '_slot_reqs_cache'):
                            self._slot_reqs_cache = {}
                        self._slot_reqs_cache[d] = slot_reqs_for_day
                        max_slot_req = max(slot_reqs_for_day.values()) if slot_reqs_for_day else req_daily
                        daily_upper = max(req_daily, max_slot_req)  # ±0を目指す（旧: +1）
                        daily_slack_over = pulp.LpVariable(
                            "daily_over_{}".format(d), 0, None, pulp.LpInteger)
                        prob += daily_sum - daily_slack_over <= daily_upper
                        penalty += daily_slack_over * self.W.COVERAGE_OVER_DAY

                # --- 各時間スロットの人員: 必要人数±1に収束させる ---
                # ※_slot_reqs_cacheを利用して_build_slot_requirementsの二重呼び出しを回避
                for d in self.dates:
                    slot_reqs = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                    if slot_reqs is None:
                        slot_reqs = self._build_slot_requirements(d)
                    for slot_min, req in slot_reqs.items():
                        workers = []
                        for s in self.staff_list:
                            sid = s["id"]
                            for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                if opt["start_min"] <= slot_min < opt["end_min"]:
                                    workers.append(x[(sid, d, oi)])
                        if workers:
                            workers_sum = pulp.lpSum(workers)
                            # 全営業スロットで最低1名は必ず確保
                            if not force:
                                min1_slack = pulp.LpVariable(
                                    "min1_{}_{}".format(d, slot_min), 0, None, pulp.LpInteger)
                                prob += workers_sum + min1_slack >= 1
                                penalty += min1_slack * self.W.EMPTY_SLOT
                            slack_under = pulp.LpVariable(
                                "cov_{}_{}".format(d, slot_min), 0, None, pulp.LpInteger)
                            prob += workers_sum + slack_under >= req
                            penalty += slack_under * self.W.COVERAGE_UNDER
                            tracked_slacks["coverage_under"].append((d, slot_min, req, slack_under))
                            slack_over = pulp.LpVariable(
                                "over_{}_{}".format(d, slot_min), 0, None, pulp.LpInteger)
                            prob += workers_sum - slack_over <= req
                            penalty += slack_over * self.W.COVERAGE_OVER_SLOT

                # --- 管理者常駐制約 ---
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    slot_reqs = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                    if slot_reqs is None:
                        slot_reqs = self._build_slot_requirements(d)
                    if not slot_reqs:
                        continue
                    # 開け作業・締め作業を含む、全スロットでの社員（月給制・店長）常駐制約
                    employee_ids = self._monthly_ids.union(self._manager_ids)
                    first_slot = min(slot_reqs.keys())
                    last_slot = max(slot_reqs.keys())
                    
                    for slot_min in slot_reqs:
                        emp_vars = []
                        for eid in employee_ids:
                            for oi, opt in enumerate(staff_opts.get((eid, d), [])):
                                if opt["start_min"] <= slot_min < opt["end_min"]:
                                    emp_vars.append(x[(eid, d, oi)])
                        
                        if emp_vars:
                            if slot_min == first_slot or slot_min == last_slot:
                                slack = pulp.LpVariable("emp_openclose_{}_{}".format(d, slot_min), 0, None, pulp.LpInteger)
                                prob += pulp.lpSum(emp_vars) + slack >= 1
                                penalty += slack * self.W.OPEN_CLOSE_NO_EMP
                                tracked_slacks["open_close_under"].append((d, slot_min, slack))
                            else:
                                slack = pulp.LpVariable("emp_{}_{}".format(d, slot_min), 0, None, pulp.LpInteger)
                                prob += pulp.lpSum(emp_vars) + slack >= self.min_manager
                                penalty += slack * self.W.MIN_MANAGER
                                tracked_slacks["manager_under"].append((d, slot_min, self.min_manager, slack))

            # ====================================================
            # TIER 3: 品質最適化 (ソフト制約)
            # ====================================================

            if tier >= 3:
                # --- OJT制約: 新人にはメンター必須 ---
                if self._rookie_ids and self._mentor_ids:
                    for d in self.dates:
                        if self._get_day_type(d) == "closed":
                            continue
                        slot_reqs = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                        if slot_reqs is None:
                            slot_reqs = self._build_slot_requirements(d)
                        if not slot_reqs:
                            continue
                        for slot_min in slot_reqs:
                            rookie_vars = []
                            mentor_vars = []
                            for s in self.staff_list:
                                sid = s["id"]
                                for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                                    if opt["start_min"] <= slot_min < opt["end_min"]:
                                        if sid in self._rookie_ids:
                                            rookie_vars.append(x[(sid, d, oi)])
                                        if sid in self._mentor_ids:
                                            mentor_vars.append(x[(sid, d, oi)])
                            if rookie_vars and mentor_vars:
                                slack = pulp.LpVariable(
                                    "ojt_{}_{}".format(d, slot_min),
                                    0, None, pulp.LpInteger)
                                prob += pulp.lpSum(mentor_vars) + slack >= pulp.lpSum(rookie_vars)
                                penalty += slack * self.W.OJT_NO_MENTOR
                            elif rookie_vars and not mentor_vars:
                                # config.block_rookie_without_mentor=True なら新人配置を強制禁止
                                if self.config.get("block_rookie_without_mentor"):
                                    for rv in rookie_vars:
                                        prob += rv == 0
                                else:
                                    for rv in rookie_vars:
                                        penalty += rv * self.W.OJT_NO_MENTOR

                # --- 戦力バランス ---
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    slot_reqs = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                    if slot_reqs is None:
                        slot_reqs = self._build_slot_requirements(d)
                    if not slot_reqs:
                        continue
                    power_expr = pulp.LpAffineExpression()
                    for s in self.staff_list:
                        sid = s["id"]
                        rank = self._eval_rank.get(sid, "B")
                        pw = self.POWER_SCORE.get(rank, 2.0)
                        for oi in range(len(staff_opts.get((sid, d), []))):
                            power_expr += x[(sid, d, oi)] * pw
                    min_req = self._get_required_staff(d)
                    if min_req > 0:
                        slack = pulp.LpVariable("pw_{}".format(d), 0, None)
                        prob += power_expr + slack >= 1.5 * min_req
                        penalty += slack * self.W.POWER_BALANCE

                # --- 人件費と評価ランクによる最適化 (コスト最小化) ---
                for s in self.staff_list:
                    sid = s["id"]
                    rank = self._eval_rank.get(sid, "B")
                    # ランクペナルティ (Aは優遇、Dは後回し)
                    rank_penalty = {"A": 0, "B": 5, "C": 15, "D": 30}.get(rank, 10)
                    
                    hourly_wage = float(s.get("hourly_wage") or 1000)
                    is_monthly = str(s.get("salary_type", "hourly")).lower() == "monthly"

                    # 新機能：シフト優先度と契約区分による強力なスコア調整
                    shift_priority = str(s.get("shift_priority", "medium")).lower()
                    contract_type = str(s.get("contract_type", "general")).lower()
                    
                    priority_bonus = 0
                    if shift_priority == "high":
                        priority_bonus += self.W.PRIORITY_HIGH   # 負値
                    elif shift_priority == "low":
                        priority_bonus += self.W.PRIORITY_LOW

                    if contract_type == "regular":
                        priority_bonus += self.W.CONTRACT_REGULAR  # 負値
                    elif contract_type == "spot":
                        priority_bonus += self.W.CONTRACT_SPOT

                    # 決定論的タイブレーカー: スタッフ間で公平、かつ「同じ入力なら同じ結果」(ガチャ排除)
                    # random.uniform を廃止 → staff_id ハッシュベースの固定差分に置換。
                    # 全スタッフが PRIORITY_HIGH 等で同点になった場合の選別に微小バイアスを与え、
                    # 「リスト先頭が常に選ばれる」不公平を回避しつつ deterministic を保証する。
                    sid_hash = (abs(hash(sid)) % 10_000) / 1_000.0  # 0.0〜10.0 固定
                    for d in self.dates:
                        # 日付ごとにもオフセット (同じスタッフが常に同じ日に固まらないように deterministic 分散)
                        day_hash = (abs(hash(d + sid)) % 100) / 100.0  # 0.0〜1.0 固定
                        tiebreaker = sid_hash + day_hash
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            work_hours = opt["work_hours"]
                            labor_cost = 0.0 if is_monthly else (hourly_wage * work_hours)
                            total_cost = (labor_cost * 0.01) + rank_penalty + priority_bonus + tiebreaker
                            penalty += x[(sid, d, oi)] * total_cost

                # --- 勤務日数の公平性と離職防止 (需要ベースの按分方式) ---
                # 店舗全体の需要人日数からスタッフごとの配分比率を計算し、±1で収束させる
                active_staff = [s for s in self.staff_list if int(s.get("max_days_week") or 5) > 0]
                if len(active_staff) >= 2:
                    total_vars = {}
                    for s in active_staff:
                        sid = s["id"]
                        total_vars[sid] = pulp.lpSum(
                            x[(sid, d, oi)]
                            for d in self.dates
                            for oi in range(len(staff_opts.get((sid, d), [])))
                        )
                    work_days_count = len([d for d in self.dates
                                          if self._get_day_type(d) != "closed"])
                    weeks_in_period = max(work_days_count / 7.0, 1.0)

                    # 需要ベースの目標計算: 全体の必要人日数を算出
                    total_demand_days = sum(
                        self._get_required_staff(d)
                        for d in self.dates
                        if self._get_day_type(d) != "closed"
                    )
                    # 全スタッフのmax_days_week合計を月間ベースに換算（按分の分母）
                    total_capacity_per_week = sum(
                        int(s.get("max_days_week") or 5) for s in active_staff
                    )
                    total_capacity_monthly = total_capacity_per_week * weeks_in_period

                    for s in active_staff:
                        sid = s["id"]
                        tv = total_vars[sid]
                        staff_max_days = int(s.get("max_days_week") or 5)
                        ng_count = len([d for d in self.dates
                                        if d in self._get_staff_ng_dates(s)
                                        or self._get_day_type(d) == "closed"])
                        available_days = len(self.dates) - ng_count

                        # 需要ベース目標: 全体需要 × (個人月間キャパ / 全体月間キャパ)
                        staff_monthly_capacity = staff_max_days * weeks_in_period
                        if total_capacity_monthly > 0:
                            demand_ratio = staff_monthly_capacity / total_capacity_monthly
                            staff_target = total_demand_days * demand_ratio
                        else:
                            staff_target = staff_max_days * weeks_in_period * 0.7

                        # 上限はmax_days_week×週数と出勤可能日数の小さい方
                        upper_limit = min(staff_max_days * weeks_in_period, available_days)
                        staff_target = min(staff_target, upper_limit)
                        staff_target = max(staff_target, 1.0)  # 最低1日は保証

                        slack_over = pulp.LpVariable("fair_over_{}".format(sid), 0, None)
                        slack_under = pulp.LpVariable("fair_under_{}".format(sid), 0, None)
                        prob += tv - staff_target <= slack_over
                        prob += staff_target - tv <= slack_under
                        penalty += (slack_over + slack_under) * self.W.FAIRNESS_DRIFT

                    logger.info("[Tier3] Fairness: demand={} days, {} staff, capacity/wk={}".format(
                        total_demand_days, len(active_staff), total_capacity_per_week))

                    # === 店舗運営者視点：離職防止アルゴリズム（ゼロシフト絶対回避） ===
                    # 全員に最低限のシフト（週1回程度）を保証する
                    for s in active_staff:
                        sid = s["id"]
                        tv = total_vars[sid]
                        # 期間中に出勤可能な日数をカウント
                        submitted_days = len([d for d in self.dates if staff_opts.get((sid, d))])
                        if submitted_days > 0:
                            # 最低保証シフト数: 安全な範囲で週1日程度を保証
                            staff_max_days = int(s.get("max_days_week") or 5)
                            min_dw = int(s.get("min_days_week") or 0)
                            # 週1日 × 週数を候補に、出勤可能日数・max_days上限・min_days_weekとの整合を確保
                            weekly_guarantee = min(1, staff_max_days)
                            candidate = int(weekly_guarantee * weeks_in_period)
                            # Infeasible防止: submitted_days, max_days上限, min_days_weekのいずれかで安全に抑える
                            guarantee_shifts = min(
                                candidate,
                                submitted_days,
                                int(staff_max_days * weeks_in_period)
                            )
                            # min_days_weekが設定されている場合はそちらのハード制約と矛盾しないよう調整
                            if min_dw > 0:
                                # min_days_weekのハード制約が既にあるので、保証はその範囲内に
                                min_dw_total = min(int(min_dw * weeks_in_period), submitted_days)
                                guarantee_shifts = min(guarantee_shifts, min_dw_total)
                            guarantee_shifts = max(guarantee_shifts, 1)  # 絶対最低1日
                            prob += tv >= guarantee_shifts
                # --- min_days_week > 0 のスタッフへの配置ボーナス ---
                # min_days_weekのハード制約で確保済みなので、ボーナスは補助的に軽めに
                for s in self.staff_list:
                    sid = s["id"]
                    min_dw = int(s.get("min_days_week") or 0)
                    if min_dw > 0:
                        for d in self.dates:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                penalty += x[(sid, d, oi)] * self.W.MIN_DAYS_WEEK_BONUS

                # --- ピーク時スキルミックス制約 ---
                # ピーク時間帯（ランチ帯等）に最低1名のA/B評価スタッフを確保する
                peak_rules = self.config.get("peak_skill_rules", [])
                if not peak_rules:
                    # デフォルト: 11:00-14:00にB以上を1名確保
                    peak_rules = [
                        {"start": "11:00", "end": "14:00", "min_rank": "B", "count": 1},
                    ]
                
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    for rule in peak_rules:
                        rs = self._to_minutes(rule.get("start", "11:00"))
                        re_peak = self._to_minutes(rule.get("end", "14:00"))
                        min_rank = rule.get("min_rank", "B")
                        min_rank_score = self.POWER_SCORE.get(min_rank, 2.0)
                        req_count = int(rule.get("count", 1))
                        
                        # ピーク全スロットをカバーできるスタッフの変数を集める
                        qualified = []
                        for s in self.staff_list:
                            sid_q = s["id"]
                            rank = self._eval_rank.get(sid_q, "B")
                            if self.POWER_SCORE.get(rank, 0) >= min_rank_score:
                                for oi, opt in enumerate(staff_opts.get((sid_q, d), [])):
                                    # ピーク帯の開始をカバーしていればOK
                                    if opt["start_min"] <= rs and opt["end_min"] >= re_peak:
                                        qualified.append(x[(sid_q, d, oi)])
                                    elif opt["start_min"] <= rs and opt["end_min"] > rs:
                                        # 部分カバーでも加点
                                        qualified.append(x[(sid_q, d, oi)])
                        
                        if qualified:
                            slack = pulp.LpVariable(
                                "peak_{}_{}".format(d, rs), 0, None, pulp.LpInteger)
                            prob += pulp.lpSum(qualified) + slack >= req_count
                            penalty += slack * self.W.PEAK_SKILL

                logger.info("[Tier3] Peak skill mix constraints applied ({} rules)".format(len(peak_rules)))

                # --- 希望シフト充足率の最大化 (従業員満足度スコア) ---
                # 未承認（pending）の出勤希望に対してボーナス（負のペナルティ）を付与し、
                # AIが可能な限り従業員の希望を叶えるように誘導する
                preference_count = 0
                for req in self.requests:
                    if req.get("type") == "work" and req.get("status") == "pending":
                        rsid = req.get("staff_id")
                        rd_list = req.get("dates", [])
                        if isinstance(rd_list, str):
                            rd_list = [d.strip() for d in rd_list.split(",") if d.strip()]
                        for rd in rd_list:
                            rd = str(rd).strip()
                            if rd not in self.dates:
                                continue
                            opts_r = staff_opts.get((rsid, rd), [])
                            if not opts_r:
                                continue
                            
                            # 希望時間帯に最も近いパターンを優遇
                            req_start = req.get("start_time")
                            req_end = req.get("end_time")
                            
                            for oi, opt in enumerate(opts_r):
                                bonus = self.W.PREFERENCE_BASE
                                if req_start and req_end:
                                    rs_m = self._to_minutes(req_start)
                                    re_m = self._to_minutes(req_end)
                                    diff = abs(opt["start_min"] - rs_m) + abs(opt["end_min"] - re_m)
                                    if diff == 0:
                                        bonus = self.W.PREFERENCE_EXACT
                                    elif diff <= 60:
                                        bonus = self.W.PREFERENCE_CLOSE
                                penalty += x[(rsid, rd, oi)] * bonus
                                preference_count += 1

                logger.info("[Tier3] Preference fulfillment: {} shift preferences processed".format(preference_count))

                # --- 時間帯分散制約 (朝/昼/夕の3区分でバランス) ---
                # 朝: 開始 < 11:00 / 昼: 11:00 <= 開始 < 16:00 / 夕: 開始 >= 16:00
                # 旧2区分 (14時境界) より細かく、変数は1スタッフ1差分のみで負荷低
                BAND_MORNING_END = 11 * 60
                BAND_AFTERNOON_END = 16 * 60
                for s in self.staff_list:
                    sid = s["id"]
                    max_days = int(s.get("max_days_week") or 5)
                    if max_days <= 1:
                        continue
                    bands = {"m": [], "a": [], "e": []}
                    for d in self.dates:
                        if self._get_day_type(d) == "closed":
                            continue
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            sm = opt["start_min"]
                            if sm < BAND_MORNING_END:
                                bands["m"].append(x[(sid, d, oi)])
                            elif sm < BAND_AFTERNOON_END:
                                bands["a"].append(x[(sid, d, oi)])
                            else:
                                bands["e"].append(x[(sid, d, oi)])
                    sums = {k: pulp.lpSum(v) for k, v in bands.items() if v}
                    if len(sums) >= 2:
                        # 最大バンドと最小バンドの差をペナルティ化
                        imbalance = pulp.LpVariable("imbal_{}".format(sid), 0, None)
                        keys = list(sums.keys())
                        for i in range(len(keys)):
                            for j in range(i+1, len(keys)):
                                prob += sums[keys[i]] - sums[keys[j]] <= imbalance
                                prob += sums[keys[j]] - sums[keys[i]] <= imbalance
                        penalty += imbalance * self.W.TIMEBAND_IMBALANCE

                # --- 連続勤務後の疲労インセンティブ (5日連続後の翌日は休み優先) ---
                sorted_d_fatigue = sorted(self.dates)
                if len(sorted_d_fatigue) >= 6:
                    for s in self.staff_list:
                        sid = s["id"]
                        for i in range(len(sorted_d_fatigue) - 5):
                            window5 = sorted_d_fatigue[i:i+5]
                            next_day = sorted_d_fatigue[i+5]
                            w5_vars = [x[(sid, d, oi)]
                                       for d in window5
                                       for oi in range(len(staff_opts.get((sid, d), [])))]
                            next_vars = [x[(sid, next_day, oi)]
                                         for oi in range(len(staff_opts.get((sid, next_day), [])))]
                            if not w5_vars or not next_vars:
                                continue
                            # 5日連続出勤 (w5_sum=5) のとき翌日出勤するとペナルティ
                            fatigue_slack = pulp.LpVariable(
                                "fatigue_{}_{}".format(sid, next_day), 0, None)
                            prob += pulp.lpSum(w5_vars) + pulp.lpSum(next_vars) - 5 <= fatigue_slack
                            penalty += fatigue_slack * self.W.CONSEC_DAYS_FATIGUE

                # --- メンター主担当マッチング (preferred_mentor がある新人を主担当と同シフトに) ---
                if self._rookie_ids:
                    for s in self.staff_list:
                        sid = s["id"]
                        if sid not in self._rookie_ids:
                            continue
                        pref_mentor_id = s.get("preferred_mentor")
                        if not pref_mentor_id or pref_mentor_id not in self._staff_map:
                            continue
                        for d in self.dates:
                            if self._get_day_type(d) == "closed":
                                continue
                            rookie_d = [x[(sid, d, oi)]
                                        for oi in range(len(staff_opts.get((sid, d), [])))]
                            mentor_d = [x[(pref_mentor_id, d, oi)]
                                        for oi in range(len(staff_opts.get((pref_mentor_id, d), [])))]
                            if rookie_d and mentor_d:
                                # 新人が出勤するときに主担当も出勤しているとボーナス
                                # ペアリングインジケータ: pair <= rookie_sum, pair <= mentor_sum
                                pair_ind = pulp.LpVariable(
                                    "pair_{}_{}".format(sid, d), 0, 1, pulp.LpBinary)
                                prob += pair_ind <= pulp.lpSum(rookie_d)
                                prob += pair_ind <= pulp.lpSum(mentor_d)
                                penalty += pair_ind * self.W.MENTOR_MATCH_BONUS

                # --- 土日ローテーション公平性制約 ---
                # 全スタッフが公平に土日シフトを担当するよう制約
                weekend_dates = [d for d in self.dates
                                 if self._get_day_type(d) in ("weekend", "holiday")]
                if weekend_dates and len(self.staff_list) >= 2:
                    weekend_vars = {}
                    for s in self.staff_list:
                        sid = s["id"]
                        max_days = int(s.get("max_days_week") or 5)
                        if max_days <= 0:
                            continue
                        wvars = []
                        for d in weekend_dates:
                            for oi in range(len(staff_opts.get((sid, d), []))):
                                wvars.append(x[(sid, d, oi)])
                        if wvars:
                            weekend_vars[sid] = pulp.lpSum(wvars)

                    if len(weekend_vars) >= 2:
                        # 土日出勤回数の平均を計算し、各スタッフの乖離にペナルティ
                        avg_weekends = len(weekend_dates) * self._get_required_staff(
                            weekend_dates[0]) / max(len(weekend_vars), 1)
                        for sid, wsum in weekend_vars.items():
                            s = self._staff_map.get(sid, {})
                            max_days = int(s.get("max_days_week") or 5)
                            # スタッフの能力に応じた土日目標
                            target = min(avg_weekends, len(weekend_dates) * max_days / 7.0)
                            target = max(target, 1.0)  # 最低1回は土日出勤
                            wk_slack = pulp.LpVariable("wkend_{}".format(sid), 0, None)
                            prob += wsum - target <= wk_slack
                            prob += target - wsum <= wk_slack
                            weight = self.W.WEEKEND_FAIR if sid in self._monthly_ids else (self.W.WEEKEND_FAIR // 2)
                            penalty += wk_slack * weight

                logger.info("[Tier3] Time slot diversity + weekend rotation applied")

            # ====================================================
            # 目的関数: コスト最小化
            # ====================================================

            # 月給スタッフは出勤させないとペナルティ (固定費なので働かせた方が得)
            for sid in self._monthly_ids:
                for d in self.dates:
                    if self._get_day_type(d) == "closed":
                        continue
                    opts = staff_opts.get((sid, d), [])
                    if opts:
                        not_working = 1 - pulp.lpSum(
                            x[(sid, d, oi)] for oi in range(len(opts)))
                        penalty += not_working * 30000

            # 時給スタッフのコスト
            for s in self.staff_list:
                if str(s.get("salary_type", "hourly")).lower() != "hourly":
                    continue
                wage = float(s.get("hourly_wage", 1100))
                sid = s["id"]
                for d in self.dates:
                    for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                        penalty += x[(sid, d, oi)] * wage * opt["hours"] * 0.01

            # 強行モード時: 超過時間へのペナルティ
            if force:
                for s in self.staff_list:
                    mh = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                    sid = s["id"]
                    for d in self.dates:
                        for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                            if opt["work_hours"] > mh:
                                penalty += x[(sid, d, oi)] * (opt["work_hours"] - mh) * 50000

            # 社員（店長・副店長・社員など）のシフト希望ソフト制約
            # 人員不足時は無視されるが、人が足りている時は本人の希望時間帯を優先する
            employee_ids = self._monthly_ids.union(self._manager_ids)
            for eid in employee_ids:
                for d in self.dates:
                    opts = staff_opts.get((eid, d), [])
                    has_pref = any(opt.get("is_pref") for opt in opts)
                    if has_pref:
                        for oi, opt in enumerate(opts):
                            if not opt.get("is_pref"):
                                # 10000のペナルティ。不足ペナルティ(500000)よりはるかに小さいが、通常パターンのコストより高い
                                penalty += x[(eid, d, oi)] * 10000

            # 人間関係（相性）制約: NGペア
            # slot_reqs のキー（実際のスロット分単位）でイテレーションする
            for (sid1, sid2) in getattr(self, '_ng_pair_constraints', []):
                for d in self.dates:
                    slot_reqs_ng = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                    if slot_reqs_ng is None:
                        slot_reqs_ng = self._build_slot_requirements(d)
                    if not slot_reqs_ng:
                        continue
                    for slot_min in slot_reqs_ng:
                        sid1_w = pulp.lpSum(x[(sid1, d, oi)] for oi, opt in enumerate(staff_opts.get((sid1, d), [])) if opt["start_min"] <= slot_min < opt["end_min"])
                        sid2_w = pulp.lpSum(x[(sid2, d, oi)] for oi, opt in enumerate(staff_opts.get((sid2, d), [])) if opt["start_min"] <= slot_min < opt["end_min"])
                        overlap = pulp.LpVariable("NG_overlap_{}_{}_{}_{}".format(sid1[:8], sid2[:8], d, slot_min), lowBound=0)
                        prob += (overlap >= sid1_w + sid2_w - 1)
                        penalty += overlap * 100000

            # 人間関係（相性）制約: 必須ペア
            for (sid1, sid2) in getattr(self, '_req_pair_constraints', []):
                for d in self.dates:
                    slot_reqs_rp = self._slot_reqs_cache.get(d) if hasattr(self, '_slot_reqs_cache') else None
                    if slot_reqs_rp is None:
                        slot_reqs_rp = self._build_slot_requirements(d)
                    if not slot_reqs_rp:
                        continue
                    for slot_min in slot_reqs_rp:
                        sid1_w = pulp.lpSum(x[(sid1, d, oi)] for oi, opt in enumerate(staff_opts.get((sid1, d), [])) if opt["start_min"] <= slot_min < opt["end_min"])
                        sid2_w = pulp.lpSum(x[(sid2, d, oi)] for oi, opt in enumerate(staff_opts.get((sid2, d), [])) if opt["start_min"] <= slot_min < opt["end_min"])
                        shortage = pulp.LpVariable("REQ_shortage_{}_{}_{}_{}".format(sid1[:8], sid2[:8], d, slot_min), lowBound=0)
                        prob += (shortage >= sid1_w - sid2_w)
                        penalty += shortage * 100000

            # ポジション別の必要人数確保（ソフト制約）
            for d in self.dates:
                pos_reqs = self._build_pos_requirements(d)
                for slot_min_pos, reqs in pos_reqs.items():
                    for pos, req_num in reqs.items():
                        if req_num > 0:
                            pos_staff = []
                            for s in self.staff_list:
                                if s["id"] not in [sid2[0] for sid2 in staff_opts.keys() if sid2[1] == d]:
                                    continue
                                sp = s.get("position", "any")
                                if sp in ("any", pos):
                                    pos_staff.append(s["id"])
                            working_pos = pulp.lpSum(
                                x[(sid, d, oi)]
                                for sid in pos_staff
                                for oi, opt in enumerate(staff_opts.get((sid, d), []))
                                if opt["start_min"] <= slot_min_pos < opt["end_min"]
                            )
                            shortage = pulp.LpVariable("POS_short_{}_{}_{}" .format(pos, d, slot_min_pos), lowBound=0)
                            prob += (shortage >= req_num - working_pos)
                            penalty += shortage * self.W.POSITION_SHORT

            prob += penalty
            # Tierごとにタイムリミットを段階化（合計最大110秒でRailway制限内に収める）
            tier_time_limits = {3: 60, 2: 30, 1: 20}
            solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=tier_time_limits.get(tier, 60))
            prob.solve(solver)

            status = pulp.LpStatus[prob.status]
            logger.info("[MILP] Status: {} (tier={}, force={})".format(
                status, tier, force))

            if status not in ("Optimal", "Not Solved"):
                return None

            # ====================================================
            # 結果抽出 + 配置理由ラベル付与
            # ====================================================
            shifts = []
            warnings = []
            for s in self.staff_list:
                sid = s["id"]
                rank = self._eval_rank.get(sid, "B")
                priority = str(s.get("shift_priority", "medium")).lower()
                contract = str(s.get("contract_type", "general")).lower()
                for d in self.dates:
                    for oi, opt in enumerate(staff_opts.get((sid, d), [])):
                        if (sid, d, oi) in x and pulp.value(x[(sid, d, oi)]) and pulp.value(x[(sid, d, oi)]) > 0.5:
                            hrs = opt["hours"]
                            brk = self._get_break_minutes(hrs)
                            mh = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                            # 配置理由を判定 (優先順位高い順)
                            reason = assignment_reasons.get((sid, d))
                            if not reason:
                                pref = pref_index.get((sid, d))
                                if pref and pref.get("start") and pref.get("end"):
                                    ps = self._to_minutes(pref["start"])
                                    pe = self._to_minutes(pref["end"])
                                    diff = abs(opt["start_min"] - ps) + abs(opt["end_min"] - pe)
                                    if diff == 0:
                                        reason = "希望シフトと完全一致"
                                    elif diff <= 60:
                                        reason = "希望シフトに近い時間帯"
                                    else:
                                        reason = "希望日に配置"
                                elif priority == "high":
                                    reason = "シフト優先度: 高"
                                elif contract == "regular":
                                    reason = "レギュラー契約優先"
                                elif sid in self._mentor_ids:
                                    reason = "メンター・管理者ロール"
                                elif sid in self._monthly_ids:
                                    reason = "月給スタッフ (固定費活用)"
                                elif rank in ("A", "B"):
                                    reason = "高評価ランク (戦力)"
                                else:
                                    reason = "公平性に基づく自動配置"
                            entry = {
                                "staff_id": sid,
                                "date": d,
                                "start_time": opt["start"],
                                "end_time": opt["end"],
                                "break_minutes": brk,
                                "reason": reason,
                            }
                            if opt["work_hours"] > mh:
                                warnings.append("{} {}: {:.1f}h over".format(
                                    s.get("name", ""), d, opt["work_hours"] - mh))
                            shifts.append(entry)

            self._validate(shifts)

            # ====================================================
            # validation_report 生成 (slack 集計)
            # ====================================================
            def _name(sid):
                rec = self._staff_map.get(sid, {})
                return rec.get("name", sid[:8])

            coverage_gaps = []
            for (d, slot_min, req, sv) in tracked_slacks.get("coverage_under", []):
                v = pulp.value(sv) or 0
                if v >= 0.5:
                    coverage_gaps.append({
                        "date": d,
                        "time": self._from_minutes(slot_min),
                        "required": int(req),
                        "shortage": int(round(v)),
                    })

            open_close_gaps = []
            for (d, slot_min, sv) in tracked_slacks.get("open_close_under", []):
                v = pulp.value(sv) or 0
                if v >= 0.5:
                    open_close_gaps.append({
                        "date": d,
                        "time": self._from_minutes(slot_min),
                    })

            manager_gaps = []
            for (d, slot_min, req, sv) in tracked_slacks.get("manager_under", []):
                v = pulp.value(sv) or 0
                if v >= 0.5:
                    manager_gaps.append({
                        "date": d,
                        "time": self._from_minutes(slot_min),
                        "required": int(req),
                        "shortage": int(round(v)),
                    })

            report = {
                "tier": tier,
                "mode": "force" if force else "auto",
                "total_shifts": len(shifts),
                "overtime_warnings": warnings,
                "coverage_gaps": coverage_gaps[:50],          # スロット人員不足 (top 50)
                "open_close_gaps": open_close_gaps[:30],      # 開け締め社員不在
                "manager_gaps": manager_gaps[:50],            # 管理者数不足
                "has_violations": bool(warnings or coverage_gaps or open_close_gaps or manager_gaps),
            }
            self._last_report = report

            if warnings:
                logger.info("[OVERTIME]")
                for w in warnings:
                    logger.info("  " + w)
            logger.info("[Report] coverage_gaps={} open_close_gaps={} manager_gaps={}".format(
                len(coverage_gaps), len(open_close_gaps), len(manager_gaps)))
            logger.info("[Result] {} shifts".format(len(shifts)))
            return shifts if shifts else None

        except Exception as e:
            logger.info("[MILP Error] {}".format(e))
            import traceback
            traceback.print_exc()
            return None

    # ===========================================================
    # バリデーション
    # ===========================================================

    def _validate(self, shifts):
        violations = 0
        # ±1品質チェック用カウンター
        total_slots_checked = 0
        slots_within_pm1 = 0  # ±1以内に収まったスロット数
        daily_within_pm1 = 0  # ±1以内の日数
        daily_checked = 0

        # カバレッジ検証 + ±1品質チェック
        for d in self.dates:
            reqs = self._build_slot_requirements(d)
            day_s = [s for s in shifts if s["date"] == d]

            if not reqs:
                continue

            req_daily = self._get_required_staff(d)
            daily_assigned = len(day_s)
            # スロット要件の最大値も考慮（MILP制約と同じ基準）
            max_slot_req = max(reqs.values()) if reqs else req_daily
            daily_effective_req = max(req_daily, max_slot_req)
            if daily_effective_req > 0:
                daily_checked += 1
                daily_diff = daily_assigned - daily_effective_req
                if -1 <= daily_diff <= 1:
                    daily_within_pm1 += 1
                elif daily_diff < -1:
                    logger.info("  BALANCE: {} daily: need={} got={} ({}名不足)".format(
                        d, daily_effective_req, daily_assigned, abs(daily_diff)))
                elif daily_diff > 1:
                    logger.info("  BALANCE: {} daily: need={} got={} (+{}名過剰)".format(
                        d, daily_effective_req, daily_assigned, daily_diff))

            for slot_min, req in reqs.items():
                cov = sum(1 for s in day_s
                          if self._to_minutes(s["start_time"]) <= slot_min
                          < self._to_minutes(s["end_time"]))
                total_slots_checked += 1
                diff = cov - req
                if -1 <= diff <= 1:
                    slots_within_pm1 += 1
                if cov < req:
                    logger.info("  VIOLATION: {} {} need={} got={}".format(
                        d, self._from_minutes(slot_min), req, cov))
                    violations += 1

        # ±1達成率のログ出力
        if total_slots_checked > 0:
            slot_rate = (slots_within_pm1 / total_slots_checked) * 100
            logger.info("  [±1 QUALITY] Slot: {}/{} ({:.1f}%) within ±1".format(
                slots_within_pm1, total_slots_checked, slot_rate))
        if daily_checked > 0:
            daily_rate = (daily_within_pm1 / daily_checked) * 100
            logger.info("  [±1 QUALITY] Daily: {}/{} ({:.1f}%) within ±1".format(
                daily_within_pm1, daily_checked, daily_rate))

        # スタッフ別配置日数のバラツキ検証
        staff_days = {}
        for sh in shifts:
            sid = sh["staff_id"]
            staff_days.setdefault(sid, set()).add(sh["date"])
        if staff_days:
            days_list = [len(ds) for ds in staff_days.values()]
            avg_days = sum(days_list) / len(days_list)
            max_days = max(days_list)
            min_days = min(days_list)
            logger.info("  [FAIRNESS] Staff days: avg={:.1f}, min={}, max={}, spread={}".format(
                avg_days, min_days, max_days, max_days - min_days))

        # 連勤検証
        sorted_d = sorted(self.dates)
        for s in self.staff_list:
            sid = s["id"]
            consec = 0
            for d in sorted_d:
                if any(sh["staff_id"] == sid and sh["date"] == d for sh in shifts):
                    consec += 1
                    if consec > self.LEGAL_MAX_CONSECUTIVE_DAYS:
                        logger.info("  VIOLATION: {} consec={} days at {}".format(
                            s.get("name", sid), consec, d))
                        violations += 1
                else:
                    consec = 0

        # 週40時間検証
        week_groups = self._group_dates_by_week()
        for s in self.staff_list:
            sid = s["id"]
            for week in week_groups:
                total_hours = 0
                for d in week:
                    for sh in shifts:
                        if sh["staff_id"] == sid and sh["date"] == d:
                            sm = self._to_minutes(sh["start_time"])
                            em = self._normalize_end_time(sm, self._to_minutes(sh["end_time"]))
                            raw_hrs = (em - sm) / 60.0
                            brk = self._get_break_minutes(raw_hrs) / 60.0
                            total_hours += (raw_hrs - brk)
                if total_hours > self.LEGAL_MAX_HOURS_WEEK:
                    logger.info("  VIOLATION: {} week {} hours={:.1f} > {}".format(
                        s.get("name", sid), week[0], total_hours,
                        self.LEGAL_MAX_HOURS_WEEK))
                    violations += 1

        # NG日検証
        for s in self.staff_list:
            sid = s["id"]
            ng = self._get_staff_ng_dates(s)
            for sh in shifts:
                if sh["staff_id"] == sid and sh["date"] in ng:
                    logger.info("  VIOLATION: {} assigned on NG date {}".format(
                        s.get("name", sid), sh["date"]))
                    violations += 1

        if violations == 0:
            logger.info("  VALIDATION: All constraints satisfied!")
        else:
            logger.info("  VALIDATION: {} violations".format(violations))

    # ===========================================================
    # グリーディ解法 (MILP失敗時のフォールバック)
    # ===========================================================

    def _solve_greedy(self):
        shifts = []
        weekly_count = {}     # {staff_id: {week_key: count}}
        weekly_hours = {}     # {staff_id: {week_key: hours}}
        consecutive = {}      # {staff_id: current_consecutive_days}
        last_work_date = {}   # {staff_id: last_date_str}

        # まず承認済み出勤希望を固定シフトとして配置
        work_requests = self._get_work_requests()
        assigned_days = {}
        for wr in work_requests:
            wsid = wr["staff_id"]
            wd = wr["date"]
            if wd not in self.dates or self._get_day_type(wd) == "closed":
                continue
            staff = self._staff_map.get(wsid)
            if not staff:
                continue
            opts = self._build_shift_options(staff, wd, force=True)
            if not opts:
                continue
            best_opt = opts[0]
            if wr.get("start_time") and wr.get("end_time"):
                wr_start = self._to_minutes(wr["start_time"])
                wr_end = self._normalize_end_time(wr_start, self._to_minutes(wr["end_time"]))
                best_diff = float("inf")
                for opt in opts:
                    diff = abs(opt["start_min"] - wr_start) + abs(opt["end_min"] - wr_end)
                    if diff < best_diff:
                        best_diff = diff
                        best_opt = opt
            brk = self._get_break_minutes(best_opt["hours"])
            shifts.append({
                "staff_id": wsid, "date": wd,
                "start_time": best_opt["start"], "end_time": best_opt["end"],
                "break_minutes": brk,
            })
            assigned_days.setdefault(wd, set()).add(wsid)
            dt = datetime.strptime(wd, "%Y-%m-%d")
            wk = "{}-W{}".format(dt.year, dt.isocalendar()[1])
            weekly_count.setdefault(wsid, {})
            weekly_count[wsid][wk] = weekly_count[wsid].get(wk, 0) + 1
            weekly_hours.setdefault(wsid, {})
            weekly_hours[wsid][wk] = weekly_hours[wsid].get(wk, 0) + best_opt["hours"]

        # 日付順にスタッフを配置
        for d in sorted(self.dates):
            if self._get_day_type(d) == "closed":
                # 休業日は連勤カウントをリセット
                for sid in consecutive:
                    if last_work_date.get(sid) != d:
                        consecutive[sid] = 0
                continue
            slot_reqs = self._build_slot_requirements(d)
            if not slot_reqs:
                continue
            dt = datetime.strptime(d, "%Y-%m-%d")
            wk = "{}-W{}".format(dt.year, dt.isocalendar()[1])
            day_shifts = [s for s in shifts if s["date"] == d]
            assigned = assigned_days.get(d, set()).copy()

            # 管理者優先配置: まず管理者を確保
            manager_present = any(
                sh["staff_id"] in self._manager_ids for sh in day_shifts
            )
            if not manager_present:
                for mid in sorted(self._manager_ids):
                    mgr = self._staff_map.get(mid)
                    if not mgr or mid in assigned:
                        continue
                    if d in self._get_staff_ng_dates(mgr):
                        continue
                    if self._greedy_check_limits(mid, wk, weekly_count, weekly_hours, consecutive, mgr):
                        continue
                    opts = self._build_shift_options(mgr, d, force=False)
                    if opts:
                        opt = opts[0]  # 最初のパターン
                        brk = self._get_break_minutes(opt["hours"])
                        entry = {
                            "staff_id": mid, "date": d,
                            "start_time": opt["start"], "end_time": opt["end"],
                            "break_minutes": brk,
                        }
                        day_shifts.append(entry)
                        shifts.append(entry)
                        assigned.add(mid)
                        self._greedy_update_counts(mid, wk, d,
                                                   weekly_count, weekly_hours,
                                                   consecutive, last_work_date,
                                                   opt["hours"])
                        break

            # 不足スロットを埋める（ただし過剰配置は防止）
            for _ in range(30):
                deficit = {}
                max_slot_req_day = 0
                for slot_min, req in slot_reqs.items():
                    cov = sum(1 for s in day_shifts
                              if self._to_minutes(s["start_time"]) <= slot_min
                              < self._to_minutes(s["end_time"]))
                    if cov < req:
                        deficit[slot_min] = req - cov
                    if req > max_slot_req_day:
                        max_slot_req_day = req
                if not deficit:
                    break
                # 過剰配置防止: 日次の総配置人数がスロット最大要件+2を超えたら停止
                if len(day_shifts) > max_slot_req_day + 2 + len(assigned_days.get(d, set())):
                    break

                worst = max(deficit, key=deficit.get)
                best_s = best_o = None
                best_cov = 0

                # メンター優先、評価順でソート
                sorted_staff = sorted(
                    self.staff_list,
                    key=lambda s: (
                        0 if s["id"] in self._monthly_ids else 1,  # 月給優先
                        0 if s["id"] in self._mentor_ids else 1,
                        {"A": 0, "B": 1, "C": 2, "D": 3}.get(
                            self._eval_rank.get(s["id"], "B"), 2)
                    ))

                for s in sorted_staff:
                    sid = s["id"]
                    if sid in assigned:
                        continue
                    if d in self._get_staff_ng_dates(s):
                        continue
                    if self._greedy_check_limits(sid, wk, weekly_count,
                                                 weekly_hours, consecutive, s):
                        continue
                    max_hours = float(s.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
                    for opt in self._build_shift_options(s, d, force=False):
                        if opt["hours"] > max_hours:
                            continue
                        if opt["start_min"] <= worst < opt["end_min"]:
                            c = sum(1 for sm in deficit
                                    if opt["start_min"] <= sm < opt["end_min"])
                            if c > best_cov:
                                best_cov = c
                                best_s = s
                                best_o = opt
                    if best_s:
                        break

                if best_s and best_o:
                    brk = self._get_break_minutes(best_o["hours"])
                    entry = {
                        "staff_id": best_s["id"],
                        "date": d,
                        "start_time": best_o["start"],
                        "end_time": best_o["end"],
                        "break_minutes": brk,
                    }
                    day_shifts.append(entry)
                    shifts.append(entry)
                    assigned.add(best_s["id"])
                    self._greedy_update_counts(
                        best_s["id"], wk, d,
                        weekly_count, weekly_hours,
                        consecutive, last_work_date,
                        best_o["hours"])
                else:
                    break

            assigned_days[d] = assigned

        logger.info("[Greedy] {} shifts".format(len(shifts)))
        self._validate(shifts)
        return shifts if shifts else None

    def _greedy_check_limits(self, sid, wk, weekly_count, weekly_hours,
                             consecutive, staff):
        """グリーディ用: スタッフが制約に違反するかチェック"""
        md = int(staff.get("max_days_week") or 5)
        if md <= 0:
            return True  # 出勤不可
        cur_days = weekly_count.get(sid, {}).get(wk, 0)
        if cur_days >= md:
            return True  # 週最大日数超過

        cur_hours = weekly_hours.get(sid, {}).get(wk, 0)
        max_hours = float(staff.get("max_hours_day") or self.LEGAL_MAX_HOURS_DAY)
        if cur_hours + max_hours > self.LEGAL_MAX_HOURS_WEEK:
            return True  # 週40時間超過の可能性

        cur_consec = consecutive.get(sid, 0)
        if cur_consec >= self.LEGAL_MAX_CONSECUTIVE_DAYS:
            return True  # 連続勤務超過

        return False

    def _greedy_update_counts(self, sid, wk, date_str,
                              weekly_count, weekly_hours,
                              consecutive, last_work_date, hours):
        """グリーディ用: 各種カウンターを更新"""
        weekly_count.setdefault(sid, {})
        weekly_count[sid][wk] = weekly_count[sid].get(wk, 0) + 1

        weekly_hours.setdefault(sid, {})
        weekly_hours[sid][wk] = weekly_hours[sid].get(wk, 0) + hours

        # 連勤チェック
        prev = last_work_date.get(sid)
        if prev:
            prev_dt = datetime.strptime(prev, "%Y-%m-%d")
            cur_dt = datetime.strptime(date_str, "%Y-%m-%d")
            if (cur_dt - prev_dt).days == 1:
                consecutive[sid] = consecutive.get(sid, 0) + 1
            else:
                consecutive[sid] = 1
        else:
            consecutive[sid] = 1
        last_work_date[sid] = date_str

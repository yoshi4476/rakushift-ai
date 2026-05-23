// =================================================================
// Gantt Drag & Drop Manager for RakuShift
// Supports: Move (time change), Resize (start/end change),
//           Cross-row drag (staff reassignment)
// =================================================================

const GanttDrag = {
    active: false,
    mode: null, // 'move', 'resize-left', 'resize-right'
    shiftId: null,
    staffId: null,
    date: null,
    bar: null,
    cell: null,
    startX: 0,
    startLeft: 0,
    startWidth: 0,
    tooltip: null,
    ghost: null,
    originalRow: null,
    currentRow: null,

    HANDLE_WIDTH: 8, // px for resize handle area
    SNAP_MINUTES: 15,

    // 多重 init() 防止 + destroy() 用に bind 済みハンドラを保持
    _bound: null,

    init() {
        if (this._bound) {
            // 既に init 済 → 重複登録を回避 (リスナー増殖によるメモリリーク・連続発火防止)
            return;
        }
        this._bound = {
            md: this._onMouseDown.bind(this),
            mm: this._onMouseMove.bind(this),
            mu: this._onMouseUp.bind(this),
            ts: this._onTouchStart.bind(this),
            tm: this._onTouchMove.bind(this),
            te: this._onTouchEnd.bind(this),
        };
        document.addEventListener('mousedown', this._bound.md);
        document.addEventListener('mousemove', this._bound.mm);
        document.addEventListener('mouseup', this._bound.mu);
        document.addEventListener('touchstart', this._bound.ts, { passive: false });
        document.addEventListener('touchmove', this._bound.tm, { passive: false });
        document.addEventListener('touchend', this._bound.te);
    },

    destroy() {
        if (!this._bound) return;
        document.removeEventListener('mousedown', this._bound.md);
        document.removeEventListener('mousemove', this._bound.mm);
        document.removeEventListener('mouseup', this._bound.mu);
        document.removeEventListener('touchstart', this._bound.ts);
        document.removeEventListener('touchmove', this._bound.tm);
        document.removeEventListener('touchend', this._bound.te);
        this._bound = null;
    },

    _getBarFromEvent(e) {
        const target = e.target.closest('[data-shift-id]');
        if (!target) return null;
        return target;
    },

    _getCellFromBar(bar) {
        return bar.closest('td');
    },

    _getRowFromEvent(e) {
        const td = e.target.closest('td');
        if (!td) return null;
        return td.closest('tr');
    },

    _pctToTime(pct) {
        const totalMinutes = (pct / 100) * 24 * 60;
        const snapped = Math.round(totalMinutes / this.SNAP_MINUTES) * this.SNAP_MINUTES;
        const clamped = Math.max(0, snapped);
        let h = Math.floor(clamped / 60);
        const m = clamped % 60;
        h = h % 24;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    },

    _timeToPct(timeStr, startPct = null) {
        const [h, m] = timeStr.split(':').map(Number);
        let pct = ((h + m / 60) / 24) * 100;
        if (startPct !== null && pct < startPct) pct += 100;
        return pct;
    },

    _createTooltip() {
        const tip = document.createElement('div');
        tip.className = 'fixed bg-gray-900 text-white text-xs font-bold rounded px-2 py-1 z-[9999] pointer-events-none shadow-lg';
        tip.style.display = 'none';
        document.body.appendChild(tip);
        return tip;
    },

    _updateTooltip(e, startTime, endTime) {
        if (!this.tooltip) return;
        this.tooltip.textContent = `${startTime} - ${endTime}`;
        this.tooltip.style.display = 'block';
        this.tooltip.style.left = (e.clientX + 12) + 'px';
        this.tooltip.style.top = (e.clientY - 30) + 'px';
    },

    _onMouseDown(e) {
        if (e.button !== 0) return;
        this._startDrag(e, e.clientX);
    },

    _onTouchStart(e) {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        if (!el) return;
        const bar = el.closest('[data-shift-id]');
        if (!bar) return;
        e.preventDefault();
        this._startDrag({ target: el, clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} }, touch.clientX);
    },

    _startDrag(e, clientX) {
        if (!window.app?.state?.isAdmin) return;

        const bar = this._getBarFromEvent(e);
        if (!bar) return;

        const cell = this._getCellFromBar(bar);
        if (!cell) return;

        e.preventDefault();

        const rect = bar.getBoundingClientRect();
        const offsetX = clientX - rect.left;

        // Determine mode
        if (offsetX < this.HANDLE_WIDTH) {
            this.mode = 'resize-left';
        } else if (offsetX > rect.width - this.HANDLE_WIDTH) {
            this.mode = 'resize-right';
        } else {
            this.mode = 'move';
        }

        this.active = true;
        this.bar = bar;
        this.cell = cell;
        this.shiftId = bar.dataset.shiftId;
        this.staffId = bar.dataset.staffId;
        this.date = bar.dataset.date;
        this.startX = clientX;
        this.originalRow = bar.closest('tr');
        this.currentRow = this.originalRow;

        // Get current position in percentage
        this.startLeft = parseFloat(bar.style.left) || 0;
        this.startWidth = parseFloat(bar.style.width) || 0;

        // Visual feedback
        bar.style.opacity = '0.7';
        bar.style.zIndex = '100';
        document.body.style.cursor = this.mode === 'move' ? 'grabbing' : 'ew-resize';
        document.body.style.userSelect = 'none';

        // Create tooltip
        this.tooltip = this._createTooltip();
    },

    _onMouseMove(e) {
        if (!this.active) return;
        this._handleMove(e, e.clientX, e.clientY);
    },

    _onTouchMove(e) {
        if (!this.active) return;
        if (e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        this._handleMove({ clientX: touch.clientX, clientY: touch.clientY }, touch.clientX, touch.clientY);
    },

    _handleMove(e, clientX, clientY) {
        const cellRect = this.cell.getBoundingClientRect();
        const cellWidth = cellRect.width;
        const deltaX = clientX - this.startX;
        const deltaPct = (deltaX / cellWidth) * 100;

        let newLeft = this.startLeft;
        let newWidth = this.startWidth;

        if (this.mode === 'move') {
            newLeft = this.startLeft + deltaPct;
            newLeft = Math.max(0, Math.min(newLeft, 100 - this.startWidth));
        } else if (this.mode === 'resize-left') {
            newLeft = this.startLeft + deltaPct;
            newWidth = this.startWidth - deltaPct;
            if (newWidth < 1) { newWidth = 1; newLeft = this.startLeft + this.startWidth - 1; }
            if (newLeft < 0) { newWidth += newLeft; newLeft = 0; }
        } else if (this.mode === 'resize-right') {
            newWidth = this.startWidth + deltaPct;
            if (newWidth < 1) newWidth = 1;
            if (newLeft + newWidth > 100) newWidth = 100 - newLeft;
        }

        // Apply to bar
        this.bar.style.left = newLeft + '%';
        this.bar.style.width = newWidth + '%';

        // Update tooltip
        const startTime = this._pctToTime(newLeft);
        const endTime = this._pctToTime(newLeft + newWidth);
        this._updateTooltip(e, startTime, endTime);

        // Cross-row detection for move mode
        if (this.mode === 'move') {
            const rows = document.querySelectorAll('#shiftTableBody tr');
            for (const row of rows) {
                const rowRect = row.getBoundingClientRect();
                if (clientY >= rowRect.top && clientY <= rowRect.bottom) {
                    if (this.currentRow !== row) {
                        if (this.currentRow) this.currentRow.classList.remove('bg-blue-50');
                        row.classList.add('bg-blue-50');
                        this.currentRow = row;
                    }
                    break;
                }
            }
        }
    },

    _onMouseUp(e) {
        if (!this.active) return;
        this._endDrag();
    },

    _onTouchEnd(e) {
        if (!this.active) return;
        this._endDrag();
    },

    _endDrag() {
        if (!this.active) return;

        // Calculate final times
        const finalLeft = parseFloat(this.bar.style.left) || 0;
        const finalWidth = parseFloat(this.bar.style.width) || 0;
        const startTime = this._pctToTime(finalLeft);
        const endTime = this._pctToTime(finalLeft + finalWidth);

        // Check if staff changed (cross-row drag)
        let newStaffId = this.staffId;
        if (this.mode === 'move' && this.currentRow && this.currentRow !== this.originalRow) {
            const rowStaffId = this.currentRow.dataset.staffId;
            if (rowStaffId) {
                newStaffId = rowStaffId;
            }
        }

        // Check if anything actually changed
        const shift = window.app.state.shifts.find(s => s.id === this.shiftId);
        const changed = shift && (
            shift.start_time !== startTime ||
            shift.end_time !== endTime ||
            shift.staff_id !== newStaffId
        );

        if (changed && startTime !== endTime) {
            window.app.updateShiftDrag(this.shiftId, {
                start_time: startTime,
                end_time: endTime,
                staff_id: newStaffId
            });
        } else {
            // Revert visual changes
            if (shift) {
                const startPct = this._timeToPct(shift.start_time);
                this.bar.style.left = startPct + '%';
                const endPct = this._timeToPct(shift.end_time, startPct);
                const w = endPct - startPct;
                this.bar.style.width = w + '%';
            }
        }

        // Cleanup
        this.bar.style.opacity = '1';
        this.bar.style.zIndex = '10';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        if (this.currentRow) this.currentRow.classList.remove('bg-blue-50');
        if (this.tooltip) {
            this.tooltip.remove();
            this.tooltip = null;
        }

        this.active = false;
        this.mode = null;
        this.bar = null;
        this.cell = null;
    }
};

// Auto-initialize
document.addEventListener('DOMContentLoaded', () => GanttDrag.init());
window.GanttDrag = GanttDrag;

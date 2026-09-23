// ============================================================
// GeoAttend Pro — Admin Dashboard Frontend
// Same UI/design as provided. All data now comes from the real
// Node.js/Express/MySQL backend via fetch() calls.
// ============================================================

const API = '/api';

function authHeaders(json = true) {
    const token = localStorage.getItem('ga_token');
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

async function apiFetch(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
        ...options,
        headers: { ...authHeaders(!(options.body instanceof FormData)), ...(options.headers || {}) }
    });
    let data;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
    return data;
}

// Escapes text before it goes into an innerHTML template (names, titles).
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerText = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

const G_App = {
    state: {
        departments: [],
        employees: [],
        geofences: [],
        currentDept: null,
        currentDeptId: null,
        role: null
    },

    auth: {
        login: async () => {
            const email = document.getElementById('login-email').value.trim();
            const password = document.getElementById('login-password').value;
            const errorEl = document.getElementById('login-error');
            const btn = document.getElementById('login-btn');
            errorEl.innerText = '';

            if (!email || !password) {
                errorEl.innerText = 'Please enter both email and password.';
                return;
            }

            btn.innerText = 'Verifying...';
            try {
                const data = await apiFetch('/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({ email, password })
                });
                localStorage.setItem('ga_token', data.token);
                localStorage.setItem('ga_admin', JSON.stringify(data.admin));

                document.getElementById('login-screen').style.opacity = '0';
                setTimeout(() => {
                    document.getElementById('login-screen').classList.add('hidden');
                    document.getElementById('app-sidebar').classList.remove('hidden');
                    document.getElementById('main-wrapper').classList.remove('hidden');
                    document.getElementById('main-wrapper').style.display = 'flex';
                    G_App.init();
                }, 400);
            } catch (err) {
                errorEl.innerText = err.message;
                btn.innerText = 'Verify & Authorize';
            }
        },
        logout: async () => {
            try { await apiFetch('/auth/logout', { method: 'POST' }); } catch (e) {}
            localStorage.removeItem('ga_token');
            localStorage.removeItem('ga_admin');
            localStorage.removeItem(G_App.ui.ACTIVE_VIEW_KEY);
            location.reload();
        },
        checkSession: () => {
            const token = localStorage.getItem('ga_token');
            const admin = localStorage.getItem('ga_admin');
            if (token && admin) {
                document.getElementById('login-screen').classList.add('hidden');
                document.getElementById('app-sidebar').classList.remove('hidden');
                document.getElementById('main-wrapper').classList.remove('hidden');
                document.getElementById('main-wrapper').style.display = 'flex';
                G_App.init();
            }
        }
    },

    ui: {
        // localStorage key that remembers whichever nav section the admin was
        // looking at, so a manual browser refresh (F5) reopens the same page
        // instead of always snapping back to the Dashboard.
        ACTIVE_VIEW_KEY: 'ga_active_view',
        initNav: () => {
            document.querySelectorAll('.nav-item[data-target]').forEach(item => {
                item.addEventListener('click', () => {
                    G_App.ui.switchView(item.getAttribute('data-target'), item);
                });
            });
        },
        // Shared by the click handler above and by the reload-restore logic in
        // init() below, so both paths do exactly the same work (activate the
        // nav item + view, run that section's loaders, and remember the choice).
        switchView: (target, item) => {
            item = item || document.querySelector(`.nav-item[data-target="${target}"]`);
            const viewEl = document.getElementById(target);
            if (!item || !viewEl) return false;

                    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                    document.getElementById(target).classList.add('active');
                    document.getElementById('view-title').innerText = item.innerText.trim();
                    localStorage.setItem(G_App.ui.ACTIVE_VIEW_KEY, target);

                    if (target === 'geofence') {
                        if (!G_App.geofence.map) {
                            G_App.geofence.init();
                        } else {
                            setTimeout(() => {
                                google.maps.event.trigger(G_App.geofence.map, 'resize');
                                G_App.geofence.map.setCenter(G_App.geofence.map.getCenter());
                            }, 200);
                        }
                        G_App.geofence.loadAlerts();
                    }
                    if (target === 'verification-section') G_App.verification.init();
                    if (target === 'reports') G_App.reports.init();
                    if (target === 'settings') { G_App.settings.render(); G_App.adminAccounts.load(); }
                    if (target === 'mobile-app') G_App.mobile.render();
                    if (target === 'ratings') { G_App.ratings.initSelectors(); G_App.ratings.load(); }
                    if (target === 'departments') G_App.departments.render();
                    if (target === 'events') G_App.events.load();
                    lucide.createIcons();
                    document.getElementById('app-sidebar').classList.remove('mobile-open');
            return true;
        },
        toggleDarkMode: () => document.body.classList.toggle('dark-mode'),
        // Auto-refresh: every 30s, silently re-fetch whichever view is
        // currently on screen so stats/tables/charts stay live without the
        // admin needing to manually reload the page.
        autoRefreshTimer: null,
        startAutoRefresh: () => {
            if (G_App.ui.autoRefreshTimer) return;
            G_App.ui.autoRefreshTimer = setInterval(() => G_App.ui.refreshActiveView(), 30000);
        },
        stopAutoRefresh: () => {
            if (G_App.ui.autoRefreshTimer) {
                clearInterval(G_App.ui.autoRefreshTimer);
                G_App.ui.autoRefreshTimer = null;
            }
        },
        refreshActiveView: async () => {
            if (document.hidden) return; // don't burn API calls on a backgrounded tab
            const activeView = document.querySelector('.view.active');
            if (!activeView) return;
            try {
                switch (activeView.id) {
                    case 'dashboard':
                        await G_App.ui.updateDashboard();
                        break;
                    case 'attendance':
                        if (G_App.attendance.currentEventId && !document.getElementById('attendance-detail').classList.contains('hidden')) {
                            await G_App.attendance.loadDetail();
                        } else {
                            await G_App.attendance.render();
                        }
                        break;
                    case 'geofence':
                        await G_App.geofence.load();
                        await G_App.geofence.loadAlerts();
                        break;
                    case 'events':
                        await G_App.events.load();
                        break;
                    case 'ratings':
                        await G_App.ratings.load();
                        break;
                    default:
                        break;
                }
            } catch (err) { /* non-fatal — next tick tries again */ }
        },        toggleNotifs: () => document.getElementById('notif-drawer').classList.toggle('open'),
        toggleMobileNav: () => document.getElementById('app-sidebar').classList.toggle('mobile-open'),
        applyRoleRestrictions: () => {
            const badge = document.getElementById('admin-name-badge');
            const adminData = JSON.parse(localStorage.getItem('ga_admin') || '{}');
            if (badge) badge.innerText = `${adminData.name || 'Admin'} (${G_App.state.role === 'super_admin' ? 'Super Admin' : 'Verification Admin'})`;

            if (G_App.state.role !== 'admin') return; // super_admin sees everything, nothing to restrict

            // Verification-only admin: hide every nav item except Verification, and jump straight there.
            document.querySelectorAll('.nav-item[data-target]').forEach(item => {
                if (item.getAttribute('data-target') !== 'verification-section') item.classList.add('hidden');
            });
            document.querySelectorAll('.nav-item[data-target]').forEach(i => i.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            const verificationNav = document.querySelector('.nav-item[data-target="verification-section"]');
            if (verificationNav) verificationNav.classList.add('active');
            document.getElementById('verification-section').classList.add('active');
            document.getElementById('view-title').innerText = 'Verification';
            document.getElementById('view-subtitle').innerText = 'Restricted Access — Identity Verification Only';
        },
        updateDashboard: async () => {
            try {
                const { data } = await apiFetch('/dashboard/stats');
                document.getElementById('stat-total').innerText = data.totalEmployees;
                document.getElementById('stat-present').innerText = data.fullTime;
                document.getElementById('stat-late').innerText = data.partTime;
                document.getElementById('stat-absent').innerText = data.inactive;

                const todayPresentEl = document.getElementById('stat-today-present');
                if (todayPresentEl) todayPresentEl.innerText = data.todayPresent;
                const todayLateEl = document.getElementById('stat-today-late');
                if (todayLateEl) todayLateEl.innerText = data.todayLate;
                const activeEventsEl = document.getElementById('stat-active-events');
                if (activeEventsEl) activeEventsEl.innerText = data.activeEvents;
                const devicesEl = document.getElementById('stat-registered-devices');
                if (devicesEl) devicesEl.innerText = data.registeredDevices;

                G_App.ui.initClassificationChart(data.classificationBreakdown);
                await G_App.ui.populateDeptEventFilter();
                await G_App.ui.loadDepartmentAttendanceChart();
                G_App.ui.loadRecentActivity();
                G_App.ui.loadUpcomingEvents();
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        // Small helper: turns an audit_logs "module" into an icon + human label
        // so the feed reads naturally instead of showing raw enum-ish strings.
        activityMeta: {
            employee: { icon: 'user', label: 'Employee' },
            face: { icon: 'scan-face', label: 'Face Verification' },
            ocr: { icon: 'scan-text', label: 'OCR Verification' },
            attendance: { icon: 'calendar-check', label: 'Attendance' },
            geofence: { icon: 'map-pin', label: 'Geo-Fence' },
            event: { icon: 'calendar-range', label: 'Event' },
            device: { icon: 'smartphone', label: 'Device' },
            admin: { icon: 'shield-check', label: 'Admin Account' }
        },
        loadRecentActivity: async () => {
            const container = document.getElementById('dash-recent-activity');
            if (!container) return;
            try {
                const { data } = await apiFetch('/dashboard/recent-activity?limit=8');
                container.innerHTML = data.length ? data.map(a => {
                    const meta = G_App.ui.activityMeta[a.module] || { icon: 'activity', label: a.module };
                    const when = new Date(a.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                    return `
                        <div class="activity-item">
                            <div class="activity-dot"><i data-lucide="${meta.icon}" size="16"></i></div>
                            <div>
                                <p>${meta.label} — ${a.action.replace(/_/g, ' ')}</p>
                                <span>${a.admin_name || 'System'} · ${when}</span>
                            </div>
                        </div>`;
                }).join('') : '<div class="activity-item"><p>No activity recorded yet.</p></div>';
                lucide.createIcons();
            } catch (err) { /* non-fatal — feed just stays as-is */ }
        },
        loadUpcomingEvents: async () => {
            const container = document.getElementById('dash-upcoming-events');
            if (!container) return;
            try {
                const { data } = await apiFetch('/events?status=upcoming&limit=5');
                container.innerHTML = data.length ? data.map(e => {
                    const start = new Date(e.start_datetime);
                    return `
                        <div class="mini-event-item">
                            <div><h5>${e.title}</h5><span>${e.venue || 'TBA'}</span></div>
                            <span>${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>`;
                }).join('') : '<div class="mini-event-item"><h5>Nothing scheduled.</h5></div>';
            } catch (err) { /* non-fatal */ }
        },
        populateDeptEventFilter: async () => {
            const sel = document.getElementById('dash-dept-event');
            if (!sel || sel.dataset.loaded) return;
            try {
                const { data } = await apiFetch('/events?limit=50&status=all');
                sel.innerHTML = '<option value="">All Events</option>' +
                    data.map(e => `<option value="${e.id}">${e.title} — ${new Date(e.start_datetime).toLocaleDateString()}</option>`).join('');
                sel.dataset.loaded = '1';
            } catch (err) { /* non-fatal */ }
        },
        initClassificationChart: (breakdown) => {
            const canvas = document.getElementById('classificationChart');
            if (!canvas || !breakdown) return;
            const ctx = canvas.getContext('2d');
            if (window.classificationChart && typeof window.classificationChart.destroy === 'function') {
                window.classificationChart.destroy();
            }
            window.classificationChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['Permanent', 'COS', 'Casual/Job Order', 'Other'],
                    datasets: [{
                        data: [breakdown.Permanent || 0, breakdown.COS || 0, breakdown['Casual/Job Order'] || 0, breakdown.Other || 0],
                        backgroundColor: ['#0D00A5', '#4318FF', '#FFB547', '#A3AED0']
                    }]
                },
                options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
            });
        },
        loadDepartmentAttendanceChart: async () => {
            const canvas = document.getElementById('deptAttendanceChart');
            if (!canvas) return;
            const eventId = document.getElementById('dash-dept-event') ? document.getElementById('dash-dept-event').value : '';
            const classification = document.getElementById('dash-dept-classification') ? document.getElementById('dash-dept-classification').value : 'all';
            try {
                const params = new URLSearchParams();
                if (eventId) params.set('event_id', eventId);
                if (classification && classification !== 'all') params.set('classification', classification);
                const { data } = await apiFetch(`/dashboard/department-attendance?${params.toString()}`);
                const ctx = canvas.getContext('2d');
                if (window.deptAttendanceChart && typeof window.deptAttendanceChart.destroy === 'function') {
                    window.deptAttendanceChart.destroy();
                }
                window.deptAttendanceChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: data.map(d => d.department),
                        datasets: [
                            { label: 'Total Employees', data: data.map(d => d.total_employees), backgroundColor: '#CBD5E1', borderRadius: 6 },
                            { label: 'Attended', data: data.map(d => d.attended), backgroundColor: '#05CD99', borderRadius: 6 }
                        ]
                    },
                    options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } }
                });
            } catch (err) { toast(err.message, 'error'); }
        }
    },

    departments: {
        load: async () => {
            const { data } = await apiFetch('/departments');
            G_App.state.departments = data;
            const options = data.length
                ? data.map(d => `<option>${d.name}</option>`).join('')
                : '<option value="" disabled selected>No departments yet — add one first</option>';

            document.getElementById('inp-dept').innerHTML = options;
            document.getElementById('filter-dept').innerHTML = '<option value="all">All Departments</option>' + (data.map(d => `<option>${d.name}</option>`).join(''));
            document.getElementById('rpt-dept').innerHTML = '<option value="all">All Offices</option>' + (data.map(d => `<option>${d.name}</option>`).join(''));
        },
        render: async () => {
            await G_App.departments.load();
            const data = G_App.state.departments || [];
            const tbody = document.getElementById('departments-table-body');
            if (!tbody) return;
            tbody.innerHTML = data.map(d => `
                <tr>
                    <td><b>${d.name}</b></td>
                    <td>${d.office || '—'}</td>
                    <td>${d.employee_count || 0}</td>
                    <td><button class="btn-primary" style="background:var(--danger); padding:6px 12px; font-size:0.75rem;" onclick="G_App.departments.remove(${d.id}, '${(d.name || '').replace(/'/g, "\\'")}')">Delete</button></td>
                </tr>
            `).join('') || '<tr><td colspan="4" style="color:var(--text-muted); text-align:center; padding:20px;">No departments yet. Click "Add Department" to create one.</td></tr>';
            lucide.createIcons();
        },
        openModal: () => {
            document.getElementById('dept-name').value = '';
            document.getElementById('dept-office').value = '';
            document.getElementById('dept-description').value = '';
            document.getElementById('dept-modal').classList.add('open');
        },
        closeModal: () => document.getElementById('dept-modal').classList.remove('open'),
        save: async () => {
            const name = document.getElementById('dept-name').value.trim();
            if (!name) return toast('Department name is required.', 'error');
            const payload = {
                name,
                office: document.getElementById('dept-office').value.trim() || undefined,
                description: document.getElementById('dept-description').value.trim() || undefined
            };
            try {
                await apiFetch('/departments', { method: 'POST', body: JSON.stringify(payload) });
                toast('Department created.', 'success');
                G_App.departments.closeModal();
                await G_App.departments.load();
                if (document.getElementById('departments').classList.contains('active')) G_App.departments.render();
                // If they were mid-way through registering a member, pre-select the department they just added.
                const deptSelect = document.getElementById('inp-dept');
                if (deptSelect) deptSelect.value = name;
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        remove: async (id, name) => {
            if (!confirm(`Delete department "${name}"? This cannot be undone.`)) return;
            try {
                await apiFetch(`/departments/${id}`, { method: 'DELETE' });
                toast('Department deleted.', 'success');
                G_App.departments.render();
            } catch (err) {
                toast(err.message, 'error');
            }
        }
    },

    employees: {
        // Sets a <select>'s value, but if that exact value isn't one of its
        // options (e.g. an employee's classification came from the mobile
        // app's free-text "Others" field, so it's something completely
        // custom that this dropdown's own option list can't anticipate),
        // inserts a temporary option for it first instead of silently
        // falling back to nothing selected. Without this, saving the form
        // untouched would submit whatever the browser defaults an
        // unmatched <select> to -- silently overwriting that employee's
        // real classification with the wrong one.
        setSelectPreservingUnknown: (selectId, value) => {
            const select = document.getElementById(selectId);
            // Remove any custom option left over from a previous call for a
            // different employee, so this doesn't grow indefinitely over an
            // admin's session -- at most one exists at a time.
            [...select.options].filter(o => o.dataset.custom).forEach(o => o.remove());
            if (value && ![...select.options].some(o => o.value === value)) {
                const opt = new Option(`${value} (custom)`, value);
                opt.dataset.custom = '1';
                select.add(opt);
            }
            select.value = value || select.options[0]?.value || '';
        },
        openModal: (id = null) => {
            const modal = document.getElementById('crud-modal');
            const title = document.getElementById('modal-title');
            const saveBtn = document.getElementById('btn-save-member');

            if (id) {
                const emp = G_App.state.employees.find(e => e.id == id);
                title.innerText = 'Edit Member';
                document.getElementById('inp-id').value = emp.id;
                document.getElementById('inp-code').value = emp.employee_code;
                document.getElementById('inp-surname').value = emp.surname || '';
                document.getElementById('inp-given-name').value = emp.given_name || '';
                document.getElementById('inp-middle-name').value = emp.middle_name || '';
                document.getElementById('inp-suffix').value = emp.suffix || '';
                document.getElementById('inp-dept').value = emp.department_name;
                document.getElementById('inp-position').value = emp.position || '';
                document.getElementById('inp-email').value = emp.email || '';
                document.getElementById('inp-status').value = emp.status;
                G_App.employees.setSelectPreservingUnknown('inp-classification', emp.classification || 'Permanent Administrative');
                document.getElementById('inp-remark').value = emp.remark || 'Active';
                saveBtn.onclick = () => G_App.employees.update();
            } else {
                title.innerText = 'Register Member';
                document.getElementById('inp-id').value = '';
                document.getElementById('inp-code').value = '';
                document.getElementById('inp-surname').value = '';
                document.getElementById('inp-given-name').value = '';
                document.getElementById('inp-middle-name').value = '';
                document.getElementById('inp-suffix').value = '';
                document.getElementById('inp-position').value = '';
                document.getElementById('inp-email').value = '';
                document.getElementById('inp-status').value = 'Full-time';
                document.getElementById('inp-classification').value = 'Permanent Administrative';
                document.getElementById('inp-remark').value = 'Active';
                saveBtn.onclick = () => G_App.employees.save();
            }
            modal.classList.add('open');
        },
        closeModal: () => document.getElementById('crud-modal').classList.remove('open'),
        readForm: () => {
            const employeeCode = document.getElementById('inp-code').value.trim();
            const surname = document.getElementById('inp-surname').value.trim();
            const givenName = document.getElementById('inp-given-name').value.trim();
            const department = document.getElementById('inp-dept').value;
            if (!employeeCode) { toast('Employee ID is required.', 'error'); return null; }
            if (!surname || !givenName) { toast('Surname and Given Name are required.', 'error'); return null; }
            if (!department) { toast('Please select a department. Use "+ Add New" if none exist yet.', 'error'); return null; }
            return {
                employee_code: employeeCode,
                surname,
                given_name: givenName,
                middle_name: document.getElementById('inp-middle-name').value.trim(),
                suffix: document.getElementById('inp-suffix').value,
                department,
                position: document.getElementById('inp-position').value,
                email: document.getElementById('inp-email').value,
                status: document.getElementById('inp-status').value,
                classification: document.getElementById('inp-classification').value,
                remark: document.getElementById('inp-remark').value
            };
        },
        save: async () => {
            const payload = G_App.employees.readForm();
            if (!payload) return;
            try {
                await apiFetch('/employees', { method: 'POST', body: JSON.stringify(payload) });
                toast('Employee registered successfully.', 'success');
                G_App.employees.afterChange();
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        update: async () => {
            const id = document.getElementById('inp-id').value;
            const payload = G_App.employees.readForm();
            if (!payload) return;
            try {
                await apiFetch(`/employees/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
                toast('Employee updated successfully.', 'success');
                G_App.employees.afterChange();
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        delete: async (id) => {
            if (!confirm('Are you sure you want to delete this resource?')) return;
            try {
                await apiFetch(`/employees/${id}`, { method: 'DELETE' });
                toast('Employee deleted.', 'success');
                G_App.employees.afterChange();
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        setRemark: async (id, remark) => {
            try {
                await apiFetch(`/employees/${id}/remark`, { method: 'PATCH', body: JSON.stringify({ remark }) });
                const emp = G_App.state.employees.find(e => e.id == id);
                if (emp) emp.remark = remark;
                toast(`Remark set to ${remark}.`, 'success');
                G_App.employees.render();
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        unlockFace: async (id) => {
            if (!confirm('Clear this employee\'s DoubleSafe lock? They\'ll be able to attempt device re-verification again immediately.')) return;
            try {
                await apiFetch(`/employees/${id}/unlock-face`, { method: 'PATCH' });
                const emp = G_App.state.employees.find(e => e.id == id);
                if (emp) { emp.face_locked_until = null; emp.face_failed_attempts = 0; emp.face_lock_reason = null; }
                toast('Face verification lock cleared.', 'success');
                G_App.employees.render();
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        afterChange: async () => {
            G_App.employees.closeModal();
            await G_App.employees.load();
            G_App.ui.updateDashboard();
            G_App.attendance.render();
            G_App.mobile.render();
        },
        load: async () => {
            const dept = document.getElementById('filter-dept') ? document.getElementById('filter-dept').value : 'all';
            const classification = document.getElementById('filter-classification') ? document.getElementById('filter-classification').value : 'all';
            const { data } = await apiFetch(`/employees?department=${encodeURIComponent(dept)}&classification=${encodeURIComponent(classification)}&limit=200`);
            G_App.state.employees = data;
            G_App.employees.render();
        },
        statusBadgeClass: (status) => status === 'Full-time' ? 'success' : status === 'Part-time' ? 'warning' : status === 'COS' ? 'info' : 'danger',
        remarkBadgeClass: (remark) => remark === 'Active' ? 'success' : 'warning',
        // Grouped by employment permanence tier: Permanent (green) is the
        // most stable, COS (blue) is fixed-term, Casual/Job Order (amber)
        // is the least permanent.
        classificationBadgeClass: (c) => /^Permanent/.test(c || '') ? 'success' : /^COS/.test(c || '') ? 'info' : 'warning',
        render: () => {
            const tbody = document.getElementById('employee-table-body');
            if (!tbody) return;
            tbody.innerHTML = G_App.state.employees.map(e => {
                const isLocked = e.face_locked_until && new Date(e.face_locked_until) > new Date();
                return `
                <tr>
                    <td>
                        ${e.full_name}
                        ${isLocked ? `<br><span class="badge badge-danger" title="${e.face_lock_reason || 'DoubleSafe lock'} — locked until ${new Date(e.face_locked_until).toLocaleString()}">\uD83D\uDD12 Face Verification Locked</span>` : ''}
                    </td>
                    <td><code>${e.employee_code}</code></td>
                    <td>${e.department_name}</td>
                    <td>${e.position || 'N/A'}</td>
                    <td><span class="badge badge-${G_App.employees.classificationBadgeClass(e.classification)}">${e.classification || '—'}</span></td>
                    <td><span class="badge badge-${G_App.employees.statusBadgeClass(e.status)}">${e.status}</span></td>
                    <td>
                        <select class="badge-select badge-${G_App.employees.remarkBadgeClass(e.remark)}" onchange="G_App.employees.setRemark(${e.id}, this.value)">
                            <option value="Active" ${e.remark === 'Active' ? 'selected' : ''}>Active</option>
                            <option value="On Leave" ${e.remark === 'On Leave' ? 'selected' : ''}>On Leave</option>
                        </select>
                    </td>
                    <td>
                        <button class="btn-icon btn-edit" onclick="G_App.employees.openModal(${e.id})"><i data-lucide="edit-3" size="14"></i></button>
                        ${isLocked ? `<button class="btn-icon" title="Unlock DoubleSafe face verification" onclick="G_App.employees.unlockFace(${e.id})"><i data-lucide="unlock" size="14"></i></button>` : ''}
                        <button class="btn-icon btn-delete" onclick="G_App.employees.delete(${e.id})"><i data-lucide="trash" size="14"></i></button>
                    </td>
                </tr>
            `;}).join('') || '<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--text-muted);">No employees yet.</td></tr>';
            lucide.createIcons();
        },
        filter: (q) => {
            const rows = document.querySelectorAll('#employee-table-body tr');
            rows.forEach(r => r.style.display = r.innerText.toLowerCase().includes(q.toLowerCase()) ? '' : 'none');
        },
        exportFile: (format) => {
            window.open(`${API}/employees/export/${format === 'excel' ? 'excel' : 'csv'}?token=${localStorage.getItem('ga_token')}`, '_blank');
        }
    },

    employeeImport: {
        validatedRows: [],
        openModal: () => {
            document.getElementById('import-file-input').value = '';
            document.getElementById('import-preview-summary').classList.add('hidden');
            document.getElementById('import-preview-table-wrap').classList.add('hidden');
            document.getElementById('btn-import-commit').classList.add('hidden');
            document.getElementById('import-modal').classList.add('open');
        },
        closeModal: () => document.getElementById('import-modal').classList.remove('open'),
        preview: async () => {
            const fileInput = document.getElementById('import-file-input');
            if (!fileInput.files.length) return;
            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            try {
                const { summary, rows } = await apiFetch('/employees/import/preview', { method: 'POST', body: formData });
                G_App.employeeImport.validatedRows = rows;

                const summaryEl = document.getElementById('import-preview-summary');
                summaryEl.classList.remove('hidden');
                summaryEl.innerHTML = `
                    <span class="badge badge-info">Total Rows: ${summary.totalRows}</span>
                    <span class="badge badge-success">Valid: ${summary.validRows}</span>
                    <span class="badge badge-warning">Duplicates: ${summary.duplicateRows}</span>
                    <span class="badge badge-danger">Invalid: ${summary.invalidRows}</span>
                `;

                const tableWrap = document.getElementById('import-preview-table-wrap');
                tableWrap.classList.remove('hidden');
                document.getElementById('import-preview-table').innerHTML = rows.map(r => `
                    <tr>
                        <td>${r.rowNumber}</td>
                        <td>${r.employee_code || '—'}</td>
                        <td>${[r.given_name, r.surname].filter(Boolean).join(' ') || '—'}</td>
                        <td>${r.department || '—'}</td>
                        <td>${r.isValid
                            ? '<span class="badge badge-success">Ready</span>'
                            : `<span class="badge badge-danger" title="${r.errors.join(', ')}">${r.errors[0]}</span>`}</td>
                    </tr>
                `).join('');

                document.getElementById('btn-import-commit').classList.toggle('hidden', summary.validRows === 0);
                toast(`Parsed ${summary.totalRows} rows — ${summary.validRows} ready to import.`, 'info');
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        commit: async () => {
            const validRows = G_App.employeeImport.validatedRows.filter(r => r.isValid);
            if (!validRows.length) return toast('No valid rows to import.', 'error');
            try {
                const result = await apiFetch('/employees/import/commit', { method: 'POST', body: JSON.stringify({ rows: validRows }) });
                toast(result.message, 'success');
                G_App.employeeImport.closeModal();
                await G_App.employees.load();
                G_App.ui.updateDashboard();
            } catch (err) {
                toast(err.message, 'error');
            }
        }
    },

    events: {
        load: async () => {
            const search = document.getElementById('events-search') ? document.getElementById('events-search').value : '';
            const status = document.getElementById('events-status-filter') ? document.getElementById('events-status-filter').value : 'all';
            try {
                const params = new URLSearchParams({ search, status, limit: '100' });
                const { data } = await apiFetch(`/events?${params.toString()}`);
                const tbody = document.getElementById('events-table-body');
                if (!tbody) return;
                tbody.innerHTML = data.map(e => `
                    <tr>
                        <td><b>${e.title}</b>${e.recurrence_type === 'weekly' ? ' <span class="badge badge-info" style="font-size:0.6rem;">Recurring</span>' : ''}</td>
                        <td>${e.venue || 'N/A'}</td>
                        <td>${new Date(e.start_datetime).toLocaleString()}</td>
                        <td>${new Date(e.end_datetime).toLocaleString()}</td>
                        <td>${e.recurrence_type === 'weekly' ? `Weekly until ${e.recurrence_end_date || ''}` : 'One-time'}</td>
                        <td>${e.attendance_count}</td>
                        <td><span class="badge badge-${e.computed_status === 'ongoing' ? 'success' : (e.computed_status === 'completed' ? 'danger' : 'warning')}">${e.computed_status}</span></td>
                    </tr>
                `).join('') || '<tr><td colspan="7" style="text-align:center; padding:30px;">No events found.</td></tr>';
                lucide.createIcons();
            } catch (err) { toast(err.message, 'error'); }
        }
    },

    geofence: {
        map: null,
        infoWindow: null,
        polygonLayers: [],       // saved geofences drawn on the map (read-only reference shapes)
        drawnPoints: [],          // vertices of the polygon currently being drawn/edited
        drawMarkers: [],          // click markers for the in-progress polygon
        drawPolygon: null,        // live preview polygon layer for the in-progress shape
        showAll: false,           // false = only the 3 most recently-created events; true = full list
        defaultLocation: null,    // CSPC coordinates, fetched once and cached
        loadAlerts: async () => {
            try {
                const { data } = await apiFetch('/attendance/anomalies?resolved=0');
                G_App.geofence.renderAlerts(data);
            } catch (err) {
                // Non-fatal — the rest of the Geo-Fence module still works without alerts.
            }
        },
        // Read-only: unusual location activity automatically triggers Face
        // Verification on the EMPLOYEE'S OWN device the moment it's detected
        // (see AttendanceTrackingContext.js on the mobile side and
        // detectGeoAnomaly / faceVerify in controllers/attendanceController.js
        // on the backend) -- there is no admin action here by design. This
        // panel exists purely so an admin can see which attendance records
        // are currently waiting on that self-verification and why; the
        // employee's own successful match is what clears it, nothing here.
        renderAlerts: (alerts) => {
            const container = document.getElementById('geofence-alerts');
            if (!alerts.length) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = `
                <div class="card" style="background: #FEF2F2; border-color: #FECACA;">
                    <h3 style="color: var(--danger); font-weight: 800; display:flex; align-items:center; gap:10px; margin-bottom: 6px;">
                        <i data-lucide="alert-triangle"></i> ${alerts.length} Anomaly Alert${alerts.length > 1 ? 's' : ''} — Possible Spoofing/Hacking Detected
                    </h3>
                    <p style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 15px;">Each employee is automatically prompted for Face Verification on their own device — this list clears itself the moment they pass it.</p>
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        ${alerts.map(a => `
                            <div style="background:#fff; border-radius:14px; padding:14px 18px; display:flex; justify-content:space-between; align-items:center; gap:15px; flex-wrap:wrap;">
                                <div>
                                    <strong>${a.full_name}</strong> <span style="color:var(--text-muted); font-size:0.8rem;">(${a.employee_code})</span>
                                    — ${a.event_title || 'Unknown event'}<br>
                                    <span style="color:var(--text-muted); font-size:0.8rem;">${a.details} · ${new Date(a.created_at).toLocaleString()}</span>
                                </div>
                                <span class="badge badge-warning" style="flex-shrink:0;"><i data-lucide="smartphone" size="11"></i> Awaiting employee verification</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            lucide.createIcons();
        },
        // resolveAlert (a plain "mark resolved, no check performed" bypass)
        // was intentionally removed from the UI: resolving an anomaly now
        // only ever happens as a side effect of the employee's own
        // successful Face Verification (controllers/attendanceController.js
        // faceVerify) -- an admin dismissing the ALERT here never actually
        // confirmed the underlying attendance either (that bypass endpoint,
        // PATCH /attendance/anomalies/:id/resolve, only ever touched
        // geo_anomalies.resolved, never attendance.requires_face_verification
        // or verification_status), so it could leave a record silently
        // marked "resolved" while still showing "Awaiting Verification"
        // everywhere else -- exactly the kind of mismatch to avoid.
        init: () => {
            if (!window.google || !window.google.maps) {
                document.getElementById('geo-map').innerHTML =
                    '<div style="display:flex; align-items:center; justify-content:center; height:100%; padding: 30px; text-align:center; color: var(--text-muted); font-weight: 700;">Google Maps failed to load. Check that GOOGLE_MAPS_API_KEY is set in .env and valid.</div>';
                return;
            }
            G_App.geofence.map = new google.maps.Map(document.getElementById('geo-map'), {
                center: { lat: 13.4059, lng: 123.3758 }, // CSPC — overridden below once /default-location resolves
                zoom: 16,
                mapTypeControl: true,
                streetViewControl: false,
                fullscreenControl: false
            });
            G_App.geofence.infoWindow = new google.maps.InfoWindow();
            G_App.geofence.map.addListener('click', (e) => {
                G_App.geofence.addPoint(e.latLng.lat(), e.latLng.lng());
            });
            G_App.geofence.applyMinDate();
            G_App.geofence.fetchDefaultLocation();
            G_App.geofence.load();
        },
        fetchDefaultLocation: async () => {
            try {
                const { data } = await apiFetch('/geofences/default-location');
                G_App.geofence.defaultLocation = data;
                if (G_App.geofence.map) G_App.geofence.map.setCenter({ lat: data.lat, lng: data.lng });
            } catch (err) { /* non-fatal — falls back to the hardcoded CSPC coordinates already set as the map center */ }
        },
        // "Use CSPC Default Location" button — fills the lat/lng fields with CSPC's
        // coordinates (the system's configured default Geo-Fence location).
        useCspcDefault: () => {
            const loc = G_App.geofence.defaultLocation || { lat: 13.4059000, lng: 123.3758000, label: 'CSPC' };
            document.getElementById('gf-lat').value = loc.lat.toFixed(7);
            document.getElementById('gf-lng').value = loc.lng.toFixed(7);
            G_App.geofence.dropCenterMarker(loc.lat, loc.lng);
            G_App.geofence.focusOn(loc.lat, loc.lng);
            if (!document.getElementById('gf-venue').value) document.getElementById('gf-venue').value = loc.label || 'CSPC';
            toast('CSPC default location applied.', 'success');
        },
        onRecurrenceTypeChange: () => {
            const type = document.getElementById('gf-recurrence-type').value;
            document.getElementById('gf-recurrence-fields').classList.toggle('hidden', type !== 'weekly');
        },
        toggleViewAll: () => {
            G_App.geofence.showAll = !G_App.geofence.showAll;
            G_App.geofence.renderList();
        },
        focusOn: (lat, lng) => {
            if (!G_App.geofence.map) return;
            G_App.geofence.map.panTo({ lat: Number(lat), lng: Number(lng) });
            G_App.geofence.map.setZoom(16);
        },
        load: async () => {
            try {
                const { data } = await apiFetch('/geofences');
                G_App.state.geofences = data;
                G_App.geofence.renderList();
                G_App.geofence.updateMapPolygons();
            } catch (err) { toast(err.message, 'error'); }
        },
        centerMarker: null,   // marker showing the manually-typed / centroid lat-lng
        addPoint: (lat, lng) => {
            G_App.geofence.drawnPoints.push({ lat, lng });
            const marker = new google.maps.Marker({
                position: { lat, lng },
                map: G_App.geofence.map,
                icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#0D00A5', fillOpacity: 1, strokeWeight: 0 }
            });
            G_App.geofence.drawMarkers.push(marker);
            G_App.geofence.redrawPreview();
            G_App.geofence.syncCoordFieldsFromPoints();
        },
        undoPoint: () => {
            if (G_App.geofence.drawnPoints.length === 0) return;
            G_App.geofence.drawnPoints.pop();
            const marker = G_App.geofence.drawMarkers.pop();
            if (marker) marker.setMap(null);
            G_App.geofence.redrawPreview();
            G_App.geofence.syncCoordFieldsFromPoints();
        },
        clearPoints: () => {
            G_App.geofence.drawnPoints = [];
            G_App.geofence.drawMarkers.forEach(m => m.setMap(null));
            G_App.geofence.drawMarkers = [];
            G_App.geofence.redrawPreview();
        },
        redrawPreview: () => {
            if (G_App.geofence.drawPolygon) {
                G_App.geofence.drawPolygon.setMap(null);
                G_App.geofence.drawPolygon = null;
            }
            const pts = G_App.geofence.drawnPoints;
            document.getElementById('gf-point-count').innerText = `${pts.length} point${pts.length === 1 ? '' : 's'}`;
            if (pts.length >= 2) {
                G_App.geofence.drawPolygon = new google.maps.Polygon({
                    paths: pts.map(p => ({ lat: p.lat, lng: p.lng })),
                    strokeColor: '#4318FF', strokeWeight: 3, strokeOpacity: 0.9,
                    fillColor: '#4318FF', fillOpacity: 0.15,
                    map: G_App.geofence.map
                });
            }
        },
        // Auto-fills the Latitude/Longitude fields with the centroid of the points drawn so far.
        syncCoordFieldsFromPoints: () => {
            const pts = G_App.geofence.drawnPoints;
            if (pts.length === 0) return;
            const sum = pts.reduce((acc, p) => ({ lat: acc.lat + Number(p.lat), lng: acc.lng + Number(p.lng) }), { lat: 0, lng: 0 });
            document.getElementById('gf-lat').value = (sum.lat / pts.length).toFixed(7);
            document.getElementById('gf-lng').value = (sum.lng / pts.length).toFixed(7);
            G_App.geofence.dropCenterMarker(sum.lat / pts.length, sum.lng / pts.length);
        },
        // Called when the admin manually types into the Latitude/Longitude inputs.
        onCoordInput: () => {
            const lat = parseFloat(document.getElementById('gf-lat').value);
            const lng = parseFloat(document.getElementById('gf-lng').value);
            if (!isNaN(lat) && !isNaN(lng)) G_App.geofence.dropCenterMarker(lat, lng);
        },
        dropCenterMarker: (lat, lng) => {
            if (!G_App.geofence.map) return;
            if (!G_App.geofence.centerMarker) {
                G_App.geofence.centerMarker = new google.maps.Marker({
                    map: G_App.geofence.map,
                    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#05CD99', fillOpacity: 0.9, strokeColor: '#fff', strokeWeight: 2 }
                });
            }
            G_App.geofence.centerMarker.setPosition({ lat, lng });
        },
        // "Preview on Map" button — pans/zooms to the typed coordinates without requiring a click.
        previewCoords: () => {
            const lat = parseFloat(document.getElementById('gf-lat').value);
            const lng = parseFloat(document.getElementById('gf-lng').value);
            if (isNaN(lat) || isNaN(lng)) return toast('Enter a valid latitude and longitude first.', 'error');
            G_App.geofence.dropCenterMarker(lat, lng);
            G_App.geofence.focusOn(lat, lng);
        },
        // "Use My Location" button — fills the fields from the browser's geolocation.
        useMyLocation: () => {
            if (!navigator.geolocation) return toast('Geolocation is not supported by this browser.', 'error');
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    document.getElementById('gf-lat').value = pos.coords.latitude.toFixed(7);
                    document.getElementById('gf-lng').value = pos.coords.longitude.toFixed(7);
                    G_App.geofence.dropCenterMarker(pos.coords.latitude, pos.coords.longitude);
                    G_App.geofence.focusOn(pos.coords.latitude, pos.coords.longitude);
                },
                () => toast('Could not get your current location.', 'error')
            );
        },
        // Formats "now" (or any Date) as a "YYYY-MM-DDTHH:MM" string in the
        // browser's *local* time, matching what <input type="datetime-local">
        // reads/writes. Used as the `min` attribute so the native picker
        // simply won't offer past dates/times, and as a belated safety check
        // in save() for browsers/paths that bypass the picker.
        localDatetimeString: (d = new Date()) => {
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        },
        // Locks the "Start Date/Time" (and, for a brand-new event, the "Repeat
        // Until" date) so the calendar/time picker can't select a moment
        // that's already in the past. Called whenever the form is opened for
        // a NEW event (clearForm / first load) — editing an existing event
        // keeps whatever schedule it already has.
        applyMinDate: () => {
            const nowStr = G_App.geofence.localDatetimeString();
            const startInput = document.getElementById('gf-start');
            const recurEndInput = document.getElementById('gf-recurrence-end');
            if (startInput) startInput.min = nowStr;
            if (recurEndInput) recurEndInput.min = nowStr.slice(0, 10);
        },
        save: async () => {
            const id = document.getElementById('gf-id').value;
            const lat = document.getElementById('gf-lat').value;
            const lng = document.getElementById('gf-lng').value;
            const recurrenceType = document.getElementById('gf-recurrence-type').value;
            const recurrenceDays = Array.from(document.querySelectorAll('#gf-weekday-picker input:checked')).map(el => el.value).join(',');
            const payload = {
                title: document.getElementById('gf-title').value,
                venue: document.getElementById('gf-venue').value,
                start: document.getElementById('gf-start').value,
                end: document.getElementById('gf-end').value,
                points: G_App.geofence.drawnPoints,
                center_lat: lat !== '' ? Number(lat) : null,
                center_lng: lng !== '' ? Number(lng) : null,
                recurrence_type: recurrenceType,
                recurrence_days: recurrenceDays,
                recurrence_end_date: document.getElementById('gf-recurrence-end').value || null
            };
            if (!payload.title || !payload.start || !payload.end) {
                return toast('Complete the event name and schedule.', 'error');
            }
            // Only brand-new events are blocked from starting in the past —
            // editing an already-scheduled/past event shouldn't be forced to
            // move its date just to save an unrelated change.
            if (!id && payload.start < G_App.geofence.localDatetimeString()) {
                return toast('The event start date/time can\'t be in the past.', 'error');
            }
            if (payload.end < payload.start) {
                return toast('The end date/time can\'t be before the start.', 'error');
            }
            if (payload.points.length < 3) {
                return toast('Click at least 3 points on the map to draw the boundary polygon.', 'error');
            }
            if (payload.center_lat === null || payload.center_lng === null) {
                return toast('Enter the Latitude and Longitude of the geofence center.', 'error');
            }
            if (recurrenceType === 'weekly' && (!recurrenceDays || !payload.recurrence_end_date)) {
                return toast('Pick at least one weekday and a "Repeat Until" date for a recurring schedule.', 'error');
            }
            try {
                if (id) {
                    await apiFetch(`/geofences/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
                } else {
                    await apiFetch('/geofences', { method: 'POST', body: JSON.stringify(payload) });
                }
                G_App.geofence.clearForm();
                await G_App.geofence.load();
                toast('Protocol saved successfully.', 'success');
                // Only refresh the Dashboard's charts/stats if that page is
                // actually the visible view — refreshing it while on the
                // Geo-Fences page reaches into hidden canvases and can throw
                // (e.g. Chart.js "destroy is not a function" if a chart on a
                // display:none canvas wasn't fully constructed the first time).
                const dashboardView = document.getElementById('dashboard');
                if (dashboardView && dashboardView.classList.contains('active')) {
                    G_App.ui.updateDashboard();
                }
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        edit: (id) => {
            const gf = G_App.state.geofences.find(g => g.id == id);
            if (!gf) return;
            document.getElementById('gf-form-title').innerText = 'Edit Boundary Protocol';
            document.getElementById('gf-id').value = gf.id;
            document.getElementById('gf-title').value = gf.title;
            document.getElementById('gf-venue').value = gf.venue || '';
            // Editing an existing (possibly already past) event shouldn't be
            // blocked by the "no past dates" lock that applies to new events.
            document.getElementById('gf-start').removeAttribute('min');
            document.getElementById('gf-recurrence-end').removeAttribute('min');
            document.getElementById('gf-start').value = (gf.start_datetime || '').replace(' ', 'T').slice(0, 16);
            document.getElementById('gf-end').value = (gf.end_datetime || '').replace(' ', 'T').slice(0, 16);
            document.getElementById('gf-lat').value = gf.center_lat != null ? Number(gf.center_lat).toFixed(7) : '';
            document.getElementById('gf-lng').value = gf.center_lng != null ? Number(gf.center_lng).toFixed(7) : '';
            document.getElementById('btn-gf-cancel').classList.remove('hidden');
            document.getElementById('btn-gf-save').innerHTML = '<i data-lucide="save"></i> Update Protocol';
            lucide.createIcons();

            // Load the existing polygon onto the map so it can be redrawn/adjusted.
            G_App.geofence.clearPoints();
            (gf.points || []).forEach(p => G_App.geofence.addPoint(p.lat, p.lng));

            if (gf.center_lat && gf.center_lng) {
                G_App.geofence.dropCenterMarker(gf.center_lat, gf.center_lng);
                G_App.geofence.focusOn(gf.center_lat, gf.center_lng);
            }
        },
        delete: async (id) => {
            if (!confirm('Terminate this Geo-Fence protocol?')) return;
            try {
                await apiFetch(`/geofences/${id}`, { method: 'DELETE' });
                await G_App.geofence.load();
                toast('Geofence terminated.', 'success');
            } catch (err) { toast(err.message, 'error'); }
        },
        clearForm: () => {
            document.getElementById('gf-form-title').innerText = 'Boundary Protocol';
            ['gf-id', 'gf-title', 'gf-venue', 'gf-start', 'gf-end', 'gf-lat', 'gf-lng'].forEach(id => document.getElementById(id).value = '');
            document.getElementById('gf-recurrence-type').value = 'none';
            document.getElementById('gf-recurrence-end').value = '';
            // Fresh "new event" form — re-lock the pickers so a past date can't be chosen.
            G_App.geofence.applyMinDate();
            document.querySelectorAll('#gf-weekday-picker input:checked').forEach(el => el.checked = false);
            document.getElementById('gf-recurrence-fields').classList.add('hidden');
            document.getElementById('btn-gf-cancel').classList.add('hidden');
            document.getElementById('btn-gf-save').innerHTML = '<i data-lucide="shield-check"></i> Initialize Protocol';
            G_App.geofence.clearPoints();
            if (G_App.geofence.centerMarker) {
                G_App.geofence.centerMarker.setMap(null);
                G_App.geofence.centerMarker = null;
            }
            lucide.createIcons();
        },
        updateMapPolygons: () => {
            G_App.geofence.polygonLayers.forEach(layer => layer.setMap(null));
            G_App.geofence.polygonLayers = [];
            G_App.state.geofences.forEach(gf => {
                if (!gf.points || gf.points.length < 3) return;
                const polygon = new google.maps.Polygon({
                    paths: gf.points.map(p => ({ lat: p.lat, lng: p.lng })),
                    strokeColor: gf.computed_status === 'active' ? '#05CD99' : '#0D00A5',
                    strokeWeight: 2, strokeOpacity: 0.9,
                    fillColor: gf.computed_status === 'active' ? '#05CD99' : '#0D00A5',
                    fillOpacity: 0.12,
                    map: G_App.geofence.map
                });
                polygon.addListener('click', (e) => {
                    G_App.geofence.infoWindow.setContent(`<b>${gf.title}</b><br>${gf.venue || ''}`);
                    G_App.geofence.infoWindow.setPosition(e.latLng);
                    G_App.geofence.infoWindow.open(G_App.geofence.map);
                });
                G_App.geofence.polygonLayers.push(polygon);
            });
        },
        renderList: () => {
            const all = G_App.state.geofences || [];
            const visible = G_App.geofence.showAll ? all : all.slice(0, 3);
            document.getElementById('geofence-list-title').innerText = G_App.geofence.showAll ? `All Events (${all.length})` : 'Recent Events';
            document.getElementById('geofence-view-all-link').innerText = G_App.geofence.showAll ? 'Show Recent' : 'View All';
            document.getElementById('geofence-list').innerHTML = visible.map(gf => `
                <div class="card" style="padding:15px; background:var(--bg-body); margin-bottom: 5px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div onclick="G_App.geofence.focusOn(${gf.center_lat},${gf.center_lng})" style="cursor:pointer; flex: 1;">
                            <h5 style="font-weight:800; color:var(--primary)">${gf.title} <span class="badge badge-${gf.computed_status === 'active' ? 'success' : (gf.computed_status === 'expired' ? 'danger' : 'warning')}">${gf.computed_status}</span>
                                ${gf.recurrence_type === 'weekly' ? '<span class="badge badge-info" title="Recurring event"><i data-lucide=\'repeat\' size=\'10\'></i> Recurring</span>' : ''}
                            </h5>
                            <div style="font-size:0.7rem; color:var(--text-muted)">${gf.venue || 'No Venue'} · ${(gf.points || []).length} boundary points</div>
                            <div style="font-size:0.65rem; color:var(--text-muted); margin-top:5px;">${gf.start_datetime} → ${gf.end_datetime}</div>
                        </div>
                        <div style="display:flex; gap:5px;">
                            <button class="btn-icon btn-edit" onclick="G_App.geofence.edit('${gf.id}')"><i data-lucide="edit-2" size="12"></i></button>
                            <button class="btn-icon btn-delete" onclick="G_App.geofence.delete('${gf.id}')"><i data-lucide="trash-2" size="12"></i></button>
                        </div>
                    </div>
                </div>
            `).join('') || '<p style="color:var(--text-muted); font-size:0.8rem; text-align:center; padding: 20px 0;">No events yet.</p>';
            lucide.createIcons();
        }
    },

    attendance: {
        currentEventId: null,
        currentEventTitle: null,
        sessionsCache: {}, // attendance_id -> sessions array, cached per detail view
        render: async () => {
            try {
                const { data } = await apiFetch('/attendance/by-event');
                const folders = document.getElementById('attendance-folders');
                folders.innerHTML = data.map(e => `
                    <div class="card" onclick="G_App.attendance.openEvent(${e.id}, '${(e.title || '').replace(/'/g, "\\'")}')" style="cursor:pointer; text-align:center; padding: 40px;">
                        <i data-lucide="calendar-check" size="60" style="color:#FFB547; margin-bottom: 15px;"></i>
                        <h3 style="font-weight:800; color:var(--primary);">${e.title}</h3>
                        <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 5px;">
                            <p style="color:var(--text-muted); font-size: 0.85rem; font-weight: 700;">
                                Attendance Logs: <span style="color:var(--primary); font-size: 1.1rem;">${e.log_count}</span>
                            </p>
                            <p style="color:var(--text-muted); font-size: 0.75rem;">${new Date(e.start_datetime).toLocaleDateString()} · ${e.venue || 'No venue'}</p>
                            <span class="badge badge-${e.computed_status === 'ongoing' ? 'success' : (e.computed_status === 'completed' ? 'danger' : 'warning')}" style="align-self:center;">${e.computed_status}</span>
                        </div>
                    </div>
                `).join('') || '<p style="color:var(--text-muted); grid-column: 1/-1; text-align:center; padding: 40px;">No events yet. Create one from Geo-Fences.</p>';
                lucide.createIcons();
            } catch (err) { toast(err.message, 'error'); }
        },
        openEvent: async (eventId, eventTitle) => {
            G_App.attendance.currentEventId = eventId;
            G_App.attendance.currentEventTitle = eventTitle;
            G_App.attendance.sessionsCache = {};
            document.getElementById('attendance-root').classList.add('hidden');
            document.getElementById('attendance-detail').classList.remove('hidden');
            document.getElementById('current-dept-title').innerText = eventTitle;
            const searchInput = document.getElementById('attendance-detail-search');
            if (searchInput) searchInput.value = '';
            G_App.attendance.populateDepartmentFilter();
            const deptSel = document.getElementById('attendance-detail-department');
            const statusSel = document.getElementById('attendance-detail-status');
            const sortSel = document.getElementById('attendance-detail-sort');
            if (deptSel) deptSel.value = 'all';
            if (statusSel) statusSel.value = 'all';
            if (sortSel) sortSel.value = 'default';
            await G_App.attendance.loadDetail();
        },
        // Fills the Department filter with whatever departments exist, so
        // an admin can narrow a single event's attendance down to just one
        // department's employees.
        populateDepartmentFilter: () => {
            const deptSel = document.getElementById('attendance-detail-department');
            if (!deptSel) return;
            const previous = deptSel.value || 'all';
            const departments = G_App.state.departments || [];
            deptSel.innerHTML = '<option value="all">All Departments</option>' +
                departments.map(d => `<option value="${d.name}">${d.name}</option>`).join('');
            deptSel.value = departments.some(d => d.name === previous) || previous === 'all' ? previous : 'all';
        },
        // Re-fetches and re-renders the currently-open event's table in place —
        // used both by openEvent and by the auto-refresh loop, so a live event's
        // logs update on their own without the admin needing to reopen it.
        // Also applied whenever the Department/Status/Sort filters change.
        loadDetail: async () => {
            if (!G_App.attendance.currentEventId) return;
            try {
                const deptSel = document.getElementById('attendance-detail-department');
                const statusSel = document.getElementById('attendance-detail-status');
                const sortSel = document.getElementById('attendance-detail-sort');
                const department = deptSel ? deptSel.value : 'all';
                const status = statusSel ? statusSel.value : 'all';
                const sort = sortSel ? sortSel.value : 'default';

                const params = new URLSearchParams({ event_id: G_App.attendance.currentEventId });
                if (department && department !== 'all') params.set('department', department);
                if (status && status !== 'all') params.set('status', status);

                const { data } = await apiFetch(`/attendance?${params.toString()}`);
                if (sort === 'name_asc') data.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
                else if (sort === 'name_desc') data.sort((a, b) => (b.full_name || '').localeCompare(a.full_name || ''));

                const tbody = document.getElementById('attendance-dept-table');
                tbody.innerHTML = data.map(log => `
                    <tr>
                        <td><b>${log.full_name}</b></td>
                        <td>${log.department_name || 'N/A'}</td>
                        <td>${log.attendance_date}</td>
                        <td>${G_App.attendance.timeSessionCell(log)}</td>
                        <td>${G_App.attendance.durationCell(log)}</td>
                        <td>${G_App.attendance.methodCell(log)}</td>
                        <td>${log.longitude ?? '--'}</td>
                        <td>${log.latitude ?? '--'}</td>
                        <td>${G_App.attendance.faceVerificationCell(log)}</td>
                        <td><span class="badge badge-${log.attendance_status === 'Present' ? 'success' : (log.attendance_status === 'Late' ? 'warning' : 'danger')}">${log.attendance_status}</span></td>
                    </tr>
                `).join('') || '<tr><td colspan="10" style="text-align:center; padding:30px;">No attendance logs found for this event.</td></tr>';
                lucide.createIcons();
                const searchInput = document.getElementById('attendance-detail-search');
                if (searchInput && searchInput.value) G_App.attendance.filterDetail(searchInput.value);
            } catch (err) { toast(err.message, 'error'); }
        },
        filterDetail: (q) => {
            const rows = document.querySelectorAll('#attendance-dept-table > tr');
            rows.forEach(r => r.style.display = r.innerText.toLowerCase().includes(q.toLowerCase()) ? '' : 'none');
        },
        // Time Started / Time Ended, with a dropdown when the employee entered
        // and left the geofence more than once — each boundary crossing (its
        // own time-in/time-out pair) is a separate row in attendance_sessions,
        // so a single "Time Started"/"Time Ended" pair can't represent all of
        // them. With one session, the pair is shown directly; with more than
        // one, a dropdown reveals every individual dip.
        // OCR/Face-verified rows are a single roll-call instant, not a
        // time-in/time-out cycle, so they just show when the verification
        // happened instead of a (misleading, always-identical) in→out pair.
        timeSessionCell: (log) => {
            if (log.verification_method === 'ocr' || log.verification_method === 'face') {
                return `<span style="font-weight:700;">${log.time_in ? new Date(log.time_in).toLocaleTimeString() : '--'}</span>`;
            }
            const single = `
                <div><span style="color:var(--success); font-weight:700;">${log.time_in ? new Date(log.time_in).toLocaleTimeString() : '--'}</span>
                <span style="color:var(--text-muted); margin:0 4px;">→</span>
                <span style="color:var(--danger); font-weight:700;">${log.time_out ? new Date(log.time_out).toLocaleTimeString() : '--'}</span>${log.auto_ended ? ' <span class="badge badge-info" style="font-size:0.6rem;">Auto</span>' : ''}</div>
            `;
            if (!(log.session_count > 1)) return single;
            const cellId = `sessions-${log.id}`;
            return `
                <button class="btn-primary" style="padding:6px 12px; font-size:0.7rem; background:var(--primary-light); color:var(--primary);" onclick="G_App.attendance.toggleSessions(${log.id})">
                    <i data-lucide="chevron-down" size="12"></i> <span id="${cellId}-label">${log.session_count} time-in/time-out pairs</span>
                </button>
                <div id="${cellId}" class="hidden" style="margin-top:8px; display:flex; flex-direction:column; gap:6px;"></div>
            `;
        },
        toggleSessions: async (attendanceId) => {
            const wrap = document.getElementById(`sessions-${attendanceId}`);
            const label = document.getElementById(`sessions-${attendanceId}-label`);
            if (!wrap) return;
            const opening = wrap.classList.contains('hidden');
            wrap.classList.toggle('hidden');
            if (!opening) return;
            label.innerText = 'Loading…';
            try {
                if (!G_App.attendance.sessionsCache[attendanceId]) {
                    const { data } = await apiFetch(`/attendance/${attendanceId}/sessions/admin`);
                    G_App.attendance.sessionsCache[attendanceId] = data;
                }
                const sessions = G_App.attendance.sessionsCache[attendanceId];
                wrap.innerHTML = sessions.map((s, i) => `
                    <div style="display:flex; justify-content:space-between; gap:10px; background:var(--bg-body); border-radius:8px; padding:6px 10px; font-size:0.75rem;">
                        <span style="font-weight:700;">#${i + 1}</span>
                        <span style="color:var(--success);">${s.time_in ? new Date(s.time_in).toLocaleTimeString() : '--'}</span>
                        <span>→</span>
                        <span style="color:var(--danger);">${s.time_out ? new Date(s.time_out).toLocaleTimeString() : 'Still in'}</span>
                        ${s.auto_ended ? '<span class="badge badge-info" style="font-size:0.6rem;">Auto</span>' : ''}
                    </div>
                `).join('');
                label.innerText = `${sessions.length} time-in/time-out pairs`;
            } catch (err) {
                label.innerText = 'Failed to load sessions';
            }
        },
        // Accumulated duration across every time-in/time-out session for the
        // day (an employee can leave/re-enter the event's geofence multiple
        // times while it's still running — see total_duration_seconds /
        // open_session_time_in from the API). Keeps counting up live while
        // still on-going instead of freezing at the last known total.
        // OCR/Face verification is a one-time roll-call confirmation with no
        // ongoing presence to measure, so it has no duration at all.
        durationCell: (log) => {
            if (log.verification_method === 'ocr' || log.verification_method === 'face') {
                return '<span style="color:var(--text-muted);">N/A</span>';
            }
            const base = Number(log.total_duration_seconds) || 0;
            let seconds = base;
            if (log.open_session_time_in) {
                const openedAt = new Date(log.open_session_time_in).getTime();
                if (!isNaN(openedAt)) seconds = base + Math.max(0, (Date.now() - openedAt) / 1000);
            }
            const totalSeconds = Math.max(0, Math.round(seconds));
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
            const color = log.time_out ? 'var(--text-main)' : 'var(--warning)';
            return `<span style="font-weight:700; color:${color};">${label}</span>`;
        },
        // How this row's time-in was captured — the normal mobile app + GPS
        // flow, or an admin-run alternative at the Verification kiosk (ID
        // card OCR scan, or live selfie) for an employee without their
        // phone/ID. See migration_v14 / controllers/attendanceController.js
        // (recordVerificationAttendance). An employee's own automatic
        // on-device re-verification after an anomaly flag (faceVerify())
        // doesn't change this -- it's layered on top of whatever the
        // attendance was already recorded as (almost always mobile_gps,
        // still a real GPS session); see faceVerificationCell() below for
        // how the admin sees THAT.
        methodCell: (log) => {
            const methods = {
                mobile_gps: { label: 'Mobile GPS', icon: 'smartphone', badge: 'info' },
                ocr: { label: 'ID Verification', icon: 'scan-text', badge: 'warning' },
                face: { label: 'Face Verification', icon: 'scan-face', badge: 'warning' }
            };
            const m = methods[log.verification_method] || methods.mobile_gps;
            return `<span class="badge badge-${m.badge}" style="display:inline-flex;align-items:center;gap:4px;"><i data-lucide="${m.icon}" size="11"></i> ${m.label}</span>`;
        },
        faceVerificationCell: (log) => {
            if (!log.selfie_path) {
                return log.requires_face_verification
                    ? '<span class="badge badge-danger">Awaiting Verification</span>'
                    : '<span style="color:var(--text-muted); font-size:0.8rem;">Not required</span>';
            }
            const cellId = `face-photo-${log.id}`;
            const locLabel = (log.selfie_lat && log.selfie_lng) ? `${Number(log.selfie_lat).toFixed(5)}, ${Number(log.selfie_lng).toFixed(5)}` : 'No location';
            return `
                <button class="btn-primary" style="padding:8px 14px; font-size:0.75rem;" onclick="G_App.attendance.toggleFacePhoto('${cellId}')">
                    <i data-lucide="eye" size="14"></i> <span id="${cellId}-label">View</span>
                </button>
                <div id="${cellId}" class="hidden" style="margin-top:10px;">
                    <img src="${log.selfie_path}" style="width:120px; height:120px; object-fit:cover; border-radius:12px; border:1px solid var(--border);">
                    <p style="font-size:0.7rem; color:var(--text-muted); margin-top:5px; max-width:120px;"><i data-lucide="map-pin" size="10"></i> ${locLabel}</p>
                </div>
            `;
        },
        toggleFacePhoto: (cellId) => {
            const el = document.getElementById(cellId);
            const label = document.getElementById(`${cellId}-label`);
            el.classList.toggle('hidden');
            label.innerText = el.classList.contains('hidden') ? 'View' : 'Hide';
        },
        goBack: () => {
            document.getElementById('attendance-root').classList.remove('hidden');
            document.getElementById('attendance-detail').classList.add('hidden');
            G_App.attendance.currentEventId = null;
        },
        generateReport: () => {
            window.open(`${API}/reports/export/csv?event_id=${encodeURIComponent(G_App.attendance.currentEventId)}&token=${localStorage.getItem('ga_token')}`, '_blank');
        }
    },

    reports: {
        // Attendance-insights state. The Most/Minimum choice and the expanded
        // office rows survive a re-sort, so flipping the order doesn't collapse
        // what the admin already opened.
        insightsOrder: 'most',
        insightsOpen: new Set(),
        insights: null,
        insightsRequestId: 0,
        // Filters of the report currently on screen. The insights controls
        // re-rank these, not whatever the form was changed to afterwards.
        lastParams: null,
        monthNames: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],

        init: () => {
            const empSel = document.getElementById('rpt-employee');
            empSel.innerHTML = '<option value="all">All Personnel</option>' +
                G_App.state.employees.map(e => `<option value="${e.id}">${e.full_name}</option>`).join('');
            G_App.reports.loadEventFilter();
        },
        // Populated once (like the Dashboard's own event filter) — cheap, and
        // the list rarely changes mid-session.
        loadEventFilter: async () => {
            const sel = document.getElementById('rpt-event');
            if (!sel || sel.dataset.loaded) return;
            try {
                const { data } = await apiFetch('/events?limit=100&status=all');
                sel.innerHTML = '<option value="all">All Events</option>' +
                    data.map(e => `<option value="${e.id}" data-start="${escapeHtml(e.start_datetime)}">${escapeHtml(e.title)} — ${new Date(e.start_datetime).toLocaleDateString()}</option>`).join('');
                sel.dataset.loaded = '1';
            } catch (err) { /* non-fatal */ }
        },
        // Picking one event moves Year/Month to that event's date, so the
        // report and insights don't come back empty from a mismatched period.
        syncPeriodToEvent: () => {
            const option = document.getElementById('rpt-event').selectedOptions[0];
            const start = option && option.dataset.start; // "YYYY-MM-DD HH:MM:SS"
            if (!start) return;
            const year = start.slice(0, 4);
            const yearSel = document.getElementById('rpt-year');
            if (![...yearSel.options].some(o => o.value === year)) {
                const later = [...yearSel.options].find(o => Number(o.value) > Number(year));
                yearSel.add(new Option(year, year), later || null);
            }
            yearSel.value = year;
            document.getElementById('rpt-month').value = String(Number(start.slice(5, 7)) - 1);
        },
        buildParams: () => new URLSearchParams({
            department: document.getElementById('rpt-dept').value,
            year: document.getElementById('rpt-year').value,
            month: document.getElementById('rpt-month').value,
            employee_id: document.getElementById('rpt-employee').value,
            event_id: document.getElementById('rpt-event').value,
            status: document.getElementById('rpt-status').value
        }),
        generate: async () => {
            const btn = document.getElementById('rpt-generate-btn');
            const originalLabel = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i data-lucide="loader" size="16"></i> Generating…';
            lucide.createIcons();
            const params = G_App.reports.buildParams();
            G_App.reports.lastParams = params;
            G_App.reports.insightsOpen = new Set();
            try {
                // Insights first: that request also settles attendance left open
                // past an event's end, so the records below show final statuses.
                await G_App.reports.loadInsights({ openSelectedOffice: true });

                const { data, summary } = await apiFetch(`/reports?${params.toString()}`);
                document.getElementById('report-results').classList.remove('hidden');
                document.getElementById('rpt-res-subtitle').innerText =
                    `${summary.total} records — ${summary.present} present, ${summary.late} late, ${summary.absent} absent`;

                document.getElementById('rpt-sum-total').innerText = summary.total;
                document.getElementById('rpt-sum-present').innerText = summary.present;
                document.getElementById('rpt-sum-late').innerText = summary.late;
                document.getElementById('rpt-sum-absent').innerText = summary.absent;

                const tbody = document.getElementById('report-table-body');
                tbody.innerHTML = data.length ? data.map(log => `
                    <tr>
                        <td>${log.attendance_date}</td>
                        <td>${log.full_name}</td>
                        <td>${log.department_name}</td>
                        <td><span class="badge badge-${log.attendance_status === 'Present' ? 'success' : (log.attendance_status === 'Late' ? 'warning' : 'danger')}">${log.attendance_status}</span></td>
                        <td>${log.late_minutes || 0}</td>
                    </tr>
                `).join('') : '<tr><td colspan="5" style="text-align:center; padding:40px;">No records found for this criteria.</td></tr>';
            } catch (err) {
                toast(err.message, 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalLabel;
                lucide.createIcons();
            }
        },
        exportFile: (format) => {
            const params = G_App.reports.buildParams();
            params.set('token', localStorage.getItem('ga_token'));
            window.open(`${API}/reports/export/${format}?${params.toString()}`, '_blank');
        },

        // ---- Attendance insights: offices/colleges ranked by attendance ----
        // Data: GET /api/reports/insights (controllers/reportController.js getInsights).
        // "Most attendance" lists offices highest first, "Minimum attendance"
        // lowest first; each office expands into the employees involved.
        setInsightsOrder: (order) => {
            if (G_App.reports.insightsOrder === order) return;
            G_App.reports.insightsOrder = order;
            ['most', 'least'].forEach(o => {
                const button = document.getElementById(`ins-order-${o}`);
                button.classList.toggle('active', o === order);
                button.setAttribute('aria-pressed', String(o === order));
            });
            if (G_App.reports.lastParams) G_App.reports.loadInsights();
        },
        // Never throws: failures show inside the panel so the rest of the
        // report still renders.
        loadInsights: async ({ openSelectedOffice = false } = {}) => {
            const R = G_App.reports;
            const list = document.getElementById('ins-list');
            const params = new URLSearchParams(R.lastParams || R.buildParams());
            params.set('order', R.insightsOrder);
            params.set('rank_by', document.getElementById('ins-rank-by').value);
            const requestId = ++R.insightsRequestId;
            list.setAttribute('aria-busy', 'true');
            if (!R.insights) list.innerHTML = '<div class="ins-empty">Loading attendance insights…</div>';
            try {
                const payload = await apiFetch(`/reports/insights?${params.toString()}`);
                if (requestId !== R.insightsRequestId) return; // a newer request (e.g. a quick toggle) replaced this one
                R.insights = payload;
                if (openSelectedOffice) {
                    const match = payload.data.find(d => d.department === params.get('department') && d.employees.length);
                    if (match) R.insightsOpen.add(match.department_id);
                }
                R.renderInsights();
            } catch (err) {
                if (requestId !== R.insightsRequestId) return;
                R.insights = null;
                document.getElementById('ins-summary').innerHTML = '';
                document.getElementById('ins-count').innerText = '';
                document.getElementById('ins-expand-all').classList.add('hidden');
                list.innerHTML = `<div class="ins-empty">Couldn't load attendance insights: ${escapeHtml(err.message)}<br><button type="button" class="ins-link" onclick="G_App.reports.loadInsights()">Try again</button></div>`;
            } finally {
                if (requestId === R.insightsRequestId) list.removeAttribute('aria-busy');
            }
        },
        pct: (value) => (value === null || value === undefined) ? '—' : `${Number.isInteger(Number(value)) ? Number(value) : Number(value).toFixed(1)}%`,
        plural: (count, one, many) => `${count} ${count === 1 ? one : (many || `${one}s`)}`,
        rateColor: (rate) => rate >= 80 ? 'var(--success)' : (rate >= 50 ? 'var(--warning)' : 'var(--danger)'),
        // MySQL DATETIME strings ("YYYY-MM-DD HH:MM:SS") read as local time in every browser.
        parseDbDate: (value) => value ? new Date(String(value).replace(' ', 'T')) : null,
        statusBadge: (status) => {
            const tone = { Present: 'success', Late: 'warning', Excused: 'info', Absent: 'danger' }[status] || 'muted';
            return `<span class="badge badge-${tone}">${escapeHtml(status)}</span>`;
        },
        describeInsightsScope: (payload) => {
            const R = G_App.reports;
            const { scope } = payload;
            const sentences = [];
            if (scope.event) {
                const start = R.parseDbDate(scope.event.start_datetime);
                let text = `${scope.event.title}, ${start.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`;
                if (scope.event.department_name) text += ` (${scope.event.department_name} only)`;
                sentences.push(`${text}.`);
                if (scope.event.ongoing) sentences.push('Still ongoing, so these numbers will change.');
            } else {
                const month = R.lastParams.get('month');
                const year = R.lastParams.get('year');
                const period = month && month !== 'all' ? `${R.monthNames[Number(month)]} ${year}` : year;
                let text = `${R.plural(scope.event_count, 'event')} in ${period}`;
                if (scope.ongoing_count) text += `, ${scope.ongoing_count} still ongoing`;
                sentences.push(`${text}.`);
            }
            if (scope.upcoming_count) {
                sentences.push(`${R.plural(scope.upcoming_count, 'upcoming event')} ${scope.upcoming_count === 1 ? 'isn\'t' : 'aren\'t'} counted yet.`);
            }
            return sentences.join(' ');
        },
        insightsSummaryHtml: (payload) => {
            const R = G_App.reports;
            const { overall, scope, highlights: { highest, lowest } } = payload;
            const byCount = payload.rank_by === 'count';
            const figures = (d) => byCount ? `${d.attended} of ${d.expected} (${R.pct(d.rate)})` : `${R.pct(d.rate)} (${d.attended} of ${d.expected})`;
            const overallText = `Overall attendance is <b>${R.pct(overall.rate)}</b>: ${overall.attended} of ${R.plural(overall.expected, scope.event ? 'expected employee' : 'expected attendance')}.`;
            if (!highest) return overallText;
            if (overall.departments_ranked === 1) {
                return `<b>${escapeHtml(highest.department)}</b> is the only office with employees expected: ${figures(highest)}. ${overallText}`;
            }
            const metric = (d) => byCount ? d.attended : d.rate;
            if (metric(highest) === metric(lowest)) {
                return `All ${overall.departments_ranked} offices and colleges are tied at ${byCount ? `${highest.attended} attended` : R.pct(highest.rate)}. ${overallText}`;
            }
            const top = `<b>${escapeHtml(highest.department)}</b> has the ${byCount ? 'most attendees' : 'highest attendance'}: ${figures(highest)}.`;
            const bottom = `<b>${escapeHtml(lowest.department)}</b> has the ${byCount ? 'fewest attendees' : 'lowest attendance'}: ${figures(lowest)}.`;
            return `${R.insightsOrder === 'most' ? `${top} ${bottom}` : `${bottom} ${top}`} ${overallText}`;
        },
        renderInsights: () => {
            const R = G_App.reports;
            const payload = R.insights;
            if (!payload) return;
            const { scope, data } = payload;
            const list = document.getElementById('ins-list');
            const summaryEl = document.getElementById('ins-summary');
            const countEl = document.getElementById('ins-count');

            if (!scope.event_count) {
                const oneEvent = R.lastParams.get('event_id') && R.lastParams.get('event_id') !== 'all';
                let message = 'No events match these filters. If you picked an event, check that Year and Month match its date.';
                if (scope.events_matched) {
                    message = oneEvent
                        ? 'This event hasn\'t started yet. Its attendance insights appear once it begins.'
                        : `None of the ${R.plural(scope.events_matched, 'event')} in this period ${scope.events_matched === 1 ? 'has' : 'have'} started yet.`;
                }
                document.getElementById('ins-scope').innerText = 'No events counted.';
                summaryEl.innerHTML = '';
                countEl.innerText = '';
                document.getElementById('ins-expand-all').classList.add('hidden');
                list.innerHTML = `<div class="ins-empty">${message}</div>`;
                return;
            }

            document.getElementById('ins-scope').innerText = R.describeInsightsScope(payload);
            summaryEl.innerHTML = R.insightsSummaryHtml(payload);
            const rankedCount = data.filter(d => d.rank !== null).length;
            countEl.innerText = `${R.plural(rankedCount, 'office or college', 'offices and colleges')}, ${R.insightsOrder === 'most' ? 'highest' : 'lowest'} attendance first`;

            const selectedOffice = R.lastParams.get('department');
            list.innerHTML = data.length
                ? data.map(d => R.insightRowHtml(d, payload, selectedOffice)).join('')
                : '<div class="ins-empty">Add departments to see attendance by office.</div>';
            data.forEach(d => { if (R.insightsOpen.has(d.department_id)) R.renderInsightEmployees(d.department_id); });
            R.updateExpandAllLabel();
            lucide.createIcons();
        },
        insightRowHtml: (d, payload, selectedOffice) => {
            const R = G_App.reports;
            const single = !!payload.scope.event;
            const isOpen = R.insightsOpen.has(d.department_id);
            const isSelected = selectedOffice && selectedOffice !== 'all' && d.department === selectedOffice;
            const classes = ['ins-row', isSelected && 'is-selected', d.rank === null && 'is-unranked', isOpen && 'is-open'].filter(Boolean).join(' ');
            const name = `<span class="ins-dept-name">${escapeHtml(d.department)}${isSelected ? ' <span class="badge badge-info">Selected office</span>' : ''}</span>`;

            if (d.rank === null) {
                return `
                    <div class="${classes}">
                        <div class="ins-row-main">
                            <span class="ins-rank">–</span>
                            <span>${name}<span class="ins-meta">No employees expected at ${single ? 'this event' : 'these events'}</span></span>
                            <span class="ins-figure"><span class="ins-rate">—</span></span>
                        </div>
                    </div>`;
            }

            const stats = [
                ['present', 'present', 'var(--success)'],
                ['late', 'late', 'var(--warning)'],
                ['excused', 'excused', '#4338CA'],
                ['absent', 'absent', 'var(--danger)'],
                ['no_time_in', 'no time-in', 'var(--text-muted)']
            ].filter(([key]) => d.breakdown[key] > 0)
                .map(([key, label, color]) => `<span class="ins-stat"><i class="ins-dot" style="background:${color};"></i>${d.breakdown[key]} ${label}</span>`)
                .join('');
            const attendedText = single
                ? `<b>${d.attended}</b> of ${R.plural(d.expected, 'employee')} attended`
                : `<b>${d.attended}</b> of ${R.plural(d.expected, 'expected attendance')}, ${R.plural(d.employees_involved, 'employee')}`;
            const figure = payload.rank_by === 'count'
                ? `${d.attended}<small>attended</small>`
                : `${R.pct(d.rate)}<small>attendance</small>`;
            return `
                <div class="${classes}" id="ins-row-${d.department_id}">
                    <button type="button" class="ins-row-main" aria-expanded="${isOpen}" aria-controls="ins-emp-${d.department_id}" onclick="G_App.reports.toggleInsightRow(${d.department_id})">
                        <span class="ins-rank">${d.rank}</span>
                        <span>
                            ${name}
                            <span class="ins-bar" aria-hidden="true"><span style="width:${d.rate}%; background:${R.rateColor(d.rate)};"></span></span>
                            <span class="ins-meta"><span>${attendedText}</span>${stats}</span>
                        </span>
                        <span class="ins-figure">
                            <span class="ins-rate">${figure}</span>
                            <span class="ins-chevron"><i data-lucide="chevron-down" size="18"></i></span>
                        </span>
                    </button>
                    <div id="ins-emp-${d.department_id}" class="ins-employees${isOpen ? '' : ' hidden'}"></div>
                </div>`;
        },
        // The employees involved in one office, rendered on first open.
        renderInsightEmployees: (departmentId) => {
            const R = G_App.reports;
            const payload = R.insights;
            const dept = payload && payload.data.find(d => d.department_id === departmentId);
            const panel = document.getElementById(`ins-emp-${departmentId}`);
            if (!dept || !panel) return;
            const single = !!payload.scope.event;
            const time = (value) => {
                const date = R.parseDbDate(value);
                return date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--';
            };
            const head = single
                ? '<tr><th>Employee</th><th>Status</th><th>Time In / Out</th><th>Position</th></tr>'
                : '<tr><th>Employee</th><th>Attended</th><th>Rate</th><th>Missed</th><th>Position</th></tr>';
            const rows = dept.employees.map(emp => {
                const who = `<b>${escapeHtml(emp.full_name)}</b><span class="ins-emp-sub">${escapeHtml(emp.employee_code)}${emp.classification ? `, ${escapeHtml(emp.classification)}` : ''}</span>`;
                const position = escapeHtml(emp.position || '—');
                if (single) {
                    const times = emp.time_in
                        ? `${time(emp.time_in)} <span style="color:var(--text-muted);">→</span> ${time(emp.time_out)}`
                        : '<span style="color:var(--text-muted);">—</span>';
                    return `<tr><td>${who}</td><td>${R.statusBadge(emp.status)}</td><td>${times}</td><td>${position}</td></tr>`;
                }
                const late = emp.breakdown.late ? `<span class="ins-emp-sub">${emp.breakdown.late} late</span>` : '';
                const missed = [['excused', 'excused'], ['absent', 'absent'], ['no_time_in', 'no time-in']]
                    .filter(([key]) => emp.breakdown[key] > 0)
                    .map(([key, label]) => `${emp.breakdown[key]} ${label}`)
                    .join(', ') || '<span style="color:var(--text-muted);">None</span>';
                return `<tr><td>${who}</td><td>${emp.attended} of ${emp.expected}${late}</td><td><b>${R.pct(emp.rate)}</b></td><td>${missed}</td><td>${position}</td></tr>`;
            }).join('');
            panel.innerHTML = `<table class="ins-emp-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
            panel.dataset.rendered = '1';
        },
        toggleInsightRow: (departmentId) => {
            const R = G_App.reports;
            const open = !R.insightsOpen.has(departmentId);
            if (open) R.insightsOpen.add(departmentId); else R.insightsOpen.delete(departmentId);
            R.setInsightRowOpen(departmentId, open);
            R.updateExpandAllLabel();
        },
        setInsightRowOpen: (departmentId, open) => {
            const row = document.getElementById(`ins-row-${departmentId}`);
            const panel = document.getElementById(`ins-emp-${departmentId}`);
            if (!row || !panel) return;
            if (open && !panel.dataset.rendered) G_App.reports.renderInsightEmployees(departmentId);
            row.classList.toggle('is-open', open);
            row.querySelector('.ins-row-main').setAttribute('aria-expanded', String(open));
            panel.classList.toggle('hidden', !open);
        },
        toggleAllInsightRows: () => {
            const R = G_App.reports;
            if (!R.insights) return;
            const expandable = R.insights.data.filter(d => d.rank !== null);
            const open = expandable.some(d => !R.insightsOpen.has(d.department_id));
            expandable.forEach(d => {
                if (open) R.insightsOpen.add(d.department_id); else R.insightsOpen.delete(d.department_id);
                R.setInsightRowOpen(d.department_id, open);
            });
            R.updateExpandAllLabel();
        },
        updateExpandAllLabel: () => {
            const R = G_App.reports;
            const button = document.getElementById('ins-expand-all');
            const expandable = R.insights ? R.insights.data.filter(d => d.rank !== null) : [];
            button.classList.toggle('hidden', !expandable.length);
            button.innerText = expandable.length && expandable.every(d => R.insightsOpen.has(d.department_id))
                ? 'Hide all employees'
                : 'Show all employees';
        }
    },

    ocr: {
        // On phones, plain `{ video: true }` almost always opens the FRONT
        // (selfie) camera. We explicitly ask for the rear/"environment"
        // camera by default — `ideal` (not a hard `exact`) so it still just
        // works on laptops/desktops with only one (front-facing) webcam.
        currentFacingMode: 'environment',
        // Populates the "Record Attendance For" dropdown with events
        // currently in their scheduled window — an empty selection just
        // verifies identity (today's existing behavior); picking one turns a
        // successful match into an attendance time-in/time-out (see process()).
        loadOngoingEvents: async () => {
            const select = document.getElementById('ocr-event-select');
            if (!select) return;
            const previousValue = select.value;
            try {
                const { data } = await apiFetch('/events/ongoing');
                select.innerHTML = '<option value="">Verify identity only (no attendance)</option>' +
                    data.map(e => `<option value="${e.id}">${e.title}${e.venue ? ' — ' + e.venue : ''}</option>`).join('');
                if (data.some(e => String(e.id) === previousValue)) select.value = previousValue;
            } catch (err) { /* non-fatal — dropdown just stays at "verify only" */ }
        },
        initCamera: async (facingMode) => {
            try {
                const v = document.getElementById('ocr-video');
                // Stop any previous stream first so switching cameras doesn't
                // leave the old camera's light on / stack multiple streams.
                if (v.srcObject) {
                    v.srcObject.getTracks().forEach(t => t.stop());
                }
                facingMode = facingMode || G_App.ocr.currentFacingMode;
                let s;
                try {
                    s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facingMode } } });
                } catch (e) {
                    // Some browsers reject an unsatisfiable facingMode outright
                    // instead of falling back — retry with no constraint at all
                    // rather than leaving the camera dead.
                    s = await navigator.mediaDevices.getUserMedia({ video: true });
                }
                v.srcObject = s;
                G_App.ocr.currentFacingMode = facingMode;
                G_App.ocr.detectMultipleCameras();
            } catch (e) { console.log('Camera unavailable in this browser/context.'); }
        },
        // Shows the flip-camera button only when the device actually reports
        // more than one camera (avoids a dead button on single-camera laptops).
        detectMultipleCameras: async () => {
            const btn = document.getElementById('ocr-flip-cam-btn');
            if (!btn || !navigator.mediaDevices.enumerateDevices) return;
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const cameraCount = devices.filter(d => d.kind === 'videoinput').length;
                btn.classList.toggle('hidden', cameraCount < 2);
            } catch (e) { /* non-fatal — button just stays hidden */ }
        },
        // Toggles between the rear and front camera — bound to the flip
        // button that appears over the video preview on multi-camera devices.
        switchCamera: () => {
            const next = G_App.ocr.currentFacingMode === 'environment' ? 'user' : 'environment';
            G_App.ocr.initCamera(next);
        },
        process: async () => {
            const video = document.getElementById('ocr-video');
            const canvas = document.getElementById('ocr-canvas');
            const line = document.getElementById('scan-line');
            const output = document.getElementById('ocr-output');
            const eventSelect = document.getElementById('ocr-event-select');
            const eventId = eventSelect ? eventSelect.value : '';

            if (!video.srcObject) return toast('Camera not available.', 'error');

            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);

            line.style.display = 'block';
            output.innerText = 'SCANNING ID CARD...';

            canvas.toBlob(async (blob) => {
                const formData = new FormData();
                formData.append('image', blob, 'capture.jpg');
                if (eventId) formData.append('event_id', eventId);
                try {
                    const result = await apiFetch('/ocr/verify', { method: 'POST', body: formData });
                    line.style.display = 'none';
                    if (result.employee) {
                        output.innerText = `SUCCESS: ${result.employee.full_name} [${result.employee.employee_code}]\n${result.message}`;
                    } else {
                        output.innerText = `RESULT: ${result.match.toUpperCase()}\nEMPLOYEE NUMBER READ: ${result.extractedEmployeeCode || '—'}\n${result.message}`;
                    }
                    output.innerText += G_App.verification.attendanceSummaryText(result.attendance);
                    G_App.ocr.loadRecords();
                } catch (err) {
                    line.style.display = 'none';
                    output.innerText = `ERROR: ${err.message}`;
                }
            }, 'image/jpeg', 0.9);
        },
        loadRecords: async () => {
            try {
                const { data } = await apiFetch('/ocr/records');
                document.getElementById('ocr-records-table').innerHTML = data.slice(0, 15).map(r => {
                    const isMatch = r.result === 'matched';
                    const employeeNumber = r.employee_code || r.extracted_employee_code || '—';
                    return `
                    <tr>
                        <td>${isMatch ? (r.full_name || 'Unknown') : '—'}</td>
                        <td>${employeeNumber}</td>
                        <td>${isMatch ? (r.position || '—') : '—'}</td>
                        <td><span class="badge badge-${isMatch ? 'success' : 'danger'}">${isMatch ? 'Match' : 'No Match'}</span></td>
                    </tr>
                `;
                }).join('') || '<tr><td colspan="4" style="text-align:center; padding:20px;">No OCR records yet.</td></tr>';
            } catch (err) { /* silent */ }
        }
    },

    // Tab switcher for the "Verification" section (formerly "OCR Verification"),
    // which hosts two identity-verification methods: OCR and Face. These are
    // for the pre-existing, separate "Verification kiosk" use case -- an
    // admin recording attendance for an employee without their phone/ID on
    // hand (see recordVerificationAttendance in
    // controllers/attendanceController.js) -- NOT for resolving a flagged
    // anomaly. An anomaly is resolved only by the flagged employee's own
    // automatic, on-device Face Verification (faceVerify in the same
    // controller, triggered by AttendanceTrackingContext.js on the mobile
    // side the instant detectGeoAnomaly flags a time-in) -- there is no
    // admin action for that by design.
    verification: {
        activeTab: 'ocr',
        init: () => {
            G_App.verification.loadAlerts();
            // Only spin up the camera for whichever tab is currently visible.
            if (G_App.verification.activeTab === 'face') {
                G_App.face.initCamera();
                G_App.face.loadRecords();
                G_App.face.loadOngoingEvents();
            } else {
                G_App.ocr.initCamera();
                G_App.ocr.loadRecords();
                G_App.ocr.loadOngoingEvents();
            }
        },
        // Read-only: lists attendance currently flagged by anomaly detection
        // and still awaiting the employee's own on-device Face Verification
        // -- "Sa Admin, dapat makita na ang attendance ay dumaan sa Face
        // Verification dahil na-trigger ang anomaly." This list clears
        // itself the moment that employee's own device completes a
        // successful match; there is nothing to click here.
        loadAlerts: async () => {
            try {
                const { data } = await apiFetch('/attendance/anomalies?resolved=0');
                G_App.verification.renderAlerts(data);
            } catch (err) {
                // Non-fatal -- OCR/Face verification still works without this panel.
            }
        },
        renderAlerts: (alerts) => {
            const container = document.getElementById('verification-alerts');
            if (!alerts.length) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = `
                <div class="card" style="background: #FEF2F2; border-color: #FECACA;">
                    <h3 style="color: var(--danger); font-weight: 800; display:flex; align-items:center; gap:10px; margin-bottom: 6px;">
                        <i data-lucide="alert-triangle"></i> ${alerts.length} Flagged Attendance Record${alerts.length > 1 ? 's' : ''} Awaiting Verification
                    </h3>
                    <p style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 15px;">Each employee is automatically prompted for Face Verification on their own device — this list clears itself the moment they pass it.</p>
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        ${alerts.map(a => `
                            <div style="background:#fff; border-radius:14px; padding:14px 18px; display:flex; justify-content:space-between; align-items:center; gap:15px; flex-wrap:wrap;">
                                <div>
                                    <strong>${a.full_name}</strong> <span style="color:var(--text-muted); font-size:0.8rem;">(${a.employee_code})</span>
                                    — ${a.event_title || 'Unknown event'}<br>
                                    <span style="color:var(--text-muted); font-size:0.8rem;">${a.details} · ${new Date(a.created_at).toLocaleString()}</span>
                                </div>
                                <span class="badge badge-warning" style="flex-shrink:0;"><i data-lucide="smartphone" size="11"></i> Awaiting employee verification</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            lucide.createIcons();
        },
        // Turns a recordVerificationAttendance() result into a short text
        // block appended under the OCR/Face verification output — blank when
        // no event was selected (identity-only check) or the match failed,
        // since there'd be nothing to report attendance-wise either way.
        // OCR/Face attendance is a one-time roll-call confirmation (no
        // time-in/time-out cycle), so this just reports whether it was
        // freshly recorded or was already on file for today.
        attendanceSummaryText: (attendance) => {
            if (!attendance) return '';
            if (!attendance.success) return `\n\nATTENDANCE: ${attendance.message || 'Could not be recorded.'}`;
            const status = attendance.status_label ? ` (${attendance.status_label})` : '';
            const actionLabel = attendance.action === 'anomaly_resolved' ? '\u26a0 FLAGGED ATTENDANCE VERIFIED & RESOLVED'
                : attendance.action === 'already_recorded' ? 'ALREADY RECORDED TODAY'
                : 'ATTENDANCE RECORDED';
            // A resolved anomaly changes the read-only alert panel's count --
            // refresh it rather than waiting for the admin to notice on their
            // own. (This can only happen if this kiosk verification happened
            // to match someone who separately also had a pending anomaly for
            // the same event -- an incidental overlap of two different
            // features, not the expected way anomalies get resolved.)
            if (attendance.action === 'anomaly_resolved') {
                G_App.verification.loadAlerts();
            }
            return `\n\n${actionLabel}${status}`;
        },
        switchTab: (tab) => {
            G_App.verification.activeTab = tab;
            const ocrPanel = document.getElementById('ocr-panel');
            const facePanel = document.getElementById('face-panel');
            const ocrBtn = document.getElementById('verification-tab-ocr');
            const faceBtn = document.getElementById('verification-tab-face');

            const activate = (panel, btn, other, otherBtn) => {
                panel.classList.remove('hidden');
                other.classList.add('hidden');
                btn.classList.add('active');
                btn.style.background = '';
                btn.style.color = '';
                otherBtn.classList.remove('active');
                otherBtn.style.background = 'var(--border)';
                otherBtn.style.color = 'var(--text-main)';
            };

            if (tab === 'face') {
                activate(facePanel, faceBtn, ocrPanel, ocrBtn);
                G_App.face.initCamera();
                G_App.face.loadRecords();
                G_App.face.loadOngoingEvents();
            } else {
                activate(ocrPanel, ocrBtn, facePanel, faceBtn);
                G_App.ocr.initCamera();
                G_App.ocr.loadRecords();
                G_App.ocr.loadOngoingEvents();
            }
            lucide.createIcons();
        }
    },

    face: {
        // Faces are best captured front-on with the selfie camera, unlike the
        // OCR module (which defaults to the rear camera for scanning ID cards).
        currentFacingMode: 'user',
        // Single-step capture, mirroring the mobile app's registration flow:
        // just hold a live face steady in frame -- no blink/nod/turn-head
        // sequence to fumble through. Still verified for real (see
        // detectFaceHold below), just with one thing to get right instead of
        // two random challenges picked from four.
        HOLD_STILL_INSTRUCTION: 'Hold still and look at the camera',
        // Mirrors G_App.ocr.loadOngoingEvents — populates the "Record
        // Attendance For" dropdown with events currently in their scheduled
        // window. An empty selection just verifies identity (today's
        // existing behavior); picking one turns a successful match into an
        // attendance time-in/time-out (see captureAndVerify()).
        loadOngoingEvents: async () => {
            const select = document.getElementById('face-event-select');
            if (!select) return;
            const previousValue = select.value;
            try {
                const { data } = await apiFetch('/events/ongoing');
                select.innerHTML = '<option value="">Verify identity only (no attendance)</option>' +
                    data.map(e => `<option value="${e.id}">${e.title}${e.venue ? ' — ' + e.venue : ''}</option>`).join('');
                if (data.some(e => String(e.id) === previousValue)) select.value = previousValue;
            } catch (err) { /* non-fatal — dropdown just stays at "verify only" */ }
        },
        initCamera: async (facingMode) => {
            try {
                const v = document.getElementById('face-video');
                if (!v) return;
                if (v.srcObject) {
                    v.srcObject.getTracks().forEach(t => t.stop());
                }
                facingMode = facingMode || G_App.face.currentFacingMode;
                let s;
                try {
                    s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facingMode } } });
                } catch (e) {
                    s = await navigator.mediaDevices.getUserMedia({ video: true });
                }
                v.srcObject = s;
                G_App.face.currentFacingMode = facingMode;
                G_App.face.detectMultipleCameras();
            } catch (e) { console.log('Camera unavailable in this browser/context.'); }
        },
        detectMultipleCameras: async () => {
            const btn = document.getElementById('face-flip-cam-btn');
            if (!btn || !navigator.mediaDevices.enumerateDevices) return;
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const cameraCount = devices.filter(d => d.kind === 'videoinput').length;
                btn.classList.toggle('hidden', cameraCount < 2);
            } catch (e) { /* non-fatal — button just stays hidden */ }
        },
        switchCamera: () => {
            const next = G_App.face.currentFacingMode === 'environment' ? 'user' : 'environment';
            G_App.face.initCamera(next);
        },

        // Drives the guide ring + status chip's real-time color/text. Purely
        // cosmetic -- never touches detection thresholds/timing.
        setGuideState: (state) => {
            const frame = document.getElementById('face-guide-frame');
            const chip = document.getElementById('face-status-chip');
            const chipText = document.getElementById('face-status-chip-text');
            if (frame) frame.className = `state-${state}`;
            if (chip) chip.className = `face-status-chip state-${state}`;
            if (chipText) {
                chipText.innerText = state === 'found' ? 'FACE FOUND'
                    : state === 'pass' ? 'CONFIRMED'
                    : state === 'fail' ? "DIDN'T CATCH THAT"
                    : 'SEARCHING…';
            }
        },

        // ---- Liveness engine --------------------------------------------
        // Pure canvas pixel-analysis (no external face-landmark library):
        // 1) YCbCr skin-tone thresholding gives a rough face blob per frame,
        //    from which we take a centroid + bounding box.
        // 2) Head turns/nods are detected as a sustained shift of that
        //    centroid away from a locked-in baseline position, normalized by
        //    the face's own bounding-box size (scale-invariant — works the
        //    same whether the camera is close or far away), and require 2
        //    consecutive confirming frames so one noisy sample can't trigger it.
        // 3) Blinks are detected as a dip-then-recovery in the local pixel
        //    contrast ("std dev of luma") of the eye band inside that
        //    bounding box — closed eyelids are visibly smoother/flatter
        //    than open eyes — likewise debounced over 2 consecutive frames.
        sampleFaceMetrics: (video, workCanvas) => {
            const W = 120, H = 120;
            workCanvas.width = W; workCanvas.height = H;
            const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, W, H);
            let data;
            try { data = ctx.getImageData(0, 0, W, H).data; } catch (e) { return null; }

            let sumX = 0, sumY = 0, count = 0;
            let minX = W, maxX = 0, minY = H, maxY = 0;
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = (y * W + x) * 4;
                    const r = data[i], g = data[i + 1], b = data[i + 2];
                    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
                    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
                    if (cr >= 133 && cr <= 173 && cb >= 77 && cb <= 127) {
                        sumX += x; sumY += y; count++;
                        if (x < minX) minX = x; if (x > maxX) maxX = x;
                        if (y < minY) minY = y; if (y > maxY) maxY = y;
                    }
                }
            }

            const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
            const aspect = bw / bh;
            // Reject frames whose skin blob is too small or the wrong shape to
            // plausibly be a face (a hand passing through, a skin-toned wall).
            if (count < W * H * 0.06 || aspect < 0.55 || aspect > 1.85) return null;

            const eyeX0 = Math.max(0, Math.round(minX + bw * 0.18));
            const eyeX1 = Math.min(W - 1, Math.round(maxX - bw * 0.18));
            const eyeY0 = Math.max(0, Math.round(minY + bh * 0.26));
            const eyeY1 = Math.min(H - 1, Math.round(minY + bh * 0.46));

            let lumaSum = 0, lumaSumSq = 0, lumaCount = 0;
            for (let y = eyeY0; y <= eyeY1; y++) {
                for (let x = eyeX0; x <= eyeX1; x++) {
                    const i = (y * W + x) * 4;
                    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                    lumaSum += luma; lumaSumSq += luma * luma; lumaCount++;
                }
            }
            const lumaMean = lumaCount ? lumaSum / lumaCount : 0;
            const eyeStd = lumaCount ? Math.sqrt(Math.max(0, lumaSumSq / lumaCount - lumaMean * lumaMean)) : 0;

            // cx/cy in raw pixel space — normalized against the face's OWN
            // baseline size by the caller, not a fixed fraction of the canvas.
            return { cx: sumX / count, cy: sumY / count, bw, bh, eyeStd };
        },
        // Resolves true once a live face is held steady in frame for several
        // consecutive samples within timeoutMs, false on timeout. No head
        // movement required -- just a sustained, real face (a photo held up
        // to the camera or an empty frame won't hold the skin-tone blob
        // check below across several consecutive samples the way a real,
        // slightly-moving live face does).
        detectFaceHold: (timeoutMs = 12000) => new Promise((resolve) => {
            const video = document.getElementById('face-video');
            const instructionEl = document.getElementById('face-liveness-instruction');
            const workCanvas = document.createElement('canvas');
            let settled = false, noFaceStreak = 0, holdStreak = 0;
            const start = Date.now();

            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearInterval(timer);
                resolve(ok);
            };

            const timer = setInterval(() => {
                if (Date.now() - start > timeoutMs) return finish(false);
                const m = G_App.face.sampleFaceMetrics(video, workCanvas);
                if (!m) {
                    noFaceStreak++;
                    holdStreak = 0;
                    G_App.face.setGuideState('searching');
                    if (noFaceStreak === 8 && instructionEl) instructionEl.innerText = 'Center your whole face in the frame…';
                    return;
                }
                if (noFaceStreak >= 8 && instructionEl) instructionEl.innerText = G_App.face.HOLD_STILL_INSTRUCTION;
                noFaceStreak = 0;
                G_App.face.setGuideState('found');

                holdStreak++;
                if (holdStreak >= 5) return finish(true); // ~750ms of a sustained real face at this 150ms sampling rate
            }, 150);
        }),

        // ---- Orchestration: hold-still check -> capture -> /api/face/verify
        startVerification: async () => {
            const video = document.getElementById('face-video');
            if (!video.srcObject) return toast('Camera not available.', 'error');

            const btn = document.getElementById('face-verify-btn');
            const banner = document.getElementById('face-liveness-banner');
            const instructionEl = document.getElementById('face-liveness-instruction');
            const idleLabel = document.getElementById('face-idle-label');
            const idleSubLabel = document.getElementById('face-idle-sublabel');
            const idleSheet = document.getElementById('face-idle-sheet');
            const output = document.getElementById('face-output');

            btn.disabled = true;
            if (idleLabel) idleLabel.classList.add('hidden');
            if (idleSubLabel) idleSubLabel.classList.add('hidden');
            if (idleSheet) idleSheet.classList.add('hidden');
            banner.classList.remove('hidden');
            output.innerText = 'RUNNING LIVENESS CHECK...';
            output.classList.remove('tone-success', 'tone-error');

            instructionEl.innerText = G_App.face.HOLD_STILL_INSTRUCTION;
            const passed = await G_App.face.detectFaceHold();
            G_App.face.setGuideState(passed ? 'pass' : 'fail');

            const resetIdle = () => {
                banner.classList.add('hidden');
                if (idleLabel) idleLabel.classList.remove('hidden');
                if (idleSubLabel) idleSubLabel.classList.remove('hidden');
                if (idleSheet) idleSheet.classList.remove('hidden');
                btn.disabled = false;
                G_App.face.setGuideState('searching');
            };

            if (!passed) {
                instructionEl.innerText = "Didn't catch that — please try again.";
                output.innerText = "LIVENESS CHECK FAILED.\nMake sure your face is centered, unobstructed, and well-lit, then try again.";
                output.classList.add('tone-error');
                setTimeout(resetIdle, 1800);
                return;
            }

            instructionEl.innerText = 'Liveness confirmed — capturing…';
            await new Promise((r) => setTimeout(r, 400));
            resetIdle();
            await G_App.face.captureAndVerify(['hold_still']);
        },
        captureAndVerify: (passedActions) => new Promise((resolve) => {
            const video = document.getElementById('face-video');
            const canvas = document.getElementById('face-canvas');
            const line = document.getElementById('face-scan-line');
            const output = document.getElementById('face-output');
            const eventSelect = document.getElementById('face-event-select');
            const eventId = eventSelect ? eventSelect.value : '';

            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);

            line.style.display = 'block';
            output.innerText = 'RUNNING FACE RECOGNITION...';

            canvas.toBlob(async (blob) => {
                const formData = new FormData();
                formData.append('image', blob, 'capture.jpg');
                formData.append('liveness_verified', 'true');
                formData.append('liveness_actions', passedActions.join(','));
                if (eventId) formData.append('event_id', eventId);
                try {
                    const result = await apiFetch('/face/verify', { method: 'POST', body: formData });
                    line.style.display = 'none';
                    const simText = result.similarity != null ? `MATCH SIMILARITY: ${result.similarity.toFixed(1)}%\n` : '';
                    const livenessText = `LIVENESS: PASSED (${passedActions.join(' \u2192 ')})\n`;
                    output.classList.toggle('tone-success', !!result.employee);
                    output.classList.toggle('tone-error', !result.employee);
                    if (result.employee) {
                        output.innerText = `SUCCESS: ${result.employee.full_name} [${result.employee.employee_code}]\n${livenessText}${simText}${result.message}`;
                    } else {
                        output.innerText = `RESULT: ${result.result.toUpperCase()}\n${livenessText}${simText}${result.message}`;
                    }
                    output.innerText += G_App.verification.attendanceSummaryText(result.attendance);
                    G_App.face.loadRecords();
                } catch (err) {
                    line.style.display = 'none';
                    output.classList.add('tone-error');
                    output.innerText = `ERROR: ${err.message}`;
                }
                G_App.face.setGuideState('searching');
                resolve();
            }, 'image/jpeg', 0.9);
        }),
        loadRecords: async () => {
            try {
                const { data } = await apiFetch('/face/records');
                document.getElementById('face-records-table').innerHTML = data.slice(0, 15).map(r => `
                    <tr>
                        <td>${r.full_name || 'Unknown'}</td>
                        <td>${r.similarity != null ? Number(r.similarity).toFixed(1) + '%' : '—'}</td>
                        <td><span class="liveness-badge ${r.liveness_verified ? 'pass' : 'fail'}">${r.liveness_verified ? 'Live' : 'N/A'}</span></td>
                        <td><span class="badge badge-${r.result === 'matched' ? 'success' : 'danger'}">${r.result}</span></td>
                    </tr>
                `).join('') || '<tr><td colspan="4" style="text-align:center; padding:20px;">No face verification records yet.</td></tr>';
            } catch (err) { /* silent */ }
        }
    },

    mobile: {
        // Cached from the last /devices load so openViewModal() doesn't need
        // a second round trip -- same pattern as G_App.ratings.raw.
        raw: [],
        render: async () => {
            try {
                const { data } = await apiFetch('/devices');
                G_App.mobile.raw = data;
                document.getElementById('mobile-device-table').innerHTML = data.map(d => `
                    <tr>
                        <td><b>${d.full_name}</b></td>
                        <td>${d.model || 'N/A'}</td>
                        <td><code>${d.device_uid || 'N/A'}</code></td>
                        <td><span class="badge badge-${d.status === 'approved' ? 'success' : (d.status === 'pending' ? 'warning' : 'danger')}">${d.status}</span></td>
                        <td>
                            <button class="btn-icon btn-edit" title="View employee details and registration photo" onclick="G_App.mobile.openViewModal(${d.id})"><i data-lucide="eye" size="14"></i></button>
                            ${d.status !== 'approved' ? `<button class="btn-icon btn-edit" onclick="G_App.mobile.setStatus(${d.id},'approved')"><i data-lucide="check" size="14"></i></button>` : ''}
                            <button class="btn-icon btn-delete" onclick="G_App.mobile.setStatus(${d.id},'blacklisted')"><i data-lucide="ban" size="14"></i></button>
                        </td>
                    </tr>
                `).join('') || '<tr><td colspan="5" style="text-align:center; padding:20px;">No devices registered yet.</td></tr>';
                lucide.createIcons();
            } catch (err) { toast(err.message, 'error'); }
        },
        setStatus: async (id, status) => {
            try {
                await apiFetch(`/devices/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
                toast(`Device marked as ${status}.`, 'success');
                // Awaited: openViewModal() below reads G_App.mobile.raw, which
                // render() only refreshes once its own /devices fetch resolves.
                // Without this await, the modal would reopen against the
                // still-stale cached data and appear not to have updated.
                await G_App.mobile.render();
                // Keep the modal's own status/actions in sync if it's open on this device.
                if (document.getElementById('device-view-modal').classList.contains('open') && G_App.mobile.viewingId === id) {
                    G_App.mobile.openViewModal(id);
                }
            } catch (err) { toast(err.message, 'error'); }
        },
        // Shows the employee's profile details plus the face photo captured
        // during THIS device's registration (see deviceController.getDevices
        // -- matched by closest timestamp, not just "their latest photo",
        // so this is genuinely the photo from this device's registration
        // even for an employee with more than one device on file), so the
        // admin can clearly see who they're approving before doing so.
        viewingId: null,
        openViewModal: (id) => {
            const d = (G_App.mobile.raw || []).find(x => x.id === id);
            if (!d) return;
            G_App.mobile.viewingId = id;

            const photo = document.getElementById('device-view-photo');
            const caption = document.getElementById('device-view-photo-caption');
            if (d.face_image_path) {
                photo.src = d.face_image_path;
                photo.style.display = 'block';
                caption.innerText = d.face_captured_at ? `Captured ${new Date(d.face_captured_at).toLocaleString()}` : 'Registration photo';
            } else {
                // data: URI placeholder -- no external request, never broken-image icon.
                // Colors are written as plain #hex here (not pre-escaped as %23) since
                // encodeURIComponent() below does that escaping for the whole string;
                // pre-escaping and then encoding again would double-encode the % itself.
                photo.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#E9EDF7"/><text x="50" y="55" font-size="13" text-anchor="middle" fill="#A3AED0" font-family="sans-serif">No Photo</text></svg>'
                );
                photo.style.display = 'block';
                caption.innerText = 'No registration photo on file';
            }

            document.getElementById('device-view-name').innerText = d.full_name;
            // Every piece of information below is its own clearly labeled
            // field (not folded into unlabeled subtitle text), so this line
            // only needs to say what the card as a whole is.
            document.getElementById('device-view-subtitle').innerText = 'Employee & device details';

            const field = (label, value, fullWidth) => `
                <div${fullWidth ? ' style="grid-column: 1 / -1;"' : ''}>
                    <div style="font-size:0.68rem; font-weight:800; text-transform:uppercase; color:var(--text-muted);">${label}</div>
                    <div style="font-size:0.88rem; font-weight:600;">${value ?? '<span style="color:var(--text-muted);">—</span>'}</div>
                </div>`;

            // ID Number full-width, with Department directly under it (its
            // own row right below), per the requested field order.
            document.getElementById('device-view-employee-grid').innerHTML = [
                field('ID Number', d.employee_code, true),
                field('Department', d.department_name, true),
                field('Position', d.position),
                field('Classification', d.classification),
                field('Remark', d.employee_remark),
                field('Email', d.email)
            ].join('');

            document.getElementById('device-view-device-grid').innerHTML = [
                field('Model', d.model),
                field('Brand', d.brand),
                field('OS', d.os),
                field('Device ID', d.device_uid ? `<code>${d.device_uid}</code>` : null),
                field('Registered', d.registered_at ? new Date(d.registered_at).toLocaleString() : null),
                field('Device Status', `<span class="badge badge-${d.status === 'approved' ? 'success' : (d.status === 'pending' ? 'warning' : 'danger')}">${d.status}</span>`)
            ].join('');

            document.getElementById('device-view-actions').innerHTML = `
                ${d.status !== 'approved' ? `<button class="btn-primary" style="flex:1;" onclick="G_App.mobile.setStatus(${d.id},'approved')"><i data-lucide="check"></i> Approve Device</button>` : ''}
                <button class="btn-primary" style="flex:1; background:${d.status === 'blacklisted' ? 'var(--border)' : '#FEE2E2'}; color:${d.status === 'blacklisted' ? 'var(--text-main)' : 'var(--danger)'};" onclick="G_App.mobile.setStatus(${d.id},'blacklisted')" ${d.status === 'blacklisted' ? 'disabled' : ''}><i data-lucide="ban"></i> ${d.status === 'blacklisted' ? 'Blacklisted' : 'Blacklist Device'}</button>
                <button class="btn-primary" style="flex:1; background: var(--border); color: var(--text-main);" onclick="G_App.mobile.closeViewModal()">Close</button>
            `;

            document.getElementById('device-view-modal').classList.add('open');
            lucide.createIcons();
        },
        closeViewModal: () => document.getElementById('device-view-modal').classList.remove('open')
    },

    settings: {
        render: () => {
            const certSel = document.getElementById('cert-employee-select');
            if (certSel) certSel.innerHTML = G_App.state.employees.map(e => `<option value="${e.id}">${e.full_name} (${e.employee_code})</option>`).join('');
            lucide.createIcons();
        },
        generateCertificate: async () => {
            const employeeId = document.getElementById('cert-employee-select').value;
            const event = document.getElementById('cert-event').value || 'Professional Development Workshop';
            if (!employeeId) return toast('Select an employee first.', 'error');

            try {
                const result = await apiFetch('/certificates/generate', {
                    method: 'POST',
                    body: JSON.stringify({ employee_id: employeeId, event_title: event })
                });
                toast('Certificate generated.', 'success');
                window.open(result.data.downloadUrl, '_blank');
            } catch (err) {
                toast(err.message, 'error');
            }
        }
    },

    adminAccounts: {
        load: async () => {
            if (G_App.state.role !== 'super_admin') return; // OCR-only admins can't see this
            try {
                const { data } = await apiFetch('/admin-accounts');
                G_App.adminAccounts.render(data);
            } catch (err) {
                // Silently skip — element may not be visible for this role.
            }
        },
        render: (accounts) => {
            const list = document.getElementById('admin-accounts-list');
            if (!list) return;
            list.innerHTML = accounts.map(a => `
                <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-body); padding:14px 18px; border-radius:14px;">
                    <div>
                        <strong>${a.full_name}</strong> ${a.is_active ? '' : '<span class="badge badge-danger" style="margin-left:6px;">Disabled</span>'}<br>
                        <span style="color:var(--text-muted); font-size:0.8rem;">${a.email}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span class="badge badge-${a.role === 'super_admin' ? 'info' : 'warning'}">${a.role === 'super_admin' ? 'Super Admin' : 'Admin (OCR only)'}</span>
                        <button class="btn-icon btn-delete" onclick="G_App.adminAccounts.remove(${a.id})"><i data-lucide="trash" size="14"></i></button>
                    </div>
                </div>
            `).join('') || '<p style="color:var(--text-muted); font-size:0.85rem;">No admin accounts yet.</p>';
            lucide.createIcons();
        },
        openModal: () => {
            ['aa-name', 'aa-email', 'aa-password'].forEach(id => document.getElementById(id).value = '');
            document.getElementById('aa-role').value = 'admin';
            document.getElementById('admin-account-modal').classList.add('open');
        },
        closeModal: () => document.getElementById('admin-account-modal').classList.remove('open'),
        save: async () => {
            const payload = {
                full_name: document.getElementById('aa-name').value.trim(),
                email: document.getElementById('aa-email').value.trim(),
                password: document.getElementById('aa-password').value,
                role: document.getElementById('aa-role').value
            };
            if (!payload.full_name || !payload.email || !payload.password) {
                return toast('Full name, email, and password are required.', 'error');
            }
            try {
                await apiFetch('/admin-accounts', { method: 'POST', body: JSON.stringify(payload) });
                toast('Admin account created.', 'success');
                G_App.adminAccounts.closeModal();
                G_App.adminAccounts.load();
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        remove: async (id) => {
            if (!confirm('Delete this admin account? This cannot be undone.')) return;
            try {
                await apiFetch(`/admin-accounts/${id}`, { method: 'DELETE' });
                toast('Admin account deleted.', 'success');
                G_App.adminAccounts.load();
            } catch (err) {
                toast(err.message, 'error');
            }
        }
    },

    ratings: {
        current: { month: new Date().getMonth() + 1, year: new Date().getFullYear() },
        // Last data fetched from the server (unfiltered by the search box) so
        // typing in the search bar can re-render instantly without a re-fetch.
        raw: { events: [], data: [] },
        initSelectors: () => {
            const monthSel = document.getElementById('ratings-month');
            const yearSel = document.getElementById('ratings-year');
            const deptSel = document.getElementById('ratings-department');
            const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            monthSel.innerHTML = monthNames.map((m, i) => `<option value="${i + 1}" ${i + 1 === G_App.ratings.current.month ? 'selected' : ''}>${m}</option>`).join('');
            const thisYear = new Date().getFullYear();
            const years = [thisYear - 1, thisYear, thisYear + 1];
            yearSel.innerHTML = years.map(y => `<option value="${y}" ${y === G_App.ratings.current.year ? 'selected' : ''}>${y}</option>`).join('');
            if (deptSel) {
                const selected = deptSel.value || 'all';
                const departments = G_App.state.departments || [];
                deptSel.innerHTML = '<option value="all">All Departments</option>' +
                    departments.map(d => `<option value="${d.name}">${d.name}</option>`).join('');
                deptSel.value = selected;
            }
            G_App.ratings.refreshEmployeeOptions();
        },
        // Rebuilds the Employee dropdown's options to only those in the currently
        // selected Department, so the two filters can never contradict each other.
        // Falls back to "All Personnel" if the previous selection drops out.
        refreshEmployeeOptions: () => {
            const empSel = document.getElementById('ratings-employee');
            const deptSel = document.getElementById('ratings-department');
            if (!empSel) return;
            const previous = empSel.value || 'all';
            const deptFilter = deptSel ? deptSel.value : 'all';
            const employees = (G_App.state.employees || []).filter(e => deptFilter === 'all' || e.department === deptFilter || e.department_name === deptFilter);
            empSel.innerHTML = '<option value="all">All Personnel</option>' +
                employees.map(e => `<option value="${e.id}">${e.full_name}</option>`).join('');
            empSel.value = employees.some(e => String(e.id) === previous) ? previous : 'all';
        },
        onDepartmentChange: () => {
            G_App.ratings.refreshEmployeeOptions();
            G_App.ratings.load();
        },
        load: async () => {
            const month = Number(document.getElementById('ratings-month').value) || G_App.ratings.current.month;
            const year = Number(document.getElementById('ratings-year').value) || G_App.ratings.current.year;
            const employeeSel = document.getElementById('ratings-employee');
            const employeeId = employeeSel ? employeeSel.value : 'all';
            const deptSel = document.getElementById('ratings-department');
            const department = deptSel ? deptSel.value : 'all';
            G_App.ratings.current = { month, year };
            try {
                const params = new URLSearchParams({ month, year, employee_id: employeeId, department });
                const { events, data } = await apiFetch(`/ratings?${params.toString()}`);
                G_App.ratings.raw = { events, data };
                G_App.ratings.renderFiltered();
            } catch (err) {
                toast(err.message, 'error');
            }
        },
        onSearch: () => {
            G_App.ratings.renderFiltered();
        },
        // Applies the free-text search box (employee name/code/department,
        // event title/venue, or attendance-status word like "present"/"absent")
        // against the already-fetched month's data, then renders. Rows are
        // narrowed to matching employees (falling back to all of them if none
        // match, so a pure event-name search still works); columns are
        // narrowed to matching events the same way.
        renderFiltered: () => {
            const { events, data } = G_App.ratings.raw;
            const term = (document.getElementById('ratings-search')?.value || '').trim().toLowerCase();

            if (!term) {
                G_App.ratings.render(events, data);
                return;
            }

            const ratingLabel = (r) => (r == null ? '' : Number(r) === 5 ? 'present' : 'absent');

            const matchedEmployees = data.filter((e) =>
                (e.full_name || '').toLowerCase().includes(term) ||
                (e.employee_code || '').toLowerCase().includes(term) ||
                (e.department_name || '').toLowerCase().includes(term)
            );
            const employeesToShow = matchedEmployees.length ? matchedEmployees : data;

            const matchedEvents = events.filter((ev) =>
                (ev.title || '').toLowerCase().includes(term) ||
                (ev.venue || '').toLowerCase().includes(term) ||
                (ev.date || '').includes(term) ||
                employeesToShow.some((e) => ratingLabel(e.ratings[ev.id]?.rating) === term || ratingLabel(e.ratings[ev.id]?.rating).startsWith(term))
            );
            const eventsToShow = matchedEvents.length ? matchedEvents : events;

            G_App.ratings.render(eventsToShow, employeesToShow);
        },
        render: (events, data) => {
            const table = document.getElementById('ratings-table');
            if (!events.length) {
                table.innerHTML = '<tbody><tr><td style="padding:25px;">No completed events found for this month.</td></tr></tbody>';
                return;
            }
            if (!data.length) {
                table.innerHTML = '<tbody><tr><td style="padding:25px;">No employees match this filter.</td></tr></tbody>';
                return;
            }
            const dateLabel = (iso) => {
                const d = new Date(`${iso}T00:00:00`);
                const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
                return `${weekday} ${d.getDate()}`;
            };
            const head = `<thead><tr><th>Employee</th>${events.map(ev => `<th style="text-align:center;" title="${ev.title}${ev.venue ? ' · ' + ev.venue : ''}">${ev.title}<br><span style="font-weight:600; font-size:0.72rem; color:var(--text-muted);">${dateLabel(ev.date)}</span></th>`).join('')}<th style="text-align:center;" title="Sum of the employee's own ratings across every event applicable to them this month">Total Rating</th><th style="text-align:center;" title="Total Rating ÷ number of rated events">Rating Points</th><th style="text-align:center;">Events</th></tr></thead>`;
            const body = data.map(e => {
                // Rating Points can only ever land in 1..5 (it's an average of
                // 1s and 5s), so it's colored on where it falls in that fixed
                // range rather than by sign, unlike the old unrelated metric
                // this column used to show.
                const pointsColor = e.rating_points == null ? 'var(--text-muted)' : e.rating_points >= 4 ? 'var(--success)' : e.rating_points >= 2.5 ? 'var(--warning)' : 'var(--danger)';
                return `
                <tr>
                    <td>${e.full_name}<br><span style="color:var(--text-muted); font-weight:600; font-size:0.75rem;">${e.employee_code}</span></td>
                    ${events.map(ev => {
                        const cell = e.ratings[ev.id];
                        const val = cell ? Number(cell.rating) : '';
                        return `
                        <td style="text-align:center;">
                            <select class="badge-select" style="background: var(--bg-body); color: var(--text-main); min-width:70px;"
                                onchange="G_App.ratings.setRating(${e.id}, ${ev.id}, this.value)" title="${cell && cell.is_manual ? 'Manually edited by admin' : cell ? 'Auto-generated from attendance' : 'Not applicable to this employee'}">
                                <option value="" ${!val ? 'selected' : ''}>—</option>
                                <option value="1" ${val === 1 ? 'selected' : ''}>1 · Absent</option>
                                <option value="5" ${val === 5 ? 'selected' : ''}>5 · Present</option>
                            </select>
                        </td>`;
                    }).join('')}
                    <td style="text-align:center; font-weight:800;">${e.total_rating != null ? e.total_rating : '--'}</td>
                    <td style="text-align:center; font-weight:800; color:${pointsColor};">${e.rating_points ?? '--'}</td>
                    <td style="text-align:center;">
                        <button class="btn-icon btn-edit" style="width:auto; padding:0 10px; height:30px; font-size:0.75rem; font-weight:700; margin-right:0; ${e.rating_count ? '' : 'opacity:0.45; cursor:not-allowed;'}" onclick="G_App.ratings.openEventsModal(${e.id})" ${e.rating_count ? '' : 'disabled title="No rated events this month"'}>
                            <i data-lucide="list" size="13"></i> ${e.rating_count || 0}
                        </button>
                    </td>
                </tr>
            `;
            }).join('');
            table.innerHTML = head + `<tbody>${body}</tbody>`;
            lucide.createIcons();
        },
        // Lists the events a specific employee was rated on this month, each
        // with its own rating, plus the Total Rating / Rating Points summary
        // -- the "listahan ng mga Events na pinasukan ng employee at ang
        // rating niya sa bawat event" view, separate from the wide
        // all-employees x all-events grid above.
        openEventsModal: (employeeId) => {
            const emp = (G_App.ratings.raw.data || []).find(e => e.id === employeeId);
            if (!emp) return;
            document.getElementById('ratings-events-modal-name').innerText = emp.full_name;
            document.getElementById('ratings-events-modal-sub').innerText = `${emp.employee_code} · ${emp.department_name}`;

            const dateLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
            const list = document.getElementById('ratings-events-modal-list');
            list.innerHTML = emp.rated_events.length ? emp.rated_events.map(ev => `
                <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--border); border-radius:10px;">
                    <div style="min-width:0;">
                        <div style="font-weight:700; font-size:0.88rem;">${ev.title}</div>
                        <div style="color:var(--text-muted); font-size:0.75rem;">${dateLabel(ev.date)}${ev.venue ? ' · ' + ev.venue : ''}${ev.is_manual ? ' · edited by admin' : ''}</div>
                    </div>
                    <span class="badge ${ev.rating === 5 ? 'badge-success' : 'badge-danger'}" style="flex-shrink:0;">
                        ${ev.rating} · ${ev.rating === 5 ? 'Present' : 'Absent'}
                    </span>
                </div>
            `).join('') : '<p style="color:var(--text-muted); font-size:0.85rem; padding:12px 0;">No rated events for this employee this month.</p>';

            const summary = document.getElementById('ratings-events-modal-summary');
            summary.innerHTML = `
                <div style="flex:1; text-align:center;">
                    <div style="font-size:1.4rem; font-weight:800;">${emp.total_rating != null ? emp.total_rating : '--'}</div>
                    <div style="font-size:0.7rem; font-weight:800; text-transform:uppercase; color:var(--text-muted);">Total Rating</div>
                </div>
                <div style="flex:1; text-align:center; border-left:1px solid var(--border);">
                    <div style="font-size:1.4rem; font-weight:800;">${emp.rating_points ?? '--'}</div>
                    <div style="font-size:0.7rem; font-weight:800; text-transform:uppercase; color:var(--text-muted);">Rating Points${emp.rating_count ? ` (÷${emp.rating_count})` : ''}</div>
                </div>
            `;
            document.getElementById('ratings-events-modal').classList.add('open');
        },
        closeEventsModal: () => document.getElementById('ratings-events-modal').classList.remove('open'),
        setRating: async (employeeId, eventId, value) => {
            if (!value) return;
            try {
                await apiFetch('/ratings', { method: 'PATCH', body: JSON.stringify({ employee_id: employeeId, event_id: eventId, rating: Number(value) }) });
                toast('Rating saved.', 'success');
                G_App.ratings.load();
            } catch (err) {
                toast(err.message, 'error');
            }
        }
    },

    init: async () => {
        const adminData = JSON.parse(localStorage.getItem('ga_admin') || '{}');
        G_App.state.role = adminData.role || 'super_admin';
        G_App.ui.initNav();
        G_App.ui.applyRoleRestrictions();

        if (G_App.state.role === 'admin') {
            // Verification-only admin: skip loading modules they can't access (would 403).
            G_App.verification.init();
            lucide.createIcons();
            return;
        }

        await G_App.departments.load();
        await G_App.employees.load();
        G_App.ui.updateDashboard();
        G_App.attendance.render();
        G_App.settings.render();
        G_App.adminAccounts.load();
        G_App.mobile.render();
        G_App.ui.startAutoRefresh();
        lucide.createIcons();

        // Reopen whichever section was on screen before a reload (F5 / browser
        // refresh) instead of always landing back on the Dashboard.
        const savedView = localStorage.getItem(G_App.ui.ACTIVE_VIEW_KEY);
        if (savedView && savedView !== 'dashboard') {
            G_App.ui.switchView(savedView);
        }
    }
};

window.onload = () => {
    lucide.createIcons();
    G_App.auth.checkSession();
};

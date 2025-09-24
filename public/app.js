(() => {
    const TOTAL_OPTIONS = 20;
    const STORAGE_KEYS = {
        deviceId: 'realtime-vote-device-id',
        token: 'realtime-vote-token',
        choice: 'realtime-vote-choice'
    };

    const choiceGrid = document.getElementById('choiceGrid');
    const statsList = document.getElementById('statsList');
    const totalCountEl = document.getElementById('totalCount');
    const statusMessage = document.getElementById('voteStatus');
    const adminControls = document.getElementById('adminControls');
    const adminResetButton = document.getElementById('resetVotesButton');
    const adminStatus = document.getElementById('adminStatus');

    const socket = io();

    let selectedChoice = null;
    let locked = false;
    let pendingChoice = null;
    let tokenRequest = null;
    let tokenExhausted = false;

    getOrCreateDeviceId();

    const storedChoice = loadStoredChoice();
    if (storedChoice) {
        const numeric = Number(storedChoice);
        if (Number.isInteger(numeric) && numeric >= 1 && numeric <= TOTAL_OPTIONS) {
            selectedChoice = numeric;
            locked = true;
        }
    }

    const buttons = new Map();
    const statItems = new Map();

    renderChoices();
    renderStatsList();
    updateVoteStatus();
    initialiseAdminControls();
    ensureToken().catch(() => {});
    socket.on('connect', () => {
        if (locked) {
            statusMessage.textContent = '已投票，感謝參與！';
        } else if (!tokenExhausted) {
            statusMessage.textContent = '';
        }
        ensureToken().catch(() => {});
    });

    socket.on('voteCounts', handleStatsPayload);
    socket.on('stats', handleStatsPayload);

    socket.on('locked', () => {
        locked = true;
        if (pendingChoice !== null) {
            selectedChoice = pendingChoice;
            storeChoice(selectedChoice);
            pendingChoice = null;
        }
        lockButtons();
        updateVoteStatus();
    });

    socket.on('reset', (payload = {}) => {
        clearStoredChoice();
        clearStoredToken();
        localStorage.removeItem('hasVoted');
        localStorage.removeItem('myChoice');
        selectedChoice = null;
        pendingChoice = null;
        locked = false;
        tokenExhausted = false;
        setSelectedButton(null);
        unlockButtons();
        renderStats({}, 0);
        updateVoteStatus();
        const remaining = typeof payload.tokens === 'number' ? payload.tokens : null;
        statusMessage.textContent = remaining === null
            ? '投票已重置，請重新選擇。'
            : '投票已重置，本輪票券剩餘 ' + remaining + ' 張。';
        ensureToken(true).catch(() => {});
    });

    socket.on('disconnect', () => {
        if (!locked) {
            statusMessage.textContent = '連線中斷，請確認網路狀態。';
        }
    });

    socket.on('connect_error', () => {
        if (!locked) {
            statusMessage.textContent = '無法連線，系統將稍後重試。';
        }
    });

    function handleStatsPayload(payload = {}) {
        if (!payload || typeof payload !== 'object') {
            return;
        }

        const { counts = {}, total = 0 } = payload;
        renderStats(counts, total);

        if (selectedChoice !== null) {
            setSelectedButton(selectedChoice);
        }

        if (locked) {
            lockButtons();
        }
    }

    function renderChoices() {
        if (!choiceGrid) {
            return;
        }

        choiceGrid.innerHTML = '';
        buttons.clear();

        for (let option = 1; option <= TOTAL_OPTIONS; option += 1) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'choice-button';
            button.textContent = option;
            button.dataset.choice = String(option);
            button.setAttribute('aria-label', '選擇 ' + option);
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => {
                void handleVote(option);
            });

            choiceGrid.appendChild(button);
            buttons.set(option, button);
        }

        if (selectedChoice !== null) {
            setSelectedButton(selectedChoice);
        }

        if (locked) {
            lockButtons();
        }
    }

    function renderStatsList() {
        if (!statsList) {
            return;
        }

        statsList.innerHTML = '';
        statItems.clear();

        for (let option = 1; option <= TOTAL_OPTIONS; option += 1) {
            const item = document.createElement('div');
            item.className = 'stat-item';

            const label = document.createElement('span');
            label.className = 'stat-label';
            label.textContent = String(option);

            const bar = document.createElement('div');
            bar.className = 'stat-bar';
            bar.style.setProperty('--percent', '0%');

            const count = document.createElement('span');
            count.className = 'stat-count';
            count.textContent = '0';

            item.appendChild(label);
            item.appendChild(bar);
            item.appendChild(count);

            statsList.appendChild(item);
            statItems.set(option, { bar, count });
        }
    }
    function handleAdminReset() {
        const password = window.prompt('請輸入教師密碼');
        if (password === null) {
            setAdminStatus('已取消重置。');
            return;
        }

        if (!password.trim()) {
            setAdminStatus('密碼不得為空。');
            return;
        }

        setAdminStatus('正在重置...');
        let handled = false;
        const timeoutId = window.setTimeout(() => {
            if (!handled) {
                setAdminStatus('伺服器沒有回應，請稍後再試。');
            }
        }, 5000);

        socket.emit('admin-reset', { password }, (response = {}) => {
            handled = true;
            window.clearTimeout(timeoutId);

            if (!response.ok) {
                setAdminStatus('密碼錯誤，無法重置。');
                return;
            }

            const available = typeof response.tokens === 'number' ? response.tokens : null;
            setAdminStatus(available === null
                ? '重置完成。'
                : '重置完成，本輪票券：' + available + ' 張。');
        });
    }

    function renderStats(counts, total) {
        const values = [];
        for (let option = 1; option <= TOTAL_OPTIONS; option += 1) {
            const value = Number(counts[option] ?? counts[String(option)] ?? 0) || 0;
            values.push(value);
        }

        const maxCount = Math.max(1, ...values);

        values.forEach((value, index) => {
            const option = index + 1;
            const parts = statItems.get(option);
            if (!parts) {
                return;
            }
            const percent = value === 0 ? 0 : Math.round((value / maxCount) * 100);
            parts.bar.style.setProperty('--percent', percent + '%');
            parts.count.textContent = String(value);
        });

        if (totalCountEl) {
            totalCountEl.textContent = String(total || 0);
        }
    }
    async function handleVote(option) {
        if (locked) {
            statusMessage.textContent = '您已投過票，無法再次送出。';
            return;
        }

        pendingChoice = option;
        setSelectedButton(option);
        statusMessage.textContent = '送出中...';

        try {
            const token = await ensureToken();
            if (!token) {
                pendingChoice = null;
                setSelectedButton(selectedChoice);
                statusMessage.textContent = tokenExhausted
                    ? '票券已用完，本輪暫無名額。'
                    : '尚未取得票券，請稍後再試。';
                return;
            }

            socket.emit('vote', { token, choice: option }, (response = {}) => {
                if (response && response.ok) {
                    return;
                }

                pendingChoice = null;
                setSelectedButton(selectedChoice);

                if (!response || typeof response !== 'object') {
                    statusMessage.textContent = '送出失敗，請稍後再試。';
                    return;
                }

                if (response.error === 'invalid_token') {
                    clearStoredToken();
                    statusMessage.textContent = '票券已失效，系統正重新領取。';
                    ensureToken(true).catch(() => {});
                    return;
                }

                if (response.error === 'rate_limited') {
                    statusMessage.textContent = '操作過於頻繁，請稍後再試。';
                    return;
                }

                if (response.error === 'invalid_choice') {
                    statusMessage.textContent = '選項無效，請重新選擇。';
                    return;
                }

                statusMessage.textContent = '送出失敗，請稍後再試。';
            });
        } catch (_error) {
            pendingChoice = null;
            setSelectedButton(selectedChoice);
            statusMessage.textContent = tokenExhausted
                ? '票券已用完，本輪暫無名額。'
                : '無法取得票券，請稍後再試。';
        }
    }
    function lockButtons() {
        buttons.forEach((button, option) => {
            const isSelected = selectedChoice === option;
            button.disabled = true;
            button.classList.toggle('chosen', isSelected);
            button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        });
    }

    function unlockButtons() {
        buttons.forEach((button) => {
            button.disabled = false;
            button.classList.remove('chosen');
            button.setAttribute('aria-pressed', 'false');
        });
    }

    function setSelectedButton(option) {
        buttons.forEach((button, key) => {
            const isSelected = key === option;
            button.classList.toggle('chosen', isSelected);
            button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        });
    }

    function updateVoteStatus() {
        if (locked || selectedChoice !== null) {
            statusMessage.textContent = '已投票，感謝參與！';
        } else {
            statusMessage.textContent = '';
        }
    }

    function initialiseAdminControls() {
        if (!adminControls) {
            return;
        }

        if (adminResetButton) {
            adminResetButton.addEventListener('click', handleAdminReset);
        }

        setAdminStatus('');
    }

    function setAdminStatus(message) {
        if (adminStatus) {
            adminStatus.textContent = message || '';
        }
    }
    function loadStoredChoice() {
        return localStorage.getItem(STORAGE_KEYS.choice);
    }

    function storeChoice(choice) {
        localStorage.setItem(STORAGE_KEYS.choice, String(choice));
    }

    function clearStoredChoice() {
        localStorage.removeItem(STORAGE_KEYS.choice);
    }

    function clearStoredToken() {
        localStorage.removeItem(STORAGE_KEYS.token);
    }

    function ensureToken(forceRefresh = false) {
        if (forceRefresh) {
            tokenExhausted = false;
            clearStoredToken();
        }

        const existing = localStorage.getItem(STORAGE_KEYS.token);
        if (existing && !forceRefresh) {
            return Promise.resolve(existing);
        }

        if (tokenExhausted) {
            return Promise.resolve(null);
        }

        if (tokenRequest) {
            return tokenRequest;
        }

        const deviceId = getOrCreateDeviceId();

        tokenRequest = fetch('/claim', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ deviceId })
        })
            .then(async (response) => {
                if (!response.ok) {
                    if (response.status === 409) {
                        tokenExhausted = true;
                        if (!locked) {
                            statusMessage.textContent = '票券已用完，本輪暫無名額。';
                        }
                        return null;
                    }
                    throw new Error('claim_failed');
                }

                const payload = await response.json();
                if (payload && typeof payload.token === 'string' && payload.token) {
                    tokenExhausted = false;
                    localStorage.setItem(STORAGE_KEYS.token, payload.token);
                    return payload.token;
                }

                throw new Error('invalid_payload');
            })
            .catch((error) => {
                if (!locked) {
                    if (error && error.message === 'claim_failed') {
                        statusMessage.textContent = '領取票券失敗，請稍後再試。';
                    } else if (!tokenExhausted) {
                        statusMessage.textContent = '無法取得票券，請稍後再試。';
                    }
                }
                return null;
            })
            .finally(() => {
                tokenRequest = null;
            });

        return tokenRequest;
    }

    function getOrCreateDeviceId() {
        let deviceId = localStorage.getItem(STORAGE_KEYS.deviceId);
        if (!deviceId) {
            const legacy = localStorage.getItem('realtime-vote-user-id');
            deviceId = legacy || generateUuid();
            localStorage.setItem(STORAGE_KEYS.deviceId, deviceId);
        }
        return deviceId;
    }

    function generateUuid() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }

        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
            const random = Math.random() * 16 | 0;
            const value = char === 'x' ? random : (random & 0x3) | 0x8;
            return value.toString(16);
        });
    }
})();


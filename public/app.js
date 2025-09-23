(() => {
    const TOTAL_OPTIONS = 20;
    const STORAGE_KEYS = {
        userId: 'realtime-vote-user-id',
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

    socket.on('connect', () => {
        statusMessage.textContent = locked ? '已投票，感謝參與！' : '';
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

    socket.on('reset', () => {
        clearStoredChoice();
        selectedChoice = null;
        pendingChoice = null;
        locked = false;
        setSelectedButton(null);
        unlockButtons();
        renderStats({}, 0);
        updateVoteStatus();
        statusMessage.textContent = '投票已重置，請重新選擇。';
    });

    socket.on('disconnect', () => {
        statusMessage.textContent = '連線中斷，請確認網路狀態。';
    });

    socket.on('connect_error', () => {
        statusMessage.textContent = '無法連線，系統將稍後重試。';
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
            button.setAttribute('aria-label', `選擇 ${option}`);
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => handleVote(option));

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
            const statItem = document.createElement('div');
            statItem.className = 'stat-item';

            const label = document.createElement('span');
            label.className = 'stat-label';
            label.textContent = option;

            const bar = document.createElement('div');
            bar.className = 'stat-bar';
            bar.style.setProperty('--percent', '0%');

            const count = document.createElement('span');
            count.className = 'stat-count';
            count.textContent = '0';

            statItem.appendChild(label);
            statItem.appendChild(bar);
            statItem.appendChild(count);
            statsList.appendChild(statItem);

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

            setAdminStatus('重置成功，已通知所有人。');
        });
    }

    function setAdminStatus(message) {
        if (adminStatus) {
            adminStatus.textContent = message || '';
        }
    }

    function handleVote(option) {
        if (locked) {
            statusMessage.textContent = '您已投過票，無法再次送出。';
            return;
        }

        pendingChoice = option;
        setSelectedButton(option);
        statusMessage.textContent = '送出中...';

        socket.emit('vote', {
            userId: getOrCreateUserId(),
            choice: option
        });
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
            parts.bar.style.setProperty('--percent', `${percent}%`);
            parts.count.textContent = String(value);
        });

        if (totalCountEl) {
            totalCountEl.textContent = String(total || 0);
        }
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

        const params = new URLSearchParams(window.location.search);
        const isTeacher = params.get('teacher') === '1';

        if (!isTeacher) {
            adminControls.remove();
            return;
        }

        adminControls.hidden = false;

        if (adminResetButton) {
            adminResetButton.addEventListener('click', handleAdminReset);
        }

        setAdminStatus('');
    }

    function getOrCreateUserId() {
        let userId = localStorage.getItem(STORAGE_KEYS.userId);
        if (!userId) {
            userId = generateUuid();
            localStorage.setItem(STORAGE_KEYS.userId, userId);
        }
        return userId;
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

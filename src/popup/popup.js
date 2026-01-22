/**
 * Popup Logic - Solutto Recorder
 * Gerencia a interface de seleção de opções e inicia a solicitação de gravação.
 */

const ACTIONS = {
    REQUEST_RECORDING: "request_recording",
    REQUEST_DEVICES: "request_devices",
    GET_STATUS: "GET_RECORDING_STATUS"
};

const STORAGE_KEYS = {
    CAMERA: "cameraSelect",
    MIC: "microphoneSelect",
    SOURCE: "sourceSelect",
    TIMER: "waitSeconds",      
    USE_TIMER: "timeoutCheckbox" 
};

const ui = {
    sources: document.querySelectorAll('.source-option'),
    sliderContainer: document.querySelector('.select-source-container'),
    cameraSelect: document.getElementById('camera-select'),
    micSelect: document.getElementById('mic-select'),
    timerSelect: document.getElementById('timer-select'),
    useTimerCheckbox: document.getElementById('use-timer'),
    startBtn: document.getElementById('start-btn'),
    errorMsg: document.getElementById('device-error-msg'),
    closeBtn: document.getElementById('close-btn'),
    shortcutsToggle: document.getElementById('shortcuts-toggle'),
    shortcutsContent: document.getElementById('shortcuts-content')
};

document.addEventListener('DOMContentLoaded', async () => {
    const status = await checkGlobalStatus();

    if (status.isBusy && status.reason === "recording") {
        showRecordingState(status.recordingTabId);
    } else if (status.isBusy && status.reason === "processing") {
        showProcessingState();
    } else {
        ui.startBtn.disabled = true;
        await loadPreferences();
        await refreshDevicesLocal();
        setupListeners();
    }
});

/**
 * Consulta o estado do Service Worker
 */
async function checkGlobalStatus() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: ACTIONS.GET_STATUS }, (response) => {
            if (response && response.isBusy) {
                resolve({ 
                    isBusy: true, 
                    reason: response.reason,
                    recordingTabId: response.recordingTabId 
                });
            } else {
                resolve({ isBusy: false });
            }
        });
    });
}

function showProcessingState() {
    ui.startBtn.disabled = true;
    ui.startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processando Vídeo...';
    if (ui.errorMsg) {
        ui.errorMsg.style.display = 'block';
        ui.errorMsg.innerHTML = 'Aguarde a finalização do vídeo anterior.';
    }
}

function showRecordingState(recordingTabId) {
    const settingsDiv = document.querySelector('.settings-group');
    const sourceDiv = document.querySelector('.select-source-container');
    
    if(settingsDiv) settingsDiv.style.display = 'none';
    if(sourceDiv) sourceDiv.style.display = 'none';

    ui.startBtn.disabled = false;
    ui.startBtn.classList.add('stop-mode');
    ui.startBtn.innerHTML = '<i class="fa-solid fa-square"></i> PARAR GRAVAÇÃO';
    
    const newBtn = ui.startBtn.cloneNode(true);
    ui.startBtn.parentNode.replaceChild(newBtn, ui.startBtn);
    ui.startBtn = newBtn;

    ui.startBtn.addEventListener('click', () => {
        ui.startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Parando...';
        ui.startBtn.disabled = true;
        
        const stopPayload = { 
            action: "keyboard_command", 
            command: "stop"
        };

        if (recordingTabId) {
            chrome.tabs.sendMessage(recordingTabId, stopPayload, (resp) => {
                setTimeout(() => window.close(), 500); 
            });
        } else {
            chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                if(tabs[0]) chrome.tabs.sendMessage(tabs[0].id, stopPayload);
                window.close();
            });
        }
    });

    if (ui.errorMsg) {
        ui.errorMsg.style.display = 'block';
        ui.errorMsg.style.color = '#e74c3c';
        ui.errorMsg.innerHTML = '<i class="fa-solid fa-circle fa-beat"></i> Gravando em andamento...';
    }
}

/**
 * Carrega e APLICA as configurações salvas no Chrome Storage.
 */
async function loadPreferences() {
    const data = await chrome.storage.local.get([
        STORAGE_KEYS.SOURCE,
        STORAGE_KEYS.TIMER,
        STORAGE_KEYS.USE_TIMER
    ]);

    if (data[STORAGE_KEYS.SOURCE]) {
        const sourcesArray = Array.from(ui.sources);
        const targetIndex = sourcesArray.findIndex(s => s.dataset.source === data[STORAGE_KEYS.SOURCE]);
        if (targetIndex !== -1) {
            ui.sources.forEach(s => s.classList.remove('selected'));
            ui.sources[targetIndex].classList.add('selected');
            ui.sliderContainer.setAttribute('data-selected-index', targetIndex);
        }
    }

    if (data[STORAGE_KEYS.TIMER]) {
        ui.timerSelect.value = data[STORAGE_KEYS.TIMER];
    }

    if (data[STORAGE_KEYS.USE_TIMER] !== undefined) {
        ui.useTimerCheckbox.checked = data[STORAGE_KEYS.USE_TIMER];
    }
}

function setupListeners() {
    // Slider de Fontes
    ui.sources.forEach((src, index) => {
        src.addEventListener('click', () => {
            ui.sources.forEach(s => s.classList.remove('selected'));
            src.classList.add('selected');
            ui.sliderContainer.setAttribute('data-selected-index', index);
            savePreference(STORAGE_KEYS.SOURCE, src.dataset.source);
            if (ui.errorMsg) ui.errorMsg.style.display = 'none';
        });
    });

    ui.timerSelect.addEventListener('change', (e) => savePreference(STORAGE_KEYS.TIMER, e.target.value));
    ui.useTimerCheckbox.addEventListener('change', (e) => savePreference(STORAGE_KEYS.USE_TIMER, e.target.checked));

    ui.cameraSelect.addEventListener('change', (e) => {
        const label = e.target.options[e.target.selectedIndex]?.text;
        if (label) savePreference(STORAGE_KEYS.CAMERA, label);
    });

    ui.micSelect.addEventListener('change', (e) => {
        const label = e.target.options[e.target.selectedIndex]?.text;
        if (label) savePreference(STORAGE_KEYS.MIC, label);
    });

    ui.startBtn.addEventListener('click', handleStart);
    ui.closeBtn.addEventListener('click', closePopup);

    // Atalhos
    if (ui.shortcutsToggle) {
        ui.shortcutsToggle.addEventListener('click', () => {
            ui.shortcutsContent.classList.toggle('open');
            ui.shortcutsToggle.classList.toggle('active');
        });
    }

    // Estúdio
    const btnStudio = document.getElementById('btn-open-studio');
    if (btnStudio) {
        btnStudio.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/editor.html?mode=studio') });
        });
    }
}

async function handleStart() {
    const tab = await getActiveTab();
    if (!tab) return;

    if (ui.errorMsg) ui.errorMsg.style.display = 'none';

    const selectedElement = document.querySelector('.source-option.selected');
    if (!selectedElement) return;

    const selectedSource = selectedElement.dataset.source;

    const hasCamera = !!ui.cameraSelect.value;
    const hasMic = !!ui.micSelect.value;

    const isWebcamMode = selectedSource === 'webcam';

    if ((isWebcamMode && !hasCamera) || (!hasCamera && !hasMic)) {
        if (ui.errorMsg) {
            ui.errorMsg.style.display = 'block';
            ui.errorMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> ' +
                (isWebcamMode ? "Câmera é obrigatória neste modo." : "Nenhum dispositivo selecionado.");
        }
        return; 
    }

    const useTimer = ui.useTimerCheckbox.checked;

    const selectedMicOption = ui.micSelect.options[ui.micSelect.selectedIndex];
    const micLabel = selectedMicOption.value ? selectedMicOption.text : null;

    const selectedCamOption = ui.cameraSelect.options[ui.cameraSelect.selectedIndex];
    const camLabel = selectedCamOption.value ? selectedCamOption.text : null;

    const payload = {
        action: ACTIONS.REQUEST_RECORDING,
        type: selectedSource,
        webcamLabel: camLabel,
        microfoneLabel: micLabel,
        webcamId: ui.cameraSelect.value,
        microfoneId: ui.micSelect.value,
        timeout: useTimer ? parseInt(ui.timerSelect.value) : 0,
        tabId: tab.id
    };

    ui.startBtn.disabled = true;
    ui.startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Iniciando...';

    chrome.tabs.sendMessage(tab.id, payload, (response) => {
        if (chrome.runtime.lastError || (response && response.error)) {
            ui.startBtn.disabled = false;
            ui.startBtn.innerHTML = '<i class="fa-solid fa-circle-dot"></i> Iniciar gravação';
            alert("Erro: " + (chrome.runtime.lastError?.message || response?.error));
        } else if (response && response.allow) {
            closePopup();
        }
    });
}

async function refreshDevicesLocal() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        stream.getTracks().forEach(t => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        populateSelect(ui.cameraSelect, devices.filter(d => d.kind === 'videoinput'), "Sem câmera");
        populateSelect(ui.micSelect, devices.filter(d => d.kind === 'audioinput'), "Sem microfone");

        await restoreDeviceSelection();
        ui.startBtn.disabled = false;
    } catch (error) {
        console.warn("Permissão negada no Popup:", error);
        ui.cameraSelect.innerHTML = '<option value="">Permissão negada</option>';
        ui.micSelect.innerHTML = '<option value="">Permissão negada</option>';
        ui.startBtn.disabled = false;
    }
}

function populateSelect(select, devices, defaultLabel) {
    select.innerHTML = '';
    const def = document.createElement('option');
    def.value = ""; def.text = defaultLabel;
    select.appendChild(def);
    devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId; opt.text = d.label || `Disp. ${d.deviceId.substring(0, 5)}`;
        select.appendChild(opt);
    });
}

async function restoreDeviceSelection() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.CAMERA, STORAGE_KEYS.MIC]);
    if (data[STORAGE_KEYS.CAMERA]) setSelectByLabel(ui.cameraSelect, data[STORAGE_KEYS.CAMERA]);
    if (data[STORAGE_KEYS.MIC]) setSelectByLabel(ui.micSelect, data[STORAGE_KEYS.MIC]);
}

function setSelectByLabel(select, label) {
    const opt = Array.from(select.options).find(o => o.text === label);
    if (opt) select.value = opt.value;
}

function savePreference(key, value) { chrome.storage.local.set({ [key]: value }); }

async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
}

function closePopup() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                func: () => {
                    const el = document.getElementById("solutto-recorder-iframe");
                    if (el) { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }
                }
            });
        }
    });
}
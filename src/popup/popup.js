/**
 * Popup Logic - Solutto Recorder
 * Gerencia a interface de seleção de opções (Aba, Tela, Webcam) e inicia a solicitação de gravação.
 * Roda dentro do iframe injetado na página do usuário.
 */

const ACTIONS = {
    REQUEST_RECORDING: "request_recording",
    REQUEST_DEVICES: "request_devices"
};

const STORAGE_KEYS = {
    CAMERA: "cameraSelect",
    MIC: "microphoneSelect",
    SOURCE: "sourceSelect", // tab, screen, webcam
    TIMER: "timerValue",
    USE_TIMER: "useTimer"
};

// Elementos da Interface
const ui = {
    sources: document.querySelectorAll('.source-option'),
    sliderContainer: document.querySelector('.select-source-container'),

    cameraSelect: document.getElementById('camera-select'),
    micSelect: document.getElementById('mic-select'),
    timerSelect: document.getElementById('timer-select'),
    useTimerCheckbox: document.getElementById('use-timer'),
    startBtn: document.getElementById('start-btn'),
    errorMsg: document.getElementById('device-error-msg'),

    shortcutsToggle: document.getElementById('shortcuts-toggle'),
    shortcutsContent: document.getElementById('shortcuts-content'),
    closeBtn: document.getElementById('close-btn')
};

// Inicialização ao carregar o DOM
document.addEventListener('DOMContentLoaded', async () => {
    ui.startBtn.disabled = true;

    await loadPreferences();

    refreshDevicesLocal();

    setupListeners();
});

/**
 * Pede permissão de mídia e preenche os selects.
 * Executa diretamente no contexto do iframe.
 */
async function refreshDevicesLocal() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        stream.getTracks().forEach(t => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter(d => d.kind === 'videoinput');
        const microphones = devices.filter(d => d.kind === 'audioinput');

        populateSelect(ui.cameraSelect, cameras, "Sem câmera");
        populateSelect(ui.micSelect, microphones, "Sem microfone");

        restoreDeviceSelection();

    } catch (error) {
        console.warn("Permissão negada no Popup:", error);
        ui.cameraSelect.innerHTML = '<option value="">Permissão negada</option>';
        ui.micSelect.innerHTML = '<option value="">Permissão negada</option>';
    } finally {
        ui.startBtn.disabled = false;
    }
}

/**
 * Handler do botão "Iniciar Gravação".
 */
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
        if (chrome.runtime.lastError) {
            ui.startBtn.disabled = false;
            ui.startBtn.innerHTML = '<i class="fa-solid fa-circle-dot"></i> Iniciar gravação';
            alert("Erro: Recarregue a página para gravar.");
            return;
        }

        if (response && response.allow) {
            closePopup();
        } else {
            ui.startBtn.disabled = false;
            ui.startBtn.innerHTML = '<i class="fa-solid fa-circle-dot"></i> Iniciar gravação';
            if (response && response.error) alert("Erro: " + response.error);
        }
    });
}

function closePopup() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                func: () => {
                    const el = document.getElementById("solutto-recorder-iframe");
                    if (el) {
                        el.style.opacity = "0";
                        setTimeout(() => el.remove(), 300);
                    }
                }
            });
        }
    });
}

function setupListeners() {
    ui.sources.forEach((src, index) => {
        src.addEventListener('click', () => {
            ui.sources.forEach(s => s.classList.remove('selected'));
            src.classList.add('selected');
            ui.sliderContainer.setAttribute('data-selected-index', index);
            savePreference(STORAGE_KEYS.SOURCE, src.dataset.source);

            if (ui.errorMsg) ui.errorMsg.style.display = 'none';

            if (src.dataset.source === 'webcam') {
                ensureCameraSelected();
            }
        });
    });

    ui.cameraSelect.addEventListener('change', (e) => {
        if (ui.errorMsg) ui.errorMsg.style.display = 'none'; 
        const selectedOption = e.target.options[e.target.selectedIndex];
        if (selectedOption) savePreference(STORAGE_KEYS.CAMERA, selectedOption.text);
    });

    ui.micSelect.addEventListener('change', (e) => {
        if (ui.errorMsg) ui.errorMsg.style.display = 'none'; 
        const selectedOption = e.target.options[e.target.selectedIndex];
        if (selectedOption) savePreference(STORAGE_KEYS.MIC, selectedOption.text);
    });

    ui.timerSelect.addEventListener('change', (e) => savePreference(STORAGE_KEYS.TIMER, e.target.value));
    ui.useTimerCheckbox.addEventListener('change', (e) => savePreference(STORAGE_KEYS.USE_TIMER, e.target.checked));

    ui.startBtn.addEventListener('click', handleStart);
    ui.closeBtn.addEventListener('click', closePopup);

    ui.shortcutsToggle.addEventListener('click', () => {
        ui.shortcutsContent.classList.toggle('open');
        ui.shortcutsToggle.classList.toggle('active');
    });

    document.getElementById('btn-open-studio').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/editor.html?mode=studio') });
    });
}

function populateSelect(select, devices, defaultLabel) {
    select.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = ""; defaultOption.text = defaultLabel;
    select.appendChild(defaultOption);

    if (!devices || devices.length === 0) return;

    devices.forEach(d => {
        const option = document.createElement('option');
        option.value = d.deviceId;
        option.text = d.label || `Dispositivo ${d.deviceId.substring(0, 5)}`;
        select.appendChild(option);
    });
}

async function loadPreferences() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.SOURCE, STORAGE_KEYS.TIMER, STORAGE_KEYS.USE_TIMER]);

    if (data[STORAGE_KEYS.SOURCE]) {
        const sourcesArray = Array.from(ui.sources);
        const targetIndex = sourcesArray.findIndex(s => s.dataset.source === data[STORAGE_KEYS.SOURCE]);

        if (targetIndex !== -1) {
            ui.sources.forEach(s => s.classList.remove('selected'));
            ui.sources[targetIndex].classList.add('selected');
            ui.sliderContainer.setAttribute('data-selected-index', targetIndex);
        }
    }
    if (data[STORAGE_KEYS.TIMER]) ui.timerSelect.value = data[STORAGE_KEYS.TIMER];
    if (data[STORAGE_KEYS.USE_TIMER] !== undefined) ui.useTimerCheckbox.checked = data[STORAGE_KEYS.USE_TIMER];
}

async function restoreDeviceSelection() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.CAMERA, STORAGE_KEYS.MIC]);
    if (data[STORAGE_KEYS.CAMERA]) setSelectByLabel(ui.cameraSelect, data[STORAGE_KEYS.CAMERA]);
    if (data[STORAGE_KEYS.MIC]) setSelectByLabel(ui.micSelect, data[STORAGE_KEYS.MIC]);
}

function setSelectByLabel(select, label) {
    const options = Array.from(select.options);
    const matchingOption = options.find(opt => opt.text === label);
    if (matchingOption) select.value = matchingOption.value;
}

function savePreference(key, value) { chrome.storage.local.set({ [key]: value }); }

function ensureCameraSelected() {
    if (!ui.cameraSelect.value && ui.cameraSelect.options.length > 1) {
        ui.cameraSelect.selectedIndex = 1;
        savePreference(STORAGE_KEYS.CAMERA, ui.cameraSelect.value);
    }
}

async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
}
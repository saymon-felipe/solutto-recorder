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
    // NodeList com as opções de fonte (Aba, Tela, Câmera)
    sources: document.querySelectorAll('.source-option'),
    // Container pai do slider (usado para aplicar data-attributes de posição)
    sliderContainer: document.querySelector('.select-source-container'),
    
    cameraSelect: document.getElementById('camera-select'),
    micSelect: document.getElementById('mic-select'),
    timerSelect: document.getElementById('timer-select'),
    useTimerCheckbox: document.getElementById('use-timer'),
    startBtn: document.getElementById('start-btn'),
    shortcutsToggle: document.getElementById('shortcuts-toggle'),
    shortcutsContent: document.getElementById('shortcuts-content'),
    closeBtn: document.getElementById('close-btn')
};

// Inicialização ao carregar o DOM
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Carrega preferências salvas (última seleção)
    await loadPreferences();
    
    // 2. Pede permissão e lista dispositivos locais
    refreshDevicesLocal(); 
    
    // 3. Configura os eventos de clique e mudança
    setupListeners();
});

/**
 * Pede permissão de mídia (se necessário) e preenche os selects com câmeras e microfones.
 * Executa diretamente no contexto da extensão (iframe), garantindo acesso aos labels corretos.
 */
async function refreshDevicesLocal() {
    try {
        // Pede permissão rápida para desbloquear labels (Labels ficam vazios sem permissão)
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        
        // Para os tracks imediatamente, pois só queríamos a permissão
        stream.getTracks().forEach(t => t.stop());

        // Lista dispositivos
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter(d => d.kind === 'videoinput');
        const microphones = devices.filter(d => d.kind === 'audioinput');

        // Popula os selects
        populateSelect(ui.cameraSelect, cameras, "Sem câmera");
        populateSelect(ui.micSelect, microphones, "Sem microfone");

        // Restaura a seleção salva (se o dispositivo ainda existir)
        restoreDeviceSelection();

    } catch (error) {
        console.warn("Permissão negada no Popup:", error);
        // Fallback visual em caso de erro
        ui.cameraSelect.innerHTML = '<option value="">Permissão negada</option>';
        ui.micSelect.innerHTML = '<option value="">Permissão negada</option>';
    }
}

/**
 * Handler do botão "Iniciar Gravação".
 * Coleta as opções selecionadas e envia mensagem para o Content Script iniciar o processo.
 */
async function handleStart() {
    const tab = await getActiveTab();
    if (!tab) return;

    const selectedElement = document.querySelector('.source-option.selected');
    
    if (!selectedElement) {
        console.error("Nenhuma fonte selecionada.");
        return;
    }

    const selectedSource = selectedElement.dataset.source;
    const useTimer = ui.useTimerCheckbox.checked;
    
    // Recupera Labels além dos IDs para garantir pareamento correto no content script
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

    // Validação básica para modo Câmera
    if (selectedSource === 'webcam' && !ui.cameraSelect.value) {
        alert("Por favor, selecione uma câmera para gravar neste modo.");
        return;
    }

    // Feedback visual de carregamento
    ui.startBtn.disabled = true;
    ui.startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Iniciando...';

    // Envia comando para a aba ativa
    chrome.tabs.sendMessage(tab.id, payload, (response) => {
        ui.startBtn.disabled = false;
        ui.startBtn.innerHTML = '<i class="fa-solid fa-circle-dot"></i> Iniciar gravação';

        if (chrome.runtime.lastError) {
            alert("Erro de comunicação com a página. Tente recarregar a aba.");
            console.error(chrome.runtime.lastError);
            return;
        }

        // Se tudo certo, fecha o popup
        if (response && response.allow) {
            closePopup();
        } else if (response && response.error) {
            alert("Erro ao iniciar: " + response.error);
        }
    });
}

/**
 * Fecha o iframe do popup injetado na página.
 * Envia um script para a página remover o elemento DOM.
 */
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

/**
 * Configura todos os listeners de eventos da interface.
 */
function setupListeners() {
    // Lógica do Slider de Fontes
    ui.sources.forEach((src, index) => {
        src.addEventListener('click', () => {
            // Remove seleção visual antiga
            ui.sources.forEach(s => s.classList.remove('selected'));
            
            // Adiciona na nova
            src.classList.add('selected');
            
            // Atualiza o índice no pai para o CSS mover o slider
            ui.sliderContainer.setAttribute('data-selected-index', index);

            // Salva preferência
            savePreference(STORAGE_KEYS.SOURCE, src.dataset.source);
            
            // Se selecionar webcam, garante que uma câmera esteja selecionada no dropdown
            if (src.dataset.source === 'webcam') {
                ensureCameraSelected();
            }
        });
    });

    // Listeners de mudança para salvar preferências automaticamente
    ui.cameraSelect.addEventListener('change', (e) => savePreference(STORAGE_KEYS.CAMERA, e.target.value));
    ui.micSelect.addEventListener('change', (e) => savePreference(STORAGE_KEYS.MIC, e.target.value));
    ui.timerSelect.addEventListener('change', (e) => savePreference(STORAGE_KEYS.TIMER, e.target.value));
    ui.useTimerCheckbox.addEventListener('change', (e) => savePreference(STORAGE_KEYS.USE_TIMER, e.target.checked));

    // Botões de ação
    ui.startBtn.addEventListener('click', handleStart);
    ui.closeBtn.addEventListener('click', closePopup);

    ui.shortcutsToggle.addEventListener('click', () => {
        ui.shortcutsContent.classList.toggle('open');
        ui.shortcutsToggle.classList.toggle('active');
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
        // Trunca nomes longos para não quebrar o layout
        option.text = d.label || `Dispositivo ${d.deviceId.substring(0, 5)}`;
        select.appendChild(option);
    });
}

/**
 * Carrega as preferências salvas no Chrome Storage e aplica na UI.
 */
async function loadPreferences() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.SOURCE, STORAGE_KEYS.TIMER, STORAGE_KEYS.USE_TIMER]);
    
    if (data[STORAGE_KEYS.SOURCE]) {
        // Encontra o índice baseado no valor salvo (tab, screen, webcam) para posicionar o slider
        const sourcesArray = Array.from(ui.sources);
        const targetIndex = sourcesArray.findIndex(s => s.dataset.source === data[STORAGE_KEYS.SOURCE]);
        
        if (targetIndex !== -1) {
            ui.sources.forEach(s => s.classList.remove('selected'));
            ui.sources[targetIndex].classList.add('selected');
            
            // Aplica a posição inicial sem animação
            ui.sliderContainer.setAttribute('data-selected-index', targetIndex);
        }
    }
    if (data[STORAGE_KEYS.TIMER]) ui.timerSelect.value = data[STORAGE_KEYS.TIMER];
    if (data[STORAGE_KEYS.USE_TIMER] !== undefined) ui.useTimerCheckbox.checked = data[STORAGE_KEYS.USE_TIMER];
}

async function restoreDeviceSelection() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.CAMERA, STORAGE_KEYS.MIC]);
    if (data[STORAGE_KEYS.CAMERA]) setSelectValue(ui.cameraSelect, data[STORAGE_KEYS.CAMERA]);
    if (data[STORAGE_KEYS.MIC]) setSelectValue(ui.micSelect, data[STORAGE_KEYS.MIC]);
}

function setSelectValue(select, value) {
    const exists = Array.from(select.options).some(o => o.value === value);
    if (exists) select.value = value;
}

function savePreference(key, value) { chrome.storage.local.set({ [key]: value }); }

function ensureCameraSelected() {
    if (!ui.cameraSelect.value && ui.cameraSelect.options.length > 1) {
        ui.cameraSelect.selectedIndex = 1; // Seleciona a primeira câmera disponível
        savePreference(STORAGE_KEYS.CAMERA, ui.cameraSelect.value);
    }
}

async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
}
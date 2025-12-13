/**
 * Content Script - Solutto Recorder
 * Responsável pela injeção da UI, captura de mídia (Alta Qualidade) e orquestração da gravação.
 */
(function () {
    // Evita múltiplas injeções
    if (window.SoluttoContentInitialized) return;
    window.SoluttoContentInitialized = true;

    // Dependências Globais (Injetadas pelo Background)
    const C = window.SoluttoConstants;
    const recorderManager = new window.SoluttoRecorderManager();
    const uiManager = window.SoluttoUIManager.getInstance();
    
    // Estado Local
    let audioMixer = null;
    let signalingService = null;
    let activeMainStream = null;      
    let activeSecondaryStream = null; 

    // Verifica se há uma sessão interrompida para recuperar (F5/Crash)
    checkRecoverySession();

    // --- COMUNICAÇÃO COM O BACKGROUND ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        handleMessage(message).then(sendResponse).catch(err => {
            console.error("[Solutto Content] Erro no handler:", err);
            sendResponse({ allow: false, error: err.message });
        });
        return true; // Mantém canal aberto para resposta assíncrona
    });

    async function handleMessage(msg) {
        switch (msg.action) {
            case C.ACTIONS.REQUEST_RECORDING: 
                return await startRecordingSession(msg);
            
            case C.ACTIONS.WEBRTC_ANSWER:
                if (signalingService) await signalingService.handleAnswer(msg.answer);
                return { success: true };
            
            case C.ACTIONS.WEBRTC_CANDIDATE:
                if (signalingService) await signalingService.handleCandidate(msg.candidate);
                return { success: true };
            
            case C.ACTIONS.KILL_UI: 
                await cleanupSession(); 
                return { success: true };
            
            case C.ACTIONS.KEYBOARD_COMMAND: 
                handleKeyboardCommand(msg.command); 
                return { success: true };
            
            default: 
                return { result: "ignored" };
        }
    }

    /**
     * Gerencia atalhos de teclado globais.
     */
    function handleKeyboardCommand(command) {
        if (recorderManager.status === "idle" && recorderManager.status !== "paused") return;
        
        switch (command) {
            case C.COMMANDS.STOP: 
                recorderManager.stop(); 
                break;
            case C.COMMANDS.CANCEL: 
                if (confirm("Deseja cancelar a gravação atual?")) recorderManager.cancel(); 
                break;
            case C.COMMANDS.TOGGLE_PAUSE:
                if (recorderManager.status === "recording") recorderManager.pause();
                else if (recorderManager.status === "paused") handleRecoveredUserAction("resume", null);
                break;
        }
    }

    /**
     * Fecha o iframe do popup com animação suave.
     */
    function closePopup() {
        const iframe = document.getElementById("solutto-recorder-iframe");
        if (iframe) {
            iframe.style.transition = "opacity 0.3s ease";
            iframe.style.opacity = "0";
            setTimeout(() => iframe.remove(), 300);
        }
    }

    /**
     * Inicia uma nova sessão de gravação.
     * 1. Limpa sessões anteriores
     * 2. Captura streams (Alta Qualidade)
     * 3. Configura Mixagem
     * 4. Inicia UI e Gravador
     */
    async function startRecordingSession(options) {
        try {
            closePopup();
            await cleanupSession();

            const { mainStream, secondaryStream } = await acquireMediaStreams(options);
            activeMainStream = mainStream;
            activeSecondaryStream = secondaryStream;

            // Inicializa Mixer de Áudio
            audioMixer = new window.SoluttoAudioMixer();
            const streamForRecording = audioMixer.mix(mainStream, secondaryStream);

            // Configura espelhamento de áudio para Aba
            if (options.type === C.SOURCE_TYPE.TAB) {
                await setupTabMirroring(mainStream, options.tabId);
            }

            // Callback: Injeta webcam na UI assim que ela estiver pronta
            const onUIReady = async () => {
                await injectWebcam(options, options.type);
            };

            // Inicia fluxo do RecorderManager (UI -> Countdown -> Gravação)
            await recorderManager.start(
                streamForRecording, 
                options, 
                () => cleanupSession(), // Callback onStop
                onUIReady               // Callback onUIReady
            );

            return { allow: true };

        } catch (error) {
            console.error("[Solutto Content] Falha ao iniciar:", error);
            await cleanupSession();
            throw error;
        }
    }

    /**
     * Limpa recursos, para streams e remove UI.
     */
    async function cleanupSession() {
        if (activeMainStream) {
            activeMainStream.getTracks().forEach(track => track.stop());
            activeMainStream = null;
        }
        if (activeSecondaryStream) {
            activeSecondaryStream.getTracks().forEach(track => track.stop());
            activeSecondaryStream = null;
        }
        if (audioMixer) {
            audioMixer.cleanup();
            audioMixer = null;
        }
        if (signalingService) {
            signalingService.cleanup();
            signalingService = null;
        }
        
        await uiManager.cleanup();
        
        // Avisa background para fechar abas de playback auxiliares
        chrome.runtime.sendMessage({ action: C.ACTIONS.CLOSE_TABS });
    }

    /**
     * Configura WebRTC para capturar áudio da aba (Tab Capture API).
     */
    async function setupTabMirroring(stream, tabId) {
        signalingService = new window.SoluttoSignalingService();
        signalingService.startConnection(stream);
        const offer = await signalingService.createOffer();
        chrome.runtime.sendMessage({ 
            action: C.ACTIONS.WEBRTC_OFFER, 
            offer: offer, 
            targetTabId: tabId || null 
        });
    }

    /**
     * Captura streams de vídeo/áudio com configurações de ALTA QUALIDADE.
     * Tenta 1080p/4K @ 60fps.
     */
    async function acquireMediaStreams(options) {
        let mainStream = null;
        let secondaryStream = null;
        
        let localMicId = null;
        let localCamId = null;
        
        if (options.microfoneLabel) {
            const foundId = await findDeviceIdByLabel('audio', options.microfoneLabel);
            localMicId = foundId || options.microfoneId;
        } else {
            localMicId = options.microfoneId;
        }

        if (options.webcamLabel) {
            const foundId = await findDeviceIdByLabel('video', options.webcamLabel);
            localCamId = foundId || options.webcamId;
        } else {
            localCamId = options.webcamId;
        }

        // --- CONSTRAINTS DE ALTA QUALIDADE ---
        const highQualityConstraints = {
            audio: {
                echoCancellation: false, 
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 48000
            },
            video: {
                width: { ideal: 1920, max: 3840 },
                height: { ideal: 1080, max: 2160 },
                frameRate: { ideal: 30, max: 30 },
                resizeMode: "none" 
            }
        };

        // --- MODO: ABA (TAB) ---
        if (options.type === C.SOURCE_TYPE.TAB) {
            await chrome.runtime.sendMessage({ action: C.ACTIONS.OPEN_PLAYBACK_TAB, tabId: null });
            const streamId = await chrome.runtime.sendMessage({ action: "requestStream", tabId: null });
            if (!streamId) throw new Error("Falha ao obter ID da aba.");

            mainStream = await navigator.mediaDevices.getUserMedia({
                audio: { 
                    mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } 
                },
                video: { 
                    mandatory: { 
                        chromeMediaSource: "tab", 
                        chromeMediaSourceId: streamId, 
                        maxWidth: 3840, maxHeight: 2160, maxFrameRate: 30 
                    } 
                }
            });

        // --- MODO: TELA INTEIRA (SCREEN) ---
        } else if (options.type === C.SOURCE_TYPE.SCREEN) {
            mainStream = await navigator.mediaDevices.getDisplayMedia({
                audio: highQualityConstraints.audio,
                video: { ...highQualityConstraints.video, displaySurface: "monitor" }
            });

        // --- MODO: SOMENTE WEBCAM ---
        } else if (options.type === C.SOURCE_TYPE.WEBCAM) {
            const videoConstraints = {
                ...highQualityConstraints.video,
                deviceId: localCamId ? { exact: localCamId } : undefined
            };
            
            const audioConstraints = {
                ...highQualityConstraints.audio,
                deviceId: localMicId ? { exact: localMicId } : undefined
            };

            try {
                mainStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
            } catch (e) {
                console.warn("[Content] Fallback de webcam para padrão.");
                mainStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            }
            return { mainStream, secondaryStream: null }; 
        }

        // --- STREAM SECUNDÁRIA (MICROFONE) ---
        if (localMicId || options.microfoneLabel) {
            const micConstraints = {
                deviceId: localMicId ? { exact: localMicId } : undefined,
                echoCancellation: true, 
                noiseSuppression: true,
                sampleRate: 48000
            };

            try {
                secondaryStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
            } catch (e) {
                // Fallback silencioso se o ID específico falhar (usa o padrão)
                try { secondaryStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (err) {}
            }
        }

        return { mainStream, secondaryStream };
    }

    /**
     * Injeta o preview da webcam na UI flutuante.
     */
    async function injectWebcam(options, recordingType) {
        const label = options.webcamLabel;
        
        // Webcam PIP (Pequena) - Usado em Tela/Aba
        if ((recordingType === C.SOURCE_TYPE.SCREEN || recordingType === C.SOURCE_TYPE.TAB) && label) {
             const camStream = await getWebcamStream(label);
             if (camStream) uiManager.showWebcamPreview(camStream);
        }
        
        // Webcam Full (Grande) - Usado no modo Webcam
        if (recordingType === C.SOURCE_TYPE.WEBCAM) {
            if (activeMainStream) uiManager.showLargeWebcamPreview(activeMainStream);
            else {
                const camStream = await getWebcamStream(label);
                if (camStream) uiManager.showLargeWebcamPreview(camStream);
            }
        }
    }

    /**
     * Helper para pegar stream de webcam isolada.
     */
    async function getWebcamStream(label) {
        try {
            const id = await findDeviceIdByLabel('video', label);
            const constraints = id ? { video: { deviceId: { exact: id } } } : { video: true };
            return await navigator.mediaDevices.getUserMedia(constraints);
        } catch(e) { return null; }
    }

    /**
     * Helper para encontrar ID de dispositivo pelo Label.
     */
    async function findDeviceIdByLabel(kind, label) {
        if (!label) return null;
        try {
            // Solicita permissão temporária para enumerar devices
            const stream = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: true } : { video: true });
            stream.getTracks().forEach(t => t.stop());
            
            const devices = await navigator.mediaDevices.enumerateDevices();
            const target = devices.find(d => d.kind === (kind === 'audio' ? 'audioinput' : 'videoinput') && d.label === label);
            return target ? target.deviceId : null;
        } catch (e) { return null; }
    }

    // --- LÓGICA DE RECUPERAÇÃO DE SESSÃO (CRASH RECOVERY) ---

    function checkRecoverySession() {
        try {
            const rawState = sessionStorage.getItem('solutto_rec_state');
            if (!rawState) return;

            const state = JSON.parse(rawState);
            // Ignora estados muito antigos (> 24h)
            if (Date.now() - state.timestamp > 86400000) {
                sessionStorage.removeItem('solutto_rec_state');
                return;
            }

            console.log("[Solutto] Recuperando sessão...", state);
            const savedOptions = state.options || {};

            // Restaura estado no RecorderManager
            recorderManager.recoverState(
                state.videoId, 
                state.elapsedSeconds, 
                state.recordingType,
                savedOptions
            );

            // Mostra controles de recuperação (Resume/Stop/Discard)
            uiManager.showControls((action) => handleRecoveredUserAction(action, state));

            // Atualiza UI
            setTimeout(async () => {
                uiManager.updateTimer(state.elapsedSeconds);
                uiManager.togglePauseState(true); 
                await injectWebcam(savedOptions, state.recordingType);
            }, 1000); 

        } catch (e) {
            console.error("Erro na recuperação da sessão:", e);
            sessionStorage.removeItem('solutto_rec_state');
        }
    }

    async function handleRecoveredUserAction(action, state) {
        // Recarrega estado se necessário
        if (!state) {
            const raw = sessionStorage.getItem('solutto_rec_state');
            if (raw) state = JSON.parse(raw);
            else return; 
        }

        switch (action) {
            case "resume":
                try {
                    await cleanupSession();

                    const savedOptions = state.options || {};
                    savedOptions.type = state.recordingType;

                    const { mainStream, secondaryStream } = await acquireMediaStreams(savedOptions);
                    activeMainStream = mainStream;
                    activeSecondaryStream = secondaryStream;

                    audioMixer = new window.SoluttoAudioMixer();
                    const streamForRecording = audioMixer.mix(mainStream, secondaryStream);

                    const onUIReady = async () => {
                        await injectWebcam(savedOptions, state.recordingType);
                    };

                    // Reinicia gravação anexando ao vídeo ID existente
                    await recorderManager.start(
                        streamForRecording, 
                        savedOptions, 
                        () => cleanupSession(),
                        onUIReady, 
                        state.videoId // Passa o ID antigo para continuar o mesmo arquivo
                    );

                    // Reativa listeners
                    recorderManager.bindActionHandler(null); 

                } catch (err) {
                    alert("Erro ao retomar gravação: " + err.message);
                }
                break;

            case "pause": 
                uiManager.togglePauseState(true); 
                break;
            case C.ACTIONS.STOP_RECORDING: 
                recorderManager.stop(); 
                break;
            case C.ACTIONS.CANCEL_RECORDING: 
                recorderManager.cancel(); 
                break;
        }
    }
})();
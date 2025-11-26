/**
 * Content Script - Solutto Recorder
 * Controlador principal que roda na página web.
 */
(function () {
    // Evita múltiplas injeções
    if (window.SoluttoContentInitialized) return;
    window.SoluttoContentInitialized = true;

    const C = window.SoluttoConstants;

    // Instâncias dos serviços (Singletons)
    const recorderManager = new window.SoluttoRecorderManager();
    const uiManager = window.SoluttoUIManager.getInstance();
    
    // Serviços recriados por sessão
    let audioMixer = null;
    let signalingService = null;
    
    // Referências para limpeza de hardware
    let activeMainStream = null;      
    let activeSecondaryStream = null; 

    // Listener de mensagens
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        handleMessage(message).then(sendResponse).catch(err => {
            console.error("Solutto Content: Erro no handler:", err);
            sendResponse({ allow: false, error: err.message });
        });
        return true; // Async response
    });

    /**
     * Roteador de ações
     */
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
     * Trata os atalhos de teclado vindos do Background
     */
    function handleKeyboardCommand(command) {
        if (recorderManager.status === "idle") return;

        switch (command) {
            case C.COMMANDS.STOP:
                recorderManager.stop();
                break;
            case C.COMMANDS.CANCEL:
                if (confirm("Tem certeza que deseja cancelar a gravação? O vídeo será perdido.")) {
                    recorderManager.cancel();
                }
                break;
            case C.COMMANDS.TOGGLE_PAUSE:
                if (recorderManager.status === "recording") recorderManager.pause();
                else if (recorderManager.status === "paused") recorderManager.resume();
                break;
        }
    }

    /**
     * Inicia a sessão de gravação.
     */
    async function startRecordingSession(options) {
        try {
            console.log("Solutto Content: Iniciando sessão...", options);

            await cleanupSession();

            // 1. Adquire Streams (Tela/Cam + Mic)
            // Resolve problemas de permissão e IDs cruzados
            const { mainStream, secondaryStream } = await acquireMediaStreams(options);
            
            activeMainStream = mainStream;
            activeSecondaryStream = secondaryStream;

            // 2. Mixagem de Áudio
            audioMixer = new window.SoluttoAudioMixer();
            const streamForRecording = audioMixer.mix(mainStream, secondaryStream);

            // 3. Tab Mirroring (Retorno de áudio para aba)
            if (options.type === C.SOURCE_TYPE.TAB) {
                await setupTabMirroring(mainStream, options.tabId);
            }

            // 4. Preview Webcam (PIP - Tela/Aba)
            if ((options.type === C.SOURCE_TYPE.SCREEN || options.type === C.SOURCE_TYPE.TAB) && options.webcamId) {
                const camConstraints = options.webcamId ? { deviceId: { exact: options.webcamId } } : true;
                try {
                    const webcamPreviewStream = await navigator.mediaDevices.getUserMedia({ video: camConstraints });
                    uiManager.showWebcamPreview(webcamPreviewStream);
                } catch(e) {
                    const webcamFallback = await navigator.mediaDevices.getUserMedia({ video: true });
                    uiManager.showWebcamPreview(webcamFallback);
                }
            }

            // 5. Preview Webcam (Grande - Modo Espelho)
            if (options.type === C.SOURCE_TYPE.WEBCAM) {
                uiManager.showLargeWebcamPreview(mainStream);
            }

            // 6. Inicia Gravador (Fire-and-forget)
            // Não usamos await aqui para liberar o popup imediatamente enquanto o countdown roda
            recorderManager.start(
                streamForRecording, 
                parseInt(options.timeout || 0), 
                options.type,
                () => cleanupSession() // Callback de limpeza ao final
            ).catch(err => {
                console.error("Erro assíncrono no gravador:", err);
                cleanupSession();
            });

            return { allow: true };

        } catch (error) {
            console.error("Solutto Content: Falha fatal ao iniciar gravação.", error);
            await cleanupSession();
            throw error;
        }
    }

    /**
     * Limpa streams e fecha conexões.
     */
    async function cleanupSession() {
        // Parar as tracks devolve o controle do áudio para a aba original
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
        
        // Fecha abas de playback
        chrome.runtime.sendMessage({ action: C.ACTIONS.CLOSE_TABS });
    }
    
    async function setupTabMirroring(stream, tabId) {
        signalingService = new window.SoluttoSignalingService();
        signalingService.startConnection(stream);
        const offer = await signalingService.createOffer();
        chrome.runtime.sendMessage({ action: C.ACTIONS.WEBRTC_OFFER, offer: offer, targetTabId: tabId });
    }

    async function acquireMediaStreams(options) {
        let mainStream = null;
        let secondaryStream = null;
        
        // Resolve IDs locais baseados nos nomes (Labels) vindos do Popup
        let localMicId = null;
        let localCamId = null;

        if (options.microfoneLabel) localMicId = await findDeviceIdByLabel('audio', options.microfoneLabel);
        if (options.webcamLabel) localCamId = await findDeviceIdByLabel('video', options.webcamLabel);

        // --- TIPO: ABA ---
        if (options.type === C.SOURCE_TYPE.TAB) {
            await chrome.runtime.sendMessage({ action: C.ACTIONS.OPEN_PLAYBACK_TAB, tabId: options.tabId });
            const streamId = await chrome.runtime.sendMessage({ action: "requestStream", tabId: options.tabId });
            
            mainStream = await navigator.mediaDevices.getUserMedia({
                audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
                video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxWidth: window.screen.width, maxHeight: window.screen.height, maxFrameRate: 30 } }
            });

        // --- TIPO: TELA ---
        } else if (options.type === C.SOURCE_TYPE.SCREEN) {
            mainStream = await navigator.mediaDevices.getDisplayMedia({
                audio: true,
                video: { displaySurface: "monitor", width: { ideal: 1920 }, height: { ideal: 1080 } }
            });

        // --- TIPO: WEBCAM ---
        } else if (options.type === C.SOURCE_TYPE.WEBCAM) {
            const videoConstraints = localCamId ? { deviceId: { exact: localCamId } } : true;
            const audioConstraints = localMicId ? { deviceId: { exact: localMicId } } : true;
            try {
                mainStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
            } catch (e) {
                mainStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            }
            return { mainStream, secondaryStream: null };
        }

        // --- MICROFONE SECUNDÁRIO ---
        if (options.microfoneLabel) {
            const constraints = localMicId 
                ? { deviceId: { exact: localMicId }, echoCancellation: true, noiseSuppression: true }
                : { echoCancellation: true, noiseSuppression: true };

            try {
                secondaryStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
            } catch (e) {
                try { secondaryStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (err) {}
            }
        }

        return { mainStream, secondaryStream };
    }

    /**
     * Helper para contornar segurança de ID de dispositivo do navegador.
     */
    async function findDeviceIdByLabel(kind, label) {
        if (!label) return null;
        try {
            const stream = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: true } : { video: true });
            stream.getTracks().forEach(t => t.stop());
            const devices = await navigator.mediaDevices.enumerateDevices();
            const target = devices.find(d => d.kind === (kind === 'audio' ? 'audioinput' : 'videoinput') && d.label === label);
            return target ? target.deviceId : null;
        } catch (e) { return null; }
    }

})();
/**
 * Content Script - Solutto Recorder
 * Controlador principal (Maestro) que roda na página web visitada pelo usuário.
 * Responsável por orquestrar a captura de mídia, mixagem de áudio e interface flutuante.
 */
(function () {
    // Guarda de injeção para evitar duplicação de script na mesma página
    if (window.SoluttoContentInitialized) return;
    window.SoluttoContentInitialized = true;

    const C = window.SoluttoConstants;

    // Instâncias dos serviços principais (Singletons ou Classes Globais)
    const recorderManager = new window.SoluttoRecorderManager();
    const uiManager = window.SoluttoUIManager.getInstance();
    
    // Serviços voláteis (recriados a cada sessão de gravação)
    let audioMixer = null;
    let signalingService = null;
    
    // Referências globais para limpeza de streams (impedir vazamento de áudio/câmera)
    let activeMainStream = null;      
    let activeSecondaryStream = null; 

    // Listener de mensagens vindas do Background/Popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Envelopa a resposta em Promise para permitir async/await
        handleMessage(message).then(sendResponse).catch(err => {
            console.error("Solutto Content: Erro no handler:", err);
            sendResponse({ allow: false, error: err.message });
        });
        return true; // Mantém o canal aberto para resposta assíncrona
    });

    /**
     * Roteador de mensagens. Decide qual ação executar.
     * @param {Object} msg - Mensagem recebida.
     */
    async function handleMessage(msg) {
        switch (msg.action) {
            case C.ACTIONS.REQUEST_RECORDING:
                return await startRecordingSession(msg);

            case C.ACTIONS.WEBRTC_ANSWER:
                // Recebe a resposta SDP da aba de playback (background)
                if (signalingService) await signalingService.handleAnswer(msg.answer);
                return { success: true };

            case C.ACTIONS.WEBRTC_CANDIDATE:
                // Recebe candidatos ICE da aba de playback
                if (signalingService) await signalingService.handleCandidate(msg.candidate);
                return { success: true };

            case C.ACTIONS.KILL_UI:
                // Comando de emergência para limpar tudo
                await cleanupSession();
                return { success: true };
            
            default:
                return { result: "ignored" };
        }
    }

    /**
     * Inicia uma nova sessão de gravação.
     * Configura streams, áudio, UI e o gravador.
     * @param {Object} options - Configurações (type, devices, timeout).
     */
    async function startRecordingSession(options) {
        try {
            console.log("Solutto Content: Iniciando sessão...", options);

            // Limpa qualquer resquício anterior
            await cleanupSession();

            // 1. Adquire os Streams de Mídia (Tela, Aba, Webcam, Mic)
            const { mainStream, secondaryStream } = await acquireMediaStreams(options);
            
            // Salva referências para poder parar (stop) as tracks depois
            activeMainStream = mainStream;
            activeSecondaryStream = secondaryStream;

            // 2. Mixagem de Áudio (Web Audio API)
            // Junta o som do sistema com o microfone em um único canal para o arquivo
            audioMixer = new window.SoluttoAudioMixer();
            const streamForRecording = audioMixer.mix(mainStream, secondaryStream);

            // 3. Configuração Específica: Gravação de Aba (Tab)
            // Inicia o espelhamento WebRTC para manter o áudio ativo em background
            if (options.type === C.SOURCE_TYPE.TAB) {
                await setupTabMirroring(mainStream, options.tabId);
            }

            // 4. Configuração de Preview (Webcam PIP)
            // Se estiver gravando tela + webcam, mostra a bolinha da webcam
            if ((options.type === C.SOURCE_TYPE.SCREEN || options.type === C.SOURCE_TYPE.TAB) && options.webcamId) {
                const camConstraints = options.webcamId ? { deviceId: { exact: options.webcamId } } : true;
                try {
                    const webcamPreviewStream = await navigator.mediaDevices.getUserMedia({ video: camConstraints });
                    uiManager.showWebcamPreview(webcamPreviewStream);
                } catch(e) {
                    // Fallback para webcam padrão se a específica falhar
                    const webcamFallback = await navigator.mediaDevices.getUserMedia({ video: true });
                    uiManager.showWebcamPreview(webcamFallback);
                }
            }

            // 5. Configuração de Preview (Webcam Only - Espelho)
            // Se for só webcam, mostra o preview grande centralizado
            if (options.type === C.SOURCE_TYPE.WEBCAM) {
                uiManager.showLargeWebcamPreview(mainStream);
            }

            // 6. Inicia o Gravador (MediaRecorder)
            // Passa o callback cleanupSession para ser chamado ao final da gravação
            recorderManager.start(
                streamForRecording, 
                parseInt(options.timeout || 0), 
                options.type,
                () => cleanupSession()
            ).catch(err => {
                console.error("Erro assíncrono no gravador:", err);
                cleanupSession();
            });

            // Retorna sucesso imediato para fechar o Popup (Fire-and-forget)
            return { allow: true };

        } catch (error) {
            console.error("Solutto Content: Falha fatal ao iniciar gravação.", error);
            await cleanupSession();
            throw error;
        }
    }

    /**
     * Limpa todos os recursos, para streams e fecha conexões.
     * Essencial para liberar a câmera/mic e devolver o áudio da aba ao normal.
     */
    async function cleanupSession() {
        // Para as tracks originais (libera hardware)
        if (activeMainStream) {
            activeMainStream.getTracks().forEach(track => track.stop());
            activeMainStream = null;
        }
        if (activeSecondaryStream) {
            activeSecondaryStream.getTracks().forEach(track => track.stop());
            activeSecondaryStream = null;
        }

        // Limpa serviços de apoio
        if (audioMixer) {
            audioMixer.cleanup();
            audioMixer = null;
        }
        if (signalingService) {
            signalingService.cleanup();
            signalingService = null;
        }
        
        // Remove UI flutuante
        await uiManager.cleanup();
        
        // Fecha abas auxiliares no background
        chrome.runtime.sendMessage({ action: C.ACTIONS.CLOSE_TABS });
    }
    
    /**
     * Configura a conexão WebRTC (Sender) para espelhar o áudio da aba.
     */
    async function setupTabMirroring(stream, tabId) {
        signalingService = new window.SoluttoSignalingService();
        signalingService.startConnection(stream);
        const offer = await signalingService.createOffer();
        chrome.runtime.sendMessage({ action: C.ACTIONS.WEBRTC_OFFER, offer: offer, targetTabId: tabId });
    }

    /**
     * Lógica complexa para adquirir streams de mídia.
     * Lida com permissões, IDs de dispositivos cruzados (Popup vs Content) e fallbacks.
     * @returns {Promise<{mainStream: MediaStream, secondaryStream: MediaStream}>}
     */
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
            // Abre aba receptora primeiro
            await chrome.runtime.sendMessage({ action: C.ACTIONS.OPEN_PLAYBACK_TAB, tabId: options.tabId });
            // Pede ID do stream da aba
            const streamId = await chrome.runtime.sendMessage({ action: "requestStream", tabId: options.tabId });
            
            mainStream = await navigator.mediaDevices.getUserMedia({
                audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
                video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxWidth: window.screen.width, maxHeight: window.screen.height, maxFrameRate: 30 } }
            });
        
        // --- TIPO: TELA ---
        } else if (options.type === C.SOURCE_TYPE.SCREEN) {
            mainStream = await navigator.mediaDevices.getDisplayMedia({
                audio: true, // Tenta áudio do sistema
                video: { displaySurface: "monitor", width: { ideal: 1920 }, height: { ideal: 1080 } }
            });
        
        // --- TIPO: WEBCAM (Only) ---
        } else if (options.type === C.SOURCE_TYPE.WEBCAM) {
            const videoConstraints = localCamId ? { deviceId: { exact: localCamId } } : true;
            const audioConstraints = localMicId ? { deviceId: { exact: localMicId } } : true;
            try {
                mainStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
            } catch (e) {
                // Fallback se dispositivo específico falhar
                mainStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            }
            return { mainStream, secondaryStream: null }; // Webcam única já tem áudio embutido
        }

        // --- STREAM SECUNDÁRIO (MICROFONE) ---
        // Apenas para Tela e Aba
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
     * Encontra o ID local comparando o Label (Nome) do dispositivo.
     */
    async function findDeviceIdByLabel(kind, label) {
        if (!label) return null;
        try {
            // Pede permissão temporária para liberar labels
            const stream = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: true } : { video: true });
            stream.getTracks().forEach(t => t.stop());
            
            const devices = await navigator.mediaDevices.enumerateDevices();
            const target = devices.find(d => d.kind === (kind === 'audio' ? 'audioinput' : 'videoinput') && d.label === label);
            return target ? target.deviceId : null;
        } catch (e) { return null; }
    }

})();
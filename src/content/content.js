/**
 * Content Script - Solutto Recorder
 * ATUALIZADO: Fade-out do popup e Renderização UI antes do Countdown.
 */
(function () {
    if (window.SoluttoContentInitialized) return;
    window.SoluttoContentInitialized = true;

    const C = window.SoluttoConstants;
    const recorderManager = new window.SoluttoRecorderManager();
    const uiManager = window.SoluttoUIManager.getInstance();
    
    let audioMixer = null;
    let signalingService = null;
    let activeMainStream = null;      
    let activeSecondaryStream = null; 

    checkRecoverySession();

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        handleMessage(message).then(sendResponse).catch(err => {
            console.error("Solutto Content: Erro no handler:", err);
            sendResponse({ allow: false, error: err.message });
        });
        return true; 
    });

    async function handleMessage(msg) {
        switch (msg.action) {
            case C.ACTIONS.REQUEST_RECORDING: return await startRecordingSession(msg);
            case C.ACTIONS.WEBRTC_ANSWER:
                if (signalingService) await signalingService.handleAnswer(msg.answer);
                return { success: true };
            case C.ACTIONS.WEBRTC_CANDIDATE:
                if (signalingService) await signalingService.handleCandidate(msg.candidate);
                return { success: true };
            case C.ACTIONS.KILL_UI: await cleanupSession(); return { success: true };
            case C.ACTIONS.KEYBOARD_COMMAND: handleKeyboardCommand(msg.command); return { success: true };
            default: return { result: "ignored" };
        }
    }

    function handleKeyboardCommand(command) {
        if (recorderManager.status === "idle" && recorderManager.status !== "paused") return;
        switch (command) {
            case C.COMMANDS.STOP: recorderManager.stop(); break;
            case C.COMMANDS.CANCEL: 
                if (confirm("Cancelar?")) recorderManager.cancel(); 
                break;
            case C.COMMANDS.TOGGLE_PAUSE:
                if (recorderManager.status === "recording") recorderManager.pause();
                else if (recorderManager.status === "paused") handleRecoveredUserAction("resume", null);
                break;
        }
    }

    /**
     * Fecha o popup com animação suave (Fade Out).
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
     * Lógica centralizada para injetar a webcam na UI.
     * Usada tanto no início quanto na recuperação (F5).
     */
    async function injectWebcam(options, recordingType) {
        const label = options.webcamLabel;
        
        if ((recordingType === C.SOURCE_TYPE.SCREEN || recordingType === C.SOURCE_TYPE.TAB) && label) {
             const camStream = await getWebcamStream(label);
             if (camStream) uiManager.showWebcamPreview(camStream);
        }
        
        if (recordingType === C.SOURCE_TYPE.WEBCAM) {
            if (activeMainStream) uiManager.showLargeWebcamPreview(activeMainStream);
            else {
                const camStream = await getWebcamStream(label);
                if (camStream) uiManager.showLargeWebcamPreview(camStream);
            }
        }
    }

    async function getWebcamStream(label) {
        try {
            const id = await findDeviceIdByLabel('video', label);
            const constraints = id ? { video: { deviceId: { exact: id } } } : { video: true };
            return await navigator.mediaDevices.getUserMedia(constraints);
        } catch(e) { return null; }
    }

    function checkRecoverySession() {
        try {
            const rawState = sessionStorage.getItem('solutto_rec_state');
            if (!rawState) return;

            const state = JSON.parse(rawState);
            if (Date.now() - state.timestamp > 86400000) {
                sessionStorage.removeItem('solutto_rec_state');
                return;
            }

            console.log("Solutto: Recuperando sessão...", state);
            const savedOptions = state.options || {};

            recorderManager.recoverState(
                state.videoId, 
                state.elapsedSeconds, 
                state.recordingType,
                savedOptions
            );

            uiManager.showControls((action) => handleRecoveredUserAction(action, state));

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

                    console.log("Solutto: Retomando...", savedOptions);

                    const { mainStream, secondaryStream } = await acquireMediaStreams(savedOptions);
                    activeMainStream = mainStream;
                    activeSecondaryStream = secondaryStream;

                    audioMixer = new window.SoluttoAudioMixer();
                    const streamForRecording = audioMixer.mix(mainStream, secondaryStream);

                    // Callback para injetar webcam assim que a UI montar
                    const onUIReady = async () => {
                        await injectWebcam(savedOptions, state.recordingType);
                    };

                    await recorderManager.start(
                        streamForRecording, 
                        savedOptions, 
                        () => cleanupSession(),
                        onUIReady, // Passa o callback de webcam
                        state.videoId 
                    );

                    recorderManager.bindActionHandler(null); 

                } catch (err) {
                    alert("Erro ao retomar gravação: " + err.message);
                }
                break;

            case "pause": uiManager.togglePauseState(true); break;
            case C.ACTIONS.STOP_RECORDING: recorderManager.stop(); break;
            case C.ACTIONS.CANCEL_RECORDING: recorderManager.cancel(); break;
        }
    }

    async function startRecordingSession(options) {
        try {
            // 1. Fecha popup imediatamente com animação
            closePopup();

            await cleanupSession();

            const { mainStream, secondaryStream } = await acquireMediaStreams(options);
            activeMainStream = mainStream;
            activeSecondaryStream = secondaryStream;

            audioMixer = new window.SoluttoAudioMixer();
            const streamForRecording = audioMixer.mix(mainStream, secondaryStream);

            if (options.type === C.SOURCE_TYPE.TAB) {
                await setupTabMirroring(mainStream, options.tabId);
            }

            // Callback para injetar webcam
            const onUIReady = async () => {
                await injectWebcam(options, options.type);
            };

            // Inicia o fluxo (UI -> Webcam -> Countdown -> Record)
            await recorderManager.start(
                streamForRecording, 
                options, 
                () => cleanupSession(),
                onUIReady
            );

            return { allow: true };
        } catch (error) {
            console.error("Solutto Content: Falha fatal.", error);
            await cleanupSession();
            throw error;
        }
    }

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
        chrome.runtime.sendMessage({ action: C.ACTIONS.CLOSE_TABS });
    }
    
    async function setupTabMirroring(stream, tabId) {
        signalingService = new window.SoluttoSignalingService();
        signalingService.startConnection(stream);
        const offer = await signalingService.createOffer();
        chrome.runtime.sendMessage({ action: C.ACTIONS.WEBRTC_OFFER, offer: offer, targetTabId: tabId || null });
    }

    async function acquireMediaStreams(options) {
        let mainStream = null;
        let secondaryStream = null;
        
        let localMicId = null;
        let localCamId = null;

        if (options.microfoneLabel) localMicId = await findDeviceIdByLabel('audio', options.microfoneLabel);
        if (options.webcamLabel) localCamId = await findDeviceIdByLabel('video', options.webcamLabel);

        if (options.type === C.SOURCE_TYPE.TAB) {
            await chrome.runtime.sendMessage({ action: C.ACTIONS.OPEN_PLAYBACK_TAB, tabId: null });
            const streamId = await chrome.runtime.sendMessage({ action: "requestStream", tabId: null });
            if (!streamId) throw new Error("Não foi possível obter ID da aba.");

            mainStream = await navigator.mediaDevices.getUserMedia({
                audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
                video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxWidth: window.screen.width, maxHeight: window.screen.height, maxFrameRate: 30 } }
            });

        } else if (options.type === C.SOURCE_TYPE.SCREEN) {
            mainStream = await navigator.mediaDevices.getDisplayMedia({
                audio: true,
                video: { displaySurface: "monitor", width: { ideal: 1920 }, height: { ideal: 1080 } }
            });

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

        if (options.microfoneLabel || localMicId) {
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
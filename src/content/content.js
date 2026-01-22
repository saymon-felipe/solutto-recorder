/**
 * Content Script - Solutto Recorder
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
            console.error("[Solutto Content] Erro handler:", err);
            sendResponse({ allow: false, error: err.message });
        });
        return true;
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

    function handleKeyboardCommand(command) {
        if (recorderManager.status === "idle" && recorderManager.status !== "paused") return;
        switch (command) {
            case C.COMMANDS.STOP:
            case "stop_recording_command":
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

    function closePopup() {
        const iframe = document.getElementById("solutto-recorder-iframe");
        if (iframe) {
            iframe.style.transition = "opacity 0.3s ease";
            iframe.style.opacity = "0";
            setTimeout(() => iframe.remove(), 300);
        }
    }

    async function startRecordingSession(options) {
        try {
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

            const onUIReady = async () => {
                await injectWebcam(options, options.type);
            };

            await recorderManager.start(
                streamForRecording,
                options,
                () => cleanupSession(),
                onUIReady
            );

            return { allow: true };

        } catch (error) {
            console.error("[Solutto Content] Falha ao iniciar:", error);
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

            const audioConstraints = localMicId ? {
                ...highQualityConstraints.audio,
                deviceId: { exact: localMicId }
            } : false;

            try {
                mainStream = await navigator.mediaDevices.getUserMedia({
                    video: videoConstraints,
                    audio: audioConstraints
                });
            } catch (e) {
                console.warn("[Content] Fallback de webcam para padrão.");
                mainStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: !!localMicId // Só pede áudio padrão se o usuário queria áudio
                });
            }
            return { mainStream, secondaryStream: null };
        }

        // --- STREAM SECUNDÁRIA (MICROFONE) ---
        // Apenas para modos TAB e SCREEN. O Webcam retorna antes de chegar aqui.
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
                try { secondaryStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (err) { }
            }
        }

        return { mainStream, secondaryStream };
    }

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
        } catch (e) { return null; }
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

    async function checkRecoverySession() {
        if (window.location.href === 'about:blank') return;
        try {
            const data = await chrome.storage.local.get('solutto_rec_state');
            const state = data.solutto_rec_state;
            if (!state || Date.now() - state.timestamp > 86400000) {
                if (state) chrome.storage.local.remove('solutto_rec_state');
                return;
            }

            console.log("[Solutto] Recuperando sessão...", state);
            const savedOptions = state.options || {};
            recorderManager.recoverState(state.videoId, state.elapsedSeconds, state.recordingType, savedOptions);
            uiManager.showControls((action) => handleRecoveredUserAction(action));
            setTimeout(async () => {
                uiManager.updateTimer(state.elapsedSeconds);
                uiManager.togglePauseState(true);
                await injectWebcam(savedOptions, state.recordingType);
            }, 1000);
        } catch (e) { console.error("Erro rec:", e); }
    }

    async function handleRecoveredUserAction(action, inMemoryState) {
        let state = inMemoryState;
        if (!state) {
            const data = await chrome.storage.local.get('solutto_rec_state');
            state = data.solutto_rec_state;
            if (!state) return;
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
                    const onUIReady = async () => { await injectWebcam(savedOptions, state.recordingType); };
                    await recorderManager.start(streamForRecording, savedOptions, () => cleanupSession(), onUIReady, state.videoId);
                    recorderManager.bindActionHandler(null);
                } catch (err) { alert("Erro ao retomar: " + err.message); }
                break;
            case "pause": uiManager.togglePauseState(true); break;
            case C.ACTIONS.STOP_RECORDING: recorderManager.stop(); break;
            case C.ACTIONS.CANCEL_RECORDING: recorderManager.cancel(); break;
        }
    }
})();
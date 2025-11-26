(function () {
    /**
     * SoluttoConstants - Configurações globais e imutáveis da extensão.
     */
    window.SoluttoConstants = {
        
        APP: {
            NAME: "Solutto Recorder",
            FOLDER_NAME_DRIVE: "Solutto Recorder"
        },

        UI: {
            Z_INDEX_HOST: 2147483647, 
            HOST_ID: "solutto-recorder-host",
            CONTROLS_ID: "solutto-recorder-controls",
            WEBCAM_PREVIEW_ID: "solutto-recorder-webcam-preview", // PIP (Pequeno)
            LARGE_PREVIEW_ID: "solutto-recorder-large-preview",   // Espelho (Grande)
            COUNTDOWN_ID: "recorder-timeout",
            TRANSITION_DURATION_MS: 400
        },

        RECORDER: {
            // Ordem de preferência de codecs
            MIME_TYPE_PREFERENCE: [
                "video/webm;codecs=vp9", 
                "video/webm;codecs=vp8", 
                "video/webm"
            ],
            TIMESLICE_MS: 1000, // Salva chunks a cada 1s
            VIDEO_BITS_PER_SECOND: 2500000 // 2.5 Mbps
        },

        // Protocolo de Mensagens
        ACTIONS: {
            // Controle
            REQUEST_RECORDING: "request_recording",
            REQUEST_DEVICES: "request_devices",
            STOP_RECORDING: "stop_recording",
            CANCEL_RECORDING: "cancel_recording",
            KEYBOARD_COMMAND: "keyboard_command", // <-- Novo: Atalhos
            
            // Navegação
            OPEN_EDITOR: "openEditor",
            OPEN_PLAYBACK_TAB: "openPlaybackTab",
            CLOSE_PLAYBACK_TAB: "closePlaybackTab",
            CLOSE_TABS: "closeTabs",
            
            // WebRTC (Áudio em Background)
            WEBRTC_OFFER: "offer",
            WEBRTC_ANSWER: "answer",
            WEBRTC_CANDIDATE: "candidate",
            
            // Sistema
            CHANGE_ICON: "changeIcon",
            UPLOAD_FILE: "upload-file",
            KILL_UI: "kill",
            
            // Armazenamento (IndexedDB)
            SAVE_CHUNK: "save_chunk",
            FINISH_VIDEO: "finish_video",
            GET_AUTH_TOKEN: "get_auth_token"
        },
        STORAGE: {
            CAMERA_ID: "cameraSelect",
            MIC_ID: "microphoneSelect",
            WAIT_SECONDS: "waitSeconds",
            USE_WAIT_SECONDS: "timeoutCheckbox",
            OPTIONS_SELECT: "optionsSelect",
            VIDEO_ID: "videoId",
            VIDEO_TIMEOUT: "videoTimeout"
        },
        COMMANDS: {
            TOGGLE_PAUSE: "toggle-pause",
            STOP: "stop-recording",
            CANCEL: "cancel-recording"
        },
        SOURCE_TYPE: {
            TAB: "tab",
            SCREEN: "screen",
            WEBCAM: "webcam"
        }
    };
})();
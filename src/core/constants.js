(function () {
    window.SoluttoConstants = {
        APP: {
            NAME: "Solutto Recorder",
            FOLDER_NAME_DRIVE: "Solutto Recorder"
        },
        UI: {
            Z_INDEX_HOST: 2147483647, 

            HOST_ID: "solutto-recorder-host",
            CONTROLS_ID: "solutto-recorder-controls",
            PREVIEW_VIDEO_ID: "solutto-recorder-camera-preview",
            WEBCAM_PREVIEW_ID: "solutto-recorder-webcam-preview",
            COUNTDOWN_ID: "recorder-timeout",
            
            TRANSITION_DURATION_MS: 400,
            
            CLASS_VISIBLE: "solutto-visible",
            CLASS_HIDDEN: "solutto-hidden"
        },
        RECORDER: {
            MIME_TYPE_PREFERENCE: [
                "video/webm;codecs=vp9", 
                "video/webm;codecs=vp8", 
                "video/webm"
            ],
            
            TIMESLICE_MS: 1000,
            
            VIDEO_BITS_PER_SECOND: 2500000
        },
        ACTIONS: {
            REQUEST_RECORDING: "request_recording",
            STOP_RECORDING: "stop_recording",
            CANCEL_RECORDING: "cancel_recording",
            REQUEST_DEVICES: "request_devices",
            KILL_UI: "kill",
            
            OPEN_EDITOR: "openEditor",
            OPEN_PLAYBACK_TAB: "openPlaybackTab",
            CLOSE_PLAYBACK_TAB: "closePlaybackTab",
            CLOSE_TABS: "closeTabs",
            
            WEBRTC_OFFER: "offer",
            WEBRTC_ANSWER: "answer",
            WEBRTC_CANDIDATE: "candidate",
            READY_TO_RECEIVE: "ready-to-receive",
            
            CHANGE_ICON: "changeIcon",
            UPLOAD_FILE: "upload-file"
        },
        STORAGE: {
            CAMERA_ID: "cameraSelect",
            MIC_ID: "microphoneSelect",
            WAIT_SECONDS: "waitSeconds",
            USE_WAIT_SECONDS: "timeoutCheckbox",
            OPTIONS_SELECT: "optionsSelect", 
            VIDEO_URL: "videoUrl",  
            VIDEO_TIMEOUT: "videoTimeout", 
            TAB_ID: "tabId" 
        },
        SOURCE_TYPE: {
            TAB: "tab",
            SCREEN: "screen",
            WEBCAM: "webcam"
        }
    };
})();
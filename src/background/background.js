import { DriveService } from '../services/DriveService.js';
import { VideoStorage } from '../services/VideoStorage.js';

const ACTIONS = {
    GET_AUTH_TOKEN: "get_auth_token",
    REQUEST_RECORDING: "request_recording",
    REQUEST_DEVICES: "request_devices",
    OPEN_EDITOR: "openEditor",
    OPEN_PLAYBACK_TAB: "openPlaybackTab",
    CLOSE_PLAYBACK_TAB: "closePlaybackTab",
    CLOSE_TABS: "closeTabs",
    WEBRTC_OFFER: "offer",
    WEBRTC_ANSWER: "answer",
    WEBRTC_CANDIDATE: "candidate",
    CHANGE_ICON: "changeIcon",
    UPLOAD_FILE: "upload-file",
    KILL_UI: "kill",
    SAVE_CHUNK: "save_chunk",
    GET_RESUME_INFO: "get_resume_info",
    FINISH_VIDEO: "finish_video",
    STOP_RECORDING: "stop_recording_command" 
};

const state = {
    playbackTabs: new Map(),
    driveService: new DriveService(),
    videoStorage: new VideoStorage(),
    activeRecordingTabId: null,
    isProcessingVideo: false
};

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === state.activeRecordingTabId) {
        resetRecordingState();
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.activeRecordingTabId && changeInfo.status === 'loading') {
        resetRecordingState();
    }
});

function resetRecordingState() {
    console.log("[Background] Resetando estado da gravação.");
    state.activeRecordingTabId = null;
    state.isProcessingVideo = false;
    updateIcon("default");
}

chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.url || !tab.url.startsWith("http")) return;
    try {
        await ensureContentScript(tab.id);
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const iframeId = "solutto-recorder-iframe";
                const existingIframe = document.getElementById(iframeId);
                if (existingIframe) {
                    existingIframe.style.opacity = "0";
                    setTimeout(() => existingIframe.remove(), 300);
                } else {
                    const newIframe = document.createElement('iframe');
                    newIframe.src = chrome.runtime.getURL("src/popup/popup.html");
                    newIframe.id = iframeId;
                    newIframe.allow = "camera *; microphone *; display-capture *; autoplay *";
                    Object.assign(newIframe.style, { position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh", border: "none", zIndex: "2147483647", opacity: "0", transition: "opacity 0.3s ease", display: "block" });
                    if (document.documentElement) document.documentElement.appendChild(newIframe);
                    else document.body.appendChild(newIframe);
                    requestAnimationFrame(() => newIframe.style.opacity = "1");
                }
            }
        });
    } catch (error) { console.error("Erro init:", error); }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch(err => {
        console.error("Erro msg:", err);
        sendResponse({ error: err.message });
    });
    return true;
});

chrome.commands.onCommand.addListener(async (command) => {
    try {
        const targetId = state.activeRecordingTabId;
        if (targetId) {
             chrome.tabs.sendMessage(targetId, { action: "keyboard_command", command: command }).catch(() => { });
        } else {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, { action: "keyboard_command", command: command }).catch(() => { });
            }
        }
    } catch (error) { console.error("Erro atalho:", error); }
});

async function handleMessage(msg, sender) {
    const senderTabId = sender?.tab?.id;

    switch (msg.action) {
        case "GET_RECORDING_STATUS":
            return {
                isBusy: state.activeRecordingTabId !== null || state.isProcessingVideo,
                reason: state.isProcessingVideo ? "processing" : "recording",
                recordingTabId: state.activeRecordingTabId // Importante para o Popup saber quem parar
            };
        case ACTIONS.GET_AUTH_TOKEN: return getAuthToken();
        case ACTIONS.REQUEST_DEVICES: return sendMessageToTab(senderTabId, msg);
        
        case ACTIONS.REQUEST_RECORDING:
            if (state.activeRecordingTabId !== null || state.isProcessingVideo) {
                return { error: "A extensão já está ocupada." };
            }
            if (msg.tabId) {
                state.activeRecordingTabId = msg.tabId; // Marca a aba como gravando
                await ensureContentScript(msg.tabId);
                return sendMessageToTab(msg.tabId, msg);
            }
            break;

        case ACTIONS.UPLOAD_FILE: return handleDriveUpload(msg);
        case ACTIONS.OPEN_EDITOR:
            await chrome.storage.local.set({ videoId: msg.videoId, videoTimeout: msg.videoTimeout });
            await chrome.tabs.create({ url: chrome.runtime.getURL("src/editor/editor.html") });
            return { success: true };

        case ACTIONS.OPEN_PLAYBACK_TAB:
            const sourceId = msg.tabId || senderTabId;
            return createPlaybackTab(sourceId);

        case ACTIONS.CLOSE_PLAYBACK_TAB:
            for (const [src, play] of state.playbackTabs.entries()) {
                if (play === msg.playbackTab) {
                    chrome.tabs.remove(play).catch(() => { });
                    state.playbackTabs.delete(src);
                }
            }
            return { success: true };

        case ACTIONS.CLOSE_TABS: return closeAllPlaybackTabs();

        case ACTIONS.WEBRTC_OFFER:
        case ACTIONS.WEBRTC_CANDIDATE:
            state.playbackTabs.forEach(playbackId => {
                chrome.tabs.sendMessage(playbackId, msg).catch(() => { });
            });
            break;

        case ACTIONS.WEBRTC_ANSWER:
            const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTabs[0]) chrome.tabs.sendMessage(activeTabs[0].id, msg).catch(() => { });
            break;

        case "requestStream":
            return new Promise((resolve) => {
                const targetTab = msg.tabId || senderTabId;
                chrome.tabCapture.getMediaStreamId({
                    consumerTabId: targetTab,
                    targetTabId: targetTab
                }, (streamId) => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                    } else {
                        resolve(streamId);
                    }
                });
            });

        case ACTIONS.CHANGE_ICON: 
            updateIcon(msg.type); 
            break;

        case ACTIONS.SAVE_CHUNK:
            state.isProcessingVideo = true;
            const chunkBlob = new Blob([new Uint8Array(msg.data)]);
            await state.videoStorage.saveChunk(msg.videoId, chunkBlob, msg.index, msg.segment);
            return { success: true };

        case ACTIONS.GET_RESUME_INFO:
            return await state.videoStorage.getResumeInfo(msg.videoId);

        case ACTIONS.FINISH_VIDEO:
            await state.videoStorage.finishVideo(msg.videoId, "video");
            await chrome.storage.local.set({ videoId: msg.videoId, videoTimeout: 0 });
            await chrome.tabs.create({ url: chrome.runtime.getURL("src/editor/editor.html") });
            resetRecordingState();
            return { success: true };
    }
}

// ... (Restante das funções auxiliares mantidas iguais) ...
async function createPlaybackTab(sourceTabId) {
    if (state.playbackTabs.has(sourceTabId)) {
        const oldTabId = state.playbackTabs.get(sourceTabId);
        try { await chrome.tabs.remove(oldTabId); } catch (e) { }
        state.playbackTabs.delete(sourceTabId);
    }
    await chrome.storage.local.set({ tabId: sourceTabId });
    const tab = await chrome.tabs.create({
        url: chrome.runtime.getURL("src/playback/playback.html"),
        active: false, pinned: true, index: 0
    });
    state.playbackTabs.set(sourceTabId, tab.id);
    return { playbackTab: tab.id };
}

async function closeAllPlaybackTabs() {
    const ids = Array.from(state.playbackTabs.values());
    if (ids.length > 0) await chrome.tabs.remove(ids).catch(() => { });
    state.playbackTabs.clear();
    return { success: true };
}

function getAuthToken() {
    return new Promise((resolve, reject) => {
        try {
            const manifest = chrome.runtime.getManifest();
            const clientId = manifest.oauth2.client_id;
            const scopes = manifest.oauth2.scopes.join(' ');
            const redirectUri = chrome.identity.getRedirectURL();
            if (!clientId) { reject(new Error("Client ID ausente")); return; }
            const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}`;
            chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
                if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
                if (responseUrl) {
                    const params = new URLSearchParams(new URL(responseUrl).hash.substring(1));
                    const token = params.get("access_token");
                    if (token) resolve({ token }); else reject(new Error("Sem token"));
                } else reject(new Error("Falha silenciosa"));
            });
        } catch (e) { reject(e); }
    });
}

async function ensureContentScript(tabId) {
    try {
        const check = await chrome.scripting.executeScript({ target: { tabId }, func: () => typeof window.SoluttoContentInitialized !== 'undefined' });
        if (check[0] && check[0].result === true) return;
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["src/core/constants.js", "src/core/utils.js", "src/services/UIManager.js", "src/services/AudioMixer.js", "src/services/SignalingService.js", "src/services/RecorderManager.js", "src/content/content.js"]
        });
        await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/style.css"] });
    } catch (e) { console.warn("Inject falhou:", e); throw e; }
}

async function handleDriveUpload(msg) {
    const fileBlob = new Blob([new Uint8Array(msg.file)], { type: "video/" + msg.format });
    return await state.driveService.uploadVideo(fileBlob, msg.fileName);
}

function updateIcon(type) {
    const path = type === "recording" ? "/assets/icon-recording.png" : "/assets/icon.png";
    chrome.action.setIcon({ path: { "16": path, "48": path, "128": path } }).catch(() => { });
}

function sendMessageToTab(tabId, message) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ error: chrome.runtime.lastError.message });
            } else resolve(response);
        });
    });
}
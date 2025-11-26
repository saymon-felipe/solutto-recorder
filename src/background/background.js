import { DriveService } from '../services/DriveService.js';
import { VideoStorage } from '../services/VideoStorage.js';

/**
 * Mapeamento de ações (mensagens) que o Background pode processar.
 * Deve estar sincronizado com src/core/constants.js.
 */
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
    FINISH_VIDEO: "finish_video"
};

/**
 * Estado global volátil do Service Worker.
 */
const state = {
    playbackTabs: new Set(),
    driveService: new DriveService(),
    videoStorage: new VideoStorage()
};

/**
 * Listener de Clique no Ícone da Extensão.
 * Responsável por injetar e alternar (toggle) a visibilidade do iframe do Popup na página atual.
 */
chrome.action.onClicked.addListener(async (tab) => {
    // Ignora páginas de sistema (chrome://) ou vazias
    if (!tab.url || !tab.url.startsWith("http")) return;

    try {
        // Garante que os scripts necessários estão na página antes de tentar abrir o popup
        await ensureContentScript(tab.id);

        // Script para criar/remover o iframe do DOM da página
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const iframeId = "solutto-recorder-iframe";
                const existingIframe = document.getElementById(iframeId);

                if (existingIframe) {
                    // Se já existe, inicia animação de saída e remove
                    existingIframe.style.opacity = "0";
                    setTimeout(() => existingIframe.remove(), 300);
                } else {
                    // Se não existe, cria o iframe
                    const newIframe = document.createElement('iframe');
                    newIframe.src = chrome.runtime.getURL("src/popup/popup.html");
                    newIframe.id = iframeId;

                    // Permissões críticas para acessar câmera/mic de dentro do iframe
                    newIframe.allow = "camera *; microphone *; display-capture *; autoplay *";

                    Object.assign(newIframe.style, {
                        position: "fixed",
                        top: "0",
                        left: "0",
                        width: "100vw",
                        height: "100vh",
                        border: "none",
                        zIndex: "2147483647", // Max Z-Index
                        opacity: "0",
                        transition: "opacity 0.3s ease",
                        display: "block"
                    });

                    // Injeta no HTML (documentElement) para evitar bloqueios de stack context do Body
                    if (document.documentElement) {
                        document.documentElement.appendChild(newIframe);
                    } else {
                        document.body.appendChild(newIframe);
                    }

                    // Animação de entrada
                    requestAnimationFrame(() => {
                        newIframe.style.opacity = "1";
                    });
                }
            }
        });
    } catch (error) {
        console.error("Erro ao inicializar na aba:", error);
    }
});

/**
 * Listener Central de Mensagens.
 * Recebe mensagens de qualquer parte da extensão (Popup, Content, Editor, Playback).
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Envelopa o handler em uma Promise para permitir resposta assíncrona (return true)
    handleMessage(message, sender).then(sendResponse).catch(err => {
        console.error("Erro no processamento da mensagem:", err);
        sendResponse({ error: err.message });
    });
    return true;
});

/**
 * Controlador Principal (Router).
 * Decide qual ação tomar com base no `msg.action`.
 * * @param {Object} msg - O objeto da mensagem enviado.
 * @param {Object} sender - Informações sobre quem enviou (aba, frame).
 * @returns {Promise<any>} - Resposta para quem enviou a mensagem.
 */
async function handleMessage(msg, sender) {
    const senderTabId = sender?.tab?.id;

    switch (msg.action) {
        // --- Autenticação ---
        case ACTIONS.GET_AUTH_TOKEN:
            return getAuthToken();

        // --- Comunicação com Content Script ---
        case ACTIONS.REQUEST_DEVICES:
            return sendMessageToTab(senderTabId, msg);

        case ACTIONS.REQUEST_RECORDING:
            if (msg.tabId) {
                await ensureContentScript(msg.tabId);
                return sendMessageToTab(msg.tabId, msg);
            }
            break;

        // --- Upload (Legado ou uso específico) ---
        case ACTIONS.UPLOAD_FILE:
            return handleDriveUpload(msg);

        // --- Gestão do Editor ---
        case ACTIONS.OPEN_EDITOR:
            // Salva o ID do vídeo no storage para a aba do editor recuperar depois
            await chrome.storage.local.set({
                videoId: msg.videoId,
                videoTimeout: msg.videoTimeout
            });

            await chrome.tabs.create({ url: chrome.runtime.getURL("src/editor/editor.html") });
            return { success: true };

        // --- Gestão da Aba de Playback (Background Audio) ---
        case ACTIONS.OPEN_PLAYBACK_TAB:
            return createPlaybackTab(msg.tabId);

        case ACTIONS.CLOSE_PLAYBACK_TAB:
            if (msg.playbackTab) {
                chrome.tabs.remove(msg.playbackTab).catch(() => { });
                state.playbackTabs.delete(msg.playbackTab);
            }
            return { success: true };

        case ACTIONS.CLOSE_TABS:
            return closeAllPlaybackTabs();

        // --- WebRTC Signaling (Roteamento de Mensagens) ---
        case ACTIONS.WEBRTC_OFFER:
        case ACTIONS.WEBRTC_CANDIDATE:
            // Envia para todas as abas de playback (broadcast para receptores)
            state.playbackTabs.forEach(tabId => {
                if (tabId !== senderTabId) {
                    chrome.tabs.sendMessage(tabId, msg).catch(() => { });
                }
            });
            break;

        case ACTIONS.WEBRTC_ANSWER:
            // A resposta vem do Playback e vai para a aba ativa (Content Script)
            const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTabs[0]) {
                chrome.tabs.sendMessage(activeTabs[0].id, msg).catch(() => { });
            }
            break;

        // --- Tab Capture API ---
        case "requestStream":
            return new Promise((resolve) => {
                chrome.tabCapture.getMediaStreamId({ consumerTabId: msg.tabId }, (streamId) => {
                    resolve(streamId);
                });
            });

        // --- UI Utils ---
        case ACTIONS.CHANGE_ICON:
            updateIcon(msg.type);
            break;

        // --- Transferência de Vídeo via IndexedDB ---
        case ACTIONS.SAVE_CHUNK:
            const chunkBlob = new Blob([new Uint8Array(msg.data)]);
            await state.videoStorage.saveChunk(msg.videoId, chunkBlob, msg.index);
            return { success: true };

        case ACTIONS.FINISH_VIDEO:
            await state.videoStorage.finishVideo(msg.videoId, "video");

            await chrome.storage.local.set({
                videoId: msg.videoId,
                videoTimeout: 0
            });
            await chrome.tabs.create({ url: chrome.runtime.getURL("src/editor/editor.html") });
            return { success: true };
    }
}

/**
 * Realiza autenticação OAuth2 com o Google.
 * Usa launchWebAuthFlow para compatibilidade com navegadores baseados em Chromium (Brave, Edge, etc).
 * @returns {Promise<{token: string}>}
 */
function getAuthToken() {
    return new Promise((resolve, reject) => {
        try {
            const manifest = chrome.runtime.getManifest();
            const clientId = manifest.oauth2.client_id;
            const scopes = manifest.oauth2.scopes.join(' ');
            const redirectUri = chrome.identity.getRedirectURL();

            if (!clientId) {
                reject(new Error("Client ID não encontrado no manifest."));
                return;
            }

            const authUrl = `https://accounts.google.com/o/oauth2/auth` +
                `?client_id=${clientId}` +
                `&response_type=token` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&scope=${encodeURIComponent(scopes)}`;

            chrome.identity.launchWebAuthFlow({
                url: authUrl,
                interactive: true
            }, (responseUrl) => {

                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                    return;
                }

                if (responseUrl) {
                    const url = new URL(responseUrl);
                    const params = new URLSearchParams(url.hash.substring(1));
                    const token = params.get("access_token");

                    if (token) {
                        resolve({ token: token });
                    } else {
                        reject(new Error("Token não encontrado na URL de resposta."));
                    }
                } else {
                    reject(new Error("Falha silenciosa na autenticação."));
                }
            });

        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Garante que os scripts de conteúdo (Content Scripts) estejam injetados na aba alvo.
 * Verifica uma variável global (window.SoluttoContentInitialized) para evitar reinjeção.
 * @param {number} tabId 
 */
async function ensureContentScript(tabId) {
    try {
        const check = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => typeof window.SoluttoContentInitialized !== 'undefined'
        });

        if (check[0] && check[0].result === true) return;

        // Injeta scripts na ordem de dependência
        await chrome.scripting.executeScript({
            target: { tabId },
            files: [
                "src/core/constants.js",
                "src/core/utils.js",
                "src/services/UIManager.js",
                "src/services/AudioMixer.js",
                "src/services/SignalingService.js",
                "src/services/RecorderManager.js",
                "src/content/content.js"
            ]
        });

        await chrome.scripting.insertCSS({
            target: { tabId },
            files: ["src/content/style.css"]
        });

    } catch (e) {
        console.warn(`Não foi possível injetar script na aba ${tabId}:`, e);
        throw e;
    }
}

/**
 * Cria uma aba em segundo plano (pinned/inactive) para processar o áudio via WebRTC.
 * Isso impede que o navegador pause a captura de áudio da aba original.
 * @param {number} sourceTabId 
 */
async function createPlaybackTab(sourceTabId) {
    await chrome.storage.local.set({ tabId: sourceTabId });
    const tab = await chrome.tabs.create({
        url: chrome.runtime.getURL("src/playback/playback.html"),
        active: false, pinned: true, index: 0
    });
    state.playbackTabs.add(tab.id);
    return { playbackTab: tab.id };
}

/**
 * Fecha todas as abas de playback abertas pela extensão.
 */
async function closeAllPlaybackTabs() {
    const tabs = await chrome.tabs.query({});
    const tabsToClose = tabs.filter(t => t.url.includes("src/playback/playback.html")).map(t => t.id);
    if (tabsToClose.length > 0) await chrome.tabs.remove(tabsToClose);
    state.playbackTabs.clear();
    return { success: true };
}

/**
 * Processa upload para o Drive (via mensagem, caso não seja feito direto no Editor).
 * Converte o ArrayBuffer recebido de volta para Blob.
 */
async function handleDriveUpload(msg) {
    const fileBlob = new Blob([new Uint8Array(msg.file)], { type: "video/" + msg.format });
    if (!fileBlob || fileBlob.size === 0) throw new Error("Arquivo inválido ou vazio.");
    return await state.driveService.uploadVideo(fileBlob, msg.fileName);
}

/**
 * Atualiza o ícone da extensão na barra do navegador.
 * @param {string} type - 'recording' ou 'default'
 */
function updateIcon(type) {
    const path = type === "recording" ? "/assets/icon-recording.png" : "/assets/icon.png";
    chrome.action.setIcon({ path: { "16": path, "48": path, "128": path } }).catch(() => { });
}

/**
 * Wrapper para chrome.tabs.sendMessage que retorna uma Promise.
 * Facilita o uso de async/await na comunicação.
 * @param {number} tabId 
 * @param {Object} message 
 */
function sendMessageToTab(tabId, message) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                console.warn(chrome.runtime.lastError.message);
                resolve({ error: chrome.runtime.lastError.message });
            } else {
                resolve(response);
            }
        });
    });
}
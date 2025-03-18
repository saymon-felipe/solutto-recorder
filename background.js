import { uploadToDrive } from './drive.js';

// Flag para indicar se o content script já foi injetado
let added = false;

/**
 * Evento acionado quando a extensão é instalada.
 */
chrome.runtime.onInstalled.addListener(() => {
    console.log('Solutto Gravador instalado');
});

/**
 * Injeta o script de conteúdo na aba especificada.
 * Se o script já foi injetado anteriormente, ele será removido antes.
 *
 * @param {number} tabId - ID da aba onde o script será injetado.
 * @returns {Promise} Promise que é resolvida quando o script é injetado.
 */
function addContentScript(tabId) {
    return new Promise((resolve) => {
        let promises = [];

        // Se o script já foi adicionado, remove-o antes de injetar novamente
        if (added) {
            promises.push(removeContentScript(tabId));
        }

        Promise.all(promises).then(() => {
            chrome.scripting.executeScript({
                target: { tabId },
                files: ["./content.js"]
            }).then(() => {
                added = true;
                resolve();
            }).catch(err => console.log(err, "Solutto Gravador: Erro ao injetar script de conteúdo"));
        });
    });
}

/**
 * Remove o script de conteúdo da aba especificada.
 *
 * @param {number} tabId - ID da aba de onde o script será removido.
 * @returns {Promise} Promise que é resolvida quando o script é removido.
 */
function removeContentScript(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: "removeContentScript" }, (response) => {
            if (!chrome.runtime.lastError) {
                added = false;
                resolve();
            }
        });
    });
}

/**
 * Listener para o clique do ícone da extensão.
 * Injeta o script de conteúdo e adiciona ou remove o iframe do popup.
 */
chrome.action.onClicked.addListener(async function (tab) {
    // Verifica se a URL da aba é válida (inicia com "http")
    if (!/^http/.test(tab.url)) return;

    // Injeta o script de conteúdo na aba atual
    addContentScript(tab.id).then(() => {
        // Executa um script na aba para alternar a exibição do iframe do popup
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const oldIframe = document.getElementById('solutto-gravador-iframe');

                // Se o iframe já existir, remove-o
                if (oldIframe) {
                    oldIframe.remove();
                    return;
                }

                // Cria e configura um novo iframe para exibir o popup
                const iframe = document.createElement('iframe');
                iframe.src = chrome.runtime.getURL("popup.html");
                iframe.style.position = "fixed";
                iframe.style.top = "0";
                iframe.style.left = "0";
                iframe.style.width = "100vw";
                iframe.style.height = "100vh";
                iframe.style.border = "none";
                iframe.style.zIndex = "9999";
                iframe.setAttribute("id", "solutto-gravador-iframe");

                document.body.appendChild(iframe);
            },
        });
    });
});

/**
 * Listener para atualizações nas abas.
 * Quando a aba é carregada completamente e a URL é válida, injeta o script de conteúdo.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && /^http/.test(tab.url)) {
        addContentScript(tabId);
    }
});

/**
 * Listener para mensagens enviadas ao background.
 * Trata ações de download e upload de arquivos.
 */
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    // Ação para iniciar o download
    if (message.action === "download") {
        chrome.downloads.showDefaultFolder();
        sendResponse({ status: "Download iniciado!" });
    }

    // Ação para upload de arquivo
    if (message.action === 'upload-file') {
        // Cria um blob a partir dos dados do arquivo
        const fileBlob = new Blob([new Uint8Array(message.file)], { type: "video/" + message.format });

        if (fileBlob) {
            // Formata a data e hora para criar um nome único para o arquivo
            const now = new Date();
            const formattedDate = now.toLocaleDateString("pt-BR").replace(/\//g, "-"); // Ex: "18-03-2025"
            const formattedTime = now.toTimeString().slice(0, 5).replace(":", "-"); // Ex: "00-44"
            const fileName = `solutto-gravador-${formattedDate}_${formattedTime}.` + message.format;
            
            // Realiza o upload para o Google Drive
            await uploadToDrive(fileBlob, fileName);
            sendResponse({ status: 'upload-iniciado' });
        } else {
            sendResponse({ status: 'erro', message: 'Arquivo não encontrado' });
        }

        // Indica que a resposta será enviada de forma assíncrona
        return true;
    }
});
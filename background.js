//import { uploadToDrive } from './drive.js';

let added = false;

chrome.runtime.onInstalled.addListener(() => {
    console.log('Solutto Gravador instalado');
}); 

function addContentScript(tabId) {
    
    return new Promise((resolve) => {
        let promises = [];

        if (added) {
            console.log("removeu")
            promises.push(
                removeContentScript(tabId)
            )
        }

        Promise.all(promises).then(() => {
            console.log("adicionou")
            chrome.scripting.executeScript({
                target: {tabId},
                files: ["./content.js"]
            }).then(() => {
                console.log("Script de conteúdo injetado com sucesso");
                added = true;
                resolve();
            }).catch(err => console.log(err, "Erro ao injetar script de conteúdo"));
        })
    })
}

function removeContentScript(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: "removeContentScript" }, (response) => {
            if (chrome.runtime.lastError) {
                console.log("Erro ao tentar remover content script:", chrome.runtime.lastError);
            } else {
                console.log("Content script removido com sucesso.");
                added = false;
                resolve();
            }
        });
    })
}

chrome.action.onClicked.addListener(async function (tab) {
    if (!/^http/.test(tab.url)) return; 

    addContentScript(tab.id).then(() => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const oldIframe = document.getElementById('solutto-gravador-iframe');
    
                if (oldIframe) {
                    oldIframe.remove();
                    return;
                }
    
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && /^http/.test(tab.url)) {
        addContentScript(tabId);
    }
})

//addContentScript();

// Ouça mensagens da extensão para iniciar o upload ou outras ações
/*chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'upload-file') {
        const file = message.file;  // O arquivo a ser enviado para o Google Drive
        if (file) {
        uploadToDrive(file);
        //uploadFileToDrive(file);
        sendResponse({ status: 'upload-iniciado' });
        } else {
        sendResponse({ status: 'erro', message: 'Arquivo não encontrado' });
        }
    }
});*/
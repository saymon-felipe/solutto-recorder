import { uploadToDrive } from './drive.js';

let added = false;

chrome.runtime.onInstalled.addListener(() => {
    console.log('Solutto Gravador instalado');
}); 

function addContentScript(tabId) {
    
    return new Promise((resolve) => {
        let promises = [];

        if (added) {
            promises.push(
                removeContentScript(tabId)
            )
        }

        Promise.all(promises).then(() => {
            chrome.scripting.executeScript({
                target: {tabId},
                files: ["./content.js"]
            }).then(() => {
                added = true;
                resolve();
            }).catch(err => console.log(err, "Solutto Gravador: Erro ao injetar script de conteúdo"));
        })
    })
}

function removeContentScript(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: "removeContentScript" }, (response) => {
            if (!chrome.runtime.lastError) {
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

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.action === "download") {
        chrome.downloads.showDefaultFolder()
        sendResponse({ status: "Download iniciado!" });
    }

    if (message.action === 'upload-file') {
        const fileBlob = new Blob([new Uint8Array(message.file)], { type: "video/" + message.format });

        if (fileBlob) {
            const now = new Date();
            const formattedDate = now.toLocaleDateString("pt-BR").replace(/\//g, "-"); // "18-03-2025"
            const formattedTime = now.toTimeString().slice(0, 5).replace(":", "-"); // "00-44"
            const fileName = `solutto-gravador-${formattedDate}_${formattedTime}.` + message.format;
            
            await uploadToDrive(fileBlob, fileName);

            sendResponse({ status: 'upload-iniciado' });
        } else {
            sendResponse({ status: 'erro', message: 'Arquivo não encontrado' });
        }

        return true;
    }
});
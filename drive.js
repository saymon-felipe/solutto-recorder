export async function uploadToDrive(fileBlob, fileName) {
    // Nome da pasta onde os arquivos serão salvos no Google Drive
    const folderName = 'Solutto Recorder';

    //Adiciona ao nome do arquivo o milissegundo da solicitação de upload
    const now = new Date();
    const formattedTime = now.getMilliseconds();
    
    fileName += "_" + formattedTime;

    /**
     * Obtém o token de autenticação OAuth2 necessário para acessar a API do Google Drive.
     * Utiliza chrome.identity.launchWebAuthFlow para iniciar o fluxo de autenticação.
     *
     * @returns {Promise<string>} Token de acesso.
     */
    async function getAuthToken() {
        return new Promise((resolve, reject) => {
            // Obtém o client_id do manifesto da extensão
            const clientId = chrome.runtime.getManifest().oauth2.client_id;
            // Obtém a URI de redirecionamento configurada automaticamente
            const redirectUri = chrome.identity.getRedirectURL();

            // Monta a URL de autenticação com os parâmetros necessários
            const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=https://www.googleapis.com/auth/drive.file`;

            chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
                if (chrome.runtime.lastError) {
                    console.error("Erro na autenticação:", chrome.runtime.lastError);
                    reject(chrome.runtime.lastError);
                    return;
                }

                // Extrai o token de acesso da URL de resposta
                const params = new URLSearchParams(new URL(responseUrl).hash.substring(1));
                const token = params.get("access_token");
                resolve(token);
            });
        });
    }

    /**
     * Verifica se a pasta especificada já existe no Google Drive.
     *
     * @param {string} token - Token de acesso.
     * @returns {Promise<string|null>} ID da pasta, se encontrada, ou null caso não exista.
     */
    async function checkFolderExistence(token) {
        // Cria uma query para buscar a pasta com o nome definido e que não esteja na lixeira
        const query = encodeURIComponent(`name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`;

        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/json"
            }
        });

        const data = await response.json();
        // Se a pasta existir, retorna seu ID
        if (data.files && data.files.length > 0) {
            return data.files[0].id;
        } else {
            return null;
        }
    }

    /**
     * Cria uma nova pasta no Google Drive com o nome especificado.
     *
     * @param {string} token - Token de acesso.
     * @returns {Promise<string>} ID da nova pasta criada.
     */
    async function createFolder(token) {
        const url = "https://www.googleapis.com/drive/v3/files";
        const metadata = {
            name: folderName,
            mimeType: "application/vnd.google-apps.folder"
        };

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(metadata)
        });

        const data = await response.json();
        return data.id;
    }

    /**
     * Realiza o upload do arquivo para o Google Drive dentro da pasta especificada.
     *
     * @param {string} token - Token de acesso.
     * @param {string} folderId - ID da pasta onde o arquivo será salvo.
     * @returns {Promise<Object>} Resposta da API do Google Drive.
     */
    async function uploadFile(token, folderId) {
        const metadata = {
            name: fileName,
            parents: [folderId]
        };
    
        // Prepara os dados para envio utilizando FormData
        const formData = new FormData();
        formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
        formData.append("file", fileBlob);
    
        // Faz o upload do arquivo
        const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`
            },
            body: formData
        });
    
        const data = await response.json();
        
        if (!data.id) {
            console.error("Erro ao enviar arquivo:", data);
            return;
        }
    
        console.log("Solutto Recorder: Arquivo enviado para o Drive:", data);
    
        // Torna o arquivo público
        await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                role: "reader",
                type: "anyone"
            })
        });
    
        console.log("Permissão pública aplicada!");
    
        // URL pública do arquivo
        const fileUrl = `https://drive.google.com/file/d/${data.id}/view`;
    
        // Abre a pasta e o link do arquivo
        chrome.tabs.create({ url: `https://drive.google.com/drive/u/0/folders/${folderId}` });
        chrome.tabs.create({ url: fileUrl }, (tab) => {
            chrome.tabs.update(tab.id, { active: true }, () => {
                setTimeout(() => {
                    chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        function: copyToClipboard,
                        args: [fileUrl]
                    });
                }, 1000); // Pequeno delay para garantir que a aba foi carregada
            });
        });
    
        return data;
    }

    function copyToClipboard(text) {
        navigator.clipboard.writeText(text)
            .then(() => console.log("📋 Link copiado com sucesso!"))
            .catch(err => console.error("Erro ao copiar: ", err));
    }    

    // Fluxo principal: obtém o token, verifica ou cria a pasta e realiza o upload do arquivo
    try {
        const token = await getAuthToken();
        let folderId = await checkFolderExistence(token);
        if (!folderId) {
            folderId = await createFolder(token);
        }
        await uploadFile(token, folderId);
    } catch (error) {
        console.error("Solutto Recorder: Erro no processo:", error);
    }
}
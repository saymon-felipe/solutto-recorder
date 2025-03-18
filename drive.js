export async function uploadToDrive(fileBlob, fileName) {
    const folderName = 'Solutto Gravador';

    async function getAuthToken() {
        return new Promise((resolve, reject) => {
            const clientId = chrome.runtime.getManifest().oauth2.client_id;
            const redirectUri = chrome.identity.getRedirectURL(); // Obtém a URI correta automaticamente

            const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=https://www.googleapis.com/auth/drive.file`;

            chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
                if (chrome.runtime.lastError) {
                    console.error("Erro na autenticação:", chrome.runtime.lastError);
                    return;
                }

                const params = new URLSearchParams(new URL(responseUrl).hash.substring(1));
                const token = params.get("access_token");
                
                resolve(token);
            });
        });
    }

    async function checkFolderExistence(token) {
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
        if (data.files && data.files.length > 0) {
            return data.files[0].id; // Retorna o ID da pasta existente
        } else {
            return null; // Indica que a pasta não existe
        }
    }

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
        return data.id; // Retorna o ID da nova pasta
    }

    async function uploadFile(token, folderId) {
        const metadata = {
            name: fileName,
            parents: [folderId]
        };

        const formData = new FormData();
        formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
        formData.append("file", fileBlob);

        const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`
            },
            body: formData
        });

        const data = await response.json();
        console.log("Solutto Gravador: Arquivo enviado para o Drive:", data);
        return data;
    }

    try {
        const token = await getAuthToken();
        let folderId = await checkFolderExistence(token);
        if (!folderId) {
            folderId = await createFolder(token);
        }

        await uploadFile(token, folderId);
    } catch (error) {
        console.error("Solutto Gravador: Erro no processo:", error);
    }
}
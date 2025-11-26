/**
 * DriveService - Serviço de Integração com Google Drive.
 * Responsável por criar pastas, fazer upload de vídeos e gerenciar permissões de arquivos.
 * Roda tanto no Background (para auth) quanto no Editor (para upload direto).
 */
export class DriveService {
    constructor() {
        this.FOLDER_NAME = 'Solutto Recorder';
        this.AUTH_SCOPE = 'https://www.googleapis.com/auth/drive.file';
        this.UPLOAD_API_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
        this.DRIVE_API_URL = 'https://www.googleapis.com/drive/v3/files';
    }

    /**
     * Realiza o upload de um vídeo para o Google Drive usando um token de acesso já obtido.
     * Este método orquestra todo o fluxo: verificar pasta, criar pasta, upload e permissão pública.
     * * @param {string} token - Token OAuth2 válido (obtido via chrome.identity).
     * @param {Blob} fileBlob - O arquivo de vídeo a ser enviado.
     * @param {string} fileName - Nome original do arquivo.
     * @returns {Promise<{fileId: string, fileViewLink: string}>} Links e ID do arquivo criado.
     */
    async uploadVideoWithToken(token, fileBlob, fileName) {
        try {
            console.log("DriveService (Editor): Iniciando upload direto...");

            // 1. Verificar se a pasta do app já existe
            let folderId = await this._findFolder(token);
            
            // Se não existir, cria
            if (!folderId) {
                folderId = await this._createFolder(token);
            }

            // Gera um nome único para evitar conflitos de sobrescrita
            const finalFileName = this._generateUniqueName(fileName);

            // 2. Faz o Upload Multipart (Metadados + Binário)
            const fileId = await this._performMultipartUpload(token, folderId, fileBlob, finalFileName);

            // 3. Torna o arquivo público (Link compartilhável)
            await this._makeFilePublic(token, fileId);

            return {
                fileId: fileId,
                fileViewLink: `https://drive.google.com/file/d/${fileId}/view`
            };

        } catch (error) {
            console.error("DriveService: Erro no upload:", error);
            throw error;
        }
    }

    // ==========================================
    // MÉTODOS PRIVADOS (API Internals)
    // ==========================================

    /**
     * Busca a pasta padrão do aplicativo no Drive.
     * @returns {Promise<string|null>} ID da pasta ou null se não existir.
     */
    async _findFolder(token) {
        const query = encodeURIComponent(`name='${this.FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        const response = await fetch(`${this.DRIVE_API_URL}?q=${query}&fields=files(id,name)`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        const data = await response.json();
        return (data.files && data.files.length > 0) ? data.files[0].id : null;
    }

    /**
     * Cria uma nova pasta para o aplicativo.
     * @returns {Promise<string>} ID da pasta criada.
     */
    async _createFolder(token) {
        const metadata = { name: this.FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" };
        const response = await fetch(this.DRIVE_API_URL, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(metadata)
        });
        const data = await response.json();
        return data.id;
    }

    /**
     * Realiza o upload multipart (Metadata JSON + Blob Binário).
     * É o método mais eficiente para arquivos médios/grandes em uma única requisição.
     */
    async _performMultipartUpload(token, folderId, fileBlob, fileName) {
        const metadata = { name: fileName, parents: [folderId] };
        const formData = new FormData();
        
        // A parte 'metadata' deve vir primeiro e ter o type application/json
        formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
        formData.append("file", fileBlob);

        const response = await fetch(this.UPLOAD_API_URL, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}` },
            body: formData
        });

        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        return data.id;
    }

    /**
     * Define a permissão do arquivo para "reader" / "anyone" (Público com link).
     */
    async _makeFilePublic(token, fileId) {
        await fetch(`${this.DRIVE_API_URL}/${fileId}/permissions`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ role: "reader", type: "anyone" })
        });
    }

    /**
     * Adiciona um timestamp ao nome do arquivo preservando a extensão.
     * Evita que arquivos com mesmo nome (ex: video.webm) se sobrescrevam ou dupliquem.
     * @param {string} fullFileName - Ex: "gravacao.webm"
     * @returns {string} Ex: "gravacao_167890123.webm"
     */
    _generateUniqueName(fullFileName) {
        const timestamp = Date.now();
        const lastDotIndex = fullFileName.lastIndexOf('.');

        if (lastDotIndex !== -1) {
            const name = fullFileName.substring(0, lastDotIndex);
            const ext = fullFileName.substring(lastDotIndex); 
            return `${name}_${timestamp}${ext}`;
        }

        return `${fullFileName}_${timestamp}`;
    }
}
/**
 * VideoStorage - Serviço de Persistência de Vídeos.
 * Gerencia o armazenamento de vídeos em partes (chunks) utilizando o IndexedDB do navegador.
 * * Por que usar IndexedDB em vez de Blob URLs?
 * 1. Permite armazenar vídeos gigantes (1GB+) sem estourar a memória RAM.
 * 2. Resolve o problema de isolamento de contexto entre a aba gravada e o background da extensão.
 * 3. Persiste os dados mesmo se a aba for fechada acidentalmente.
 */
export class VideoStorage {
    constructor() {
        this.dbName = "SoluttoRecorderDB";
        this.metaStore = "meta";   // Armazena metadados (ID, nome, data)
        this.chunkStore = "chunks"; // Armazena os pedaços binários (Blobs)
        this.db = null;
    }

    /**
     * Inicializa a conexão com o banco de dados IndexedDB.
     * Cria as objectStores e índices necessários se for a primeira execução.
     */
    async init() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 2); // Versão 2

            request.onupgradeneeded = (event) => {
                this.db = event.target.result;
                
                // Store de Metadados
                if (!this.db.objectStoreNames.contains(this.metaStore)) {
                    this.db.createObjectStore(this.metaStore, { keyPath: "id" });
                }
                // Store de Chunks
                if (!this.db.objectStoreNames.contains(this.chunkStore)) {
                    const store = this.db.createObjectStore(this.chunkStore, { autoIncrement: true });
                    // Índice para buscar todos os chunks de um vídeo específico rapidamente
                    store.createIndex("videoId", "videoId", { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = (event) => reject("Erro DB: " + event.target.errorCode);
        });
    }

    /**
     * Salva um pedaço (chunk) do vídeo no banco de dados.
     * * @param {string} videoId - ID único do vídeo.
     * @param {Blob} blob - O pedaço de dados binários.
     * @param {number} index - A posição deste pedaço na sequência (0, 1, 2...).
     */
    async saveChunk(videoId, blob, index) {
        if (!this.db) await this.init();
        
        return new Promise((resolve, reject) => {
            const t = this.db.transaction([this.chunkStore], "readwrite");
            const store = t.objectStore(this.chunkStore);
            const request = store.add({ videoId, blob, index });

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Marca o vídeo como finalizado salvando seus metadados.
     * Deve ser chamado após todos os chunks serem salvos com sucesso.
     */
    async finishVideo(videoId, fileName) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const t = this.db.transaction([this.metaStore], "readwrite");
            const store = t.objectStore(this.metaStore);
            const request = store.add({ 
                id: videoId, 
                fileName: fileName, 
                createdAt: new Date() 
            });

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Recupera e reconstrói o vídeo completo a partir dos seus pedaços.
     * Busca todos os chunks, ordena pelo índice e cria um novo Blob unificado.
     * * @param {string} videoId - O ID do vídeo a ser recuperado.
     * @returns {Promise<Blob>} O arquivo de vídeo completo.
     */
    async getVideo(videoId) {
        if (!this.db) await this.init();

        // 1. Busca todos os chunks desse ID usando o índice
        const chunks = await new Promise((resolve, reject) => {
            const t = this.db.transaction([this.chunkStore], "readonly");
            const store = t.objectStore(this.chunkStore);
            const index = store.index("videoId");
            const request = index.getAll(videoId);

            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });

        if (!chunks || chunks.length === 0) {
            throw new Error("Nenhum dado encontrado para este vídeo.");
        }

        // 2. Ordena os pedaços para garantir a integridade do arquivo
        chunks.sort((a, b) => a.index - b.index);

        // 3. Funde os pedaços em um único Blob
        const blobParts = chunks.map(c => c.blob);
        return new Blob(blobParts, { type: chunks[0].blob.type });
    }
    
    // Método placeholder para futura implementação de limpeza automática
    async deleteVideo(videoId) {
        // ...
    }
}
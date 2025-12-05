/**
 * VideoStorage - Serviço de Persistência de Vídeos.
 */
export class VideoStorage {
    constructor() {
        this.dbName = "SoluttoRecorderDB";
        this.metaStore = "meta";
        this.chunkStore = "chunks";
        this.db = null;
    }

    async init() {
        if (this.db) return;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 3); 

            request.onupgradeneeded = (event) => {
                this.db = event.target.result;
                if (!this.db.objectStoreNames.contains(this.metaStore)) {
                    this.db.createObjectStore(this.metaStore, { keyPath: "id" });
                }
                if (!this.db.objectStoreNames.contains(this.chunkStore)) {
                    const store = this.db.createObjectStore(this.chunkStore, { autoIncrement: true });
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

    // Salva chunk com o número do segmento
    async saveChunk(videoId, blob, index, segment = 0) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const t = this.db.transaction([this.chunkStore], "readwrite");
            const store = t.objectStore(this.chunkStore);
            const request = store.add({ 
                videoId, 
                blob, 
                index: Number(index), 
                segment: Number(segment) 
            });
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // Recupera informações para Resume (Contagem e Último Segmento)
    async getResumeInfo(videoId) {
        if (!this.db) await this.init();
        const chunks = await this._getAllChunks(videoId);
        if (!chunks || chunks.length === 0) return { count: 0, lastSegment: 0 };
        
        // Pega o maior índice e o maior segmento
        chunks.sort((a, b) => a.index - b.index);
        const lastChunk = chunks[chunks.length - 1];
        
        return { 
            count: chunks.length, // ou lastChunk.index + 1
            lastSegment: lastChunk.segment || 0 
        };
    }

    async finishVideo(videoId, fileName) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const t = this.db.transaction([this.metaStore], "readwrite");
            const store = t.objectStore(this.metaStore);
            const request = store.add({ id: videoId, fileName, createdAt: new Date() });
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Retorna os segmentos separados (Array de Blobs) em vez de um blob sujo.
     * Isso permite que o FFmpeg limpe cada parte antes de juntar.
     */
    async getVideoSegments(videoId) {
        if (!this.db) await this.init();
        const chunks = await this._getAllChunks(videoId);
        if (!chunks.length) throw new Error("Sem dados.");

        // Agrupa por segmento
        const segments = {};
        chunks.forEach(c => {
            const segId = c.segment || 0;
            if (!segments[segId]) segments[segId] = [];
            segments[segId].push(c);
        });

        // Cria um Blob para cada segmento
        const result = [];
        Object.keys(segments).sort((a, b) => a - b).forEach(segId => {
            const segChunks = segments[segId];
            segChunks.sort((a, b) => a.index - b.index); // Garante ordem interna
            const blobParts = segChunks.map(c => c.blob);
            result.push(new Blob(blobParts, { type: segChunks[0].blob.type }));
        });

        return result; // [BlobPart1, BlobPart2, ...]
    }

    /**
     * Recupera o vídeo completo como um único Blob.
     * Junta todos os chunks de todos os segmentos em ordem correta.
     */
    async getVideo(videoId) {
        if (!this.db) await this.init();
        
        // 1. Pega todos os pedaços do banco de dados
        const chunks = await this._getAllChunks(videoId);
        
        if (!chunks || chunks.length === 0) {
            console.warn(`VideoStorage: Nenhum chunk encontrado para o ID ${videoId}`);
            return null;
        }

        // 2. Ordena os pedaços para garantir a sequência do vídeo
        // Primeiro pelo número do segmento, depois pelo índice dentro do segmento
        chunks.sort((a, b) => {
            const segA = a.segment || 0;
            const segB = b.segment || 0;
            if (segA !== segB) return segA - segB;
            return a.index - b.index;
        });

        // 3. Extrai apenas os dados brutos (Blobs)
        const blobParts = chunks.map(c => c.blob);
        
        // 4. Cria um novo Blob único com o tipo do primeiro pedaço (ex: video/webm)
        const mimeType = chunks[0].blob.type;
        return new Blob(blobParts, { type: mimeType });
    }

    _getAllChunks(videoId) {
        return new Promise((resolve, reject) => {
            const t = this.db.transaction([this.chunkStore], "readonly");
            const store = t.objectStore(this.chunkStore);
            const index = store.index("videoId");
            const request = index.getAll(videoId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }
}
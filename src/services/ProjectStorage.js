/**
 * ProjectStorage - Gerencia a persistência de projetos do Studio no IndexedDB.
 * Salva metadados, estado da timeline e os Blobs de mídia convertidos.
 */
export class ProjectStorage {
    constructor() {
        this.dbName = "SoluttoProjectsDB";
        this.dbVersion = 1;
        this.storeName = "projects";
        this.db = null;
    }

    async init() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: "id" });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = (event) => {
                console.error("Erro ao abrir DB de Projetos:", event.target.error);
                reject(event.target.error);
            };
        });
    }

    async saveProject(projectData) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const request = store.put(projectData);

            request.onsuccess = () => resolve(projectData.id);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async getAllProjects() {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = () => {
                resolve(request.result);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async getProject(id) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);

            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async deleteProject(id) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(id);

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }
}
(function () {
    /**
     * SoluttoUtils - Biblioteca de utilitários globais da extensão.
     * Segue o padrão de funções puras e helpers assíncronos.
     */
    window.SoluttoUtils = {
        
        /**
         * Aguarda um determinado número de milissegundos.
         * Útil para delays visuais (ex: contagem regressiva), não para lógica de controle.
         * @param {number} ms - Milissegundos para aguardar.
         * @returns {Promise<void>}
         */
        sleep: (ms) => {
            return new Promise(resolve => setTimeout(resolve, ms));
        },

        /**
         * Aguarda o próximo ciclo de pintura (repaint) do navegador.
         * Essencial para garantir que transições CSS (fade-in) funcionem após inserir elementos no DOM.
         * Substitui o uso de setTimeout(fn, 0) ou (fn, 10).
         * @returns {Promise<void>}
         */
        nextFrame: () => {
            return new Promise(resolve => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(resolve);
                });
            });
        },

        /**
         * Converte segundos em formato de tempo legível (HH:MM:SS).
         * @param {number} totalSeconds - Total de segundos.
         * @returns {string} String formatada "00:00:00".
         */
        formatTime: (totalSeconds) => {
            const hrs = Math.floor(totalSeconds / 3600);
            const mins = Math.floor((totalSeconds % 3600) / 60);
            const secs = Math.floor(totalSeconds % 60);

            const pad = (num) => String(num).padStart(2, '0');
            return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
        },

        /**
         * Gera um ID único (UUID v4 ou fallback aleatório).
         * Útil para nomear arquivos ou criar IDs de elementos DOM dinâmicos.
         * @returns {string}
         */
        generateUUID: () => {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                return crypto.randomUUID();
            }
            // Fallback para ambientes antigos (embora Chrome Ext suporte crypto)
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        },

        /**
         * Converte um Blob para uma string Base64 (sem o prefixo data:mime).
         * Útil para comunicação via mensagens chrome.runtime que não suportam Blob diretamente em versões antigas,
         * ou para uploads específicos.
         * @param {Blob} blob 
         * @returns {Promise<string>}
         */
        blobToBase64: (blob) => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    if (reader.result) {
                        const base64 = reader.result.toString().split(',')[1];
                        resolve(base64);
                    } else {
                        reject(new Error("Falha ao converter Blob para Base64"));
                    }
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        },

        /**
         * Cria o nome do arquivo padrão com timestamp.
         * Ex: solutto-recorder-2025-11-24_14-30.webm
         * @param {string} prefix 
         * @returns {string}
         */
        generateFileName: (prefix = "solutto-recorder") => {
            const now = new Date();
            const date = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
            const time = now.toTimeString().slice(0, 5).replace(":", "-"); // HH-MM
            return `${prefix}-${date}_${time}`;
        },

        /**
         * Trunca textos longos adicionando reticências.
         * @param {string} text 
         * @param {number} limit 
         * @returns {string}
         */
        truncateText: (text, limit = 40) => {
            if (!text) return "";
            return text.length > limit ? text.slice(0, limit) + "..." : text;
        },

        /**
         * Verifica se a extensão ainda é válida (contexto não invalidado).
         * Útil para parar loops se a extensão for atualizada/recarregada enquanto a aba está aberta.
         * @returns {boolean}
         */
        isExtensionContextInvalid: () => {
            return !chrome.runtime?.id;
        }
    };
})();
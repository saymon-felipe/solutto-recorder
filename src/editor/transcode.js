/**
 * TranscodeService
 * Wrapper para a biblioteca FFmpeg.wasm.
 * Responsável por inicializar o núcleo do FFmpeg, gerenciar o carregamento dos módulos WASM/Core
 * e executar comandos de processamento de vídeo (corte, conversão).
 */
export class TranscodeService {
    constructor() {
        this.ffmpeg = null;
        this.isLoaded = false;
        
        // Caminhos absolutos para os arquivos binários do FFmpeg dentro da extensão.
        // Apontam para a pasta 'lib' na raiz da extensão.
        this.coreUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.js");
        this.wasmUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.wasm");
        this.workerUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.worker.js");
    }

    /**
     * Inicializa a instância do FFmpeg e carrega os arquivos necessários.
     * Deve ser chamado uma vez antes de qualquer operação.
     * @throws {Error} Se a biblioteca não for encontrada ou falhar ao carregar.
     */
    async init() {
        if (this.isLoaded) return;
        
        // Tenta encontrar a variável global do FFmpeg (pode variar dependendo da build: FFmpegWASM ou FFmpeg)
        const scope = window.FFmpegWASM || window.FFmpeg;
        if (!scope) throw new Error("Biblioteca FFmpeg não encontrada. Verifique se o script ffmpeg.js foi carregado.");
        
        const { FFmpeg } = scope;
        this.ffmpeg = new FFmpeg();
        
        // Configura logs para debug no console
        this.ffmpeg.on("log", ({ message }) => console.log("[FFmpeg]:", message));

        try {
            // Carrega os módulos Core, WASM e Worker
            await this.ffmpeg.load({
                coreURL: this.coreUrl,
                wasmURL: this.wasmUrl,
                workerURL: this.workerUrl
            });
            this.isLoaded = true;
        } catch (error) {
            console.error("Solutto Transcoder: Erro crítico.", error);
            throw error;
        }
    }

    /**
     * Realiza o processamento do vídeo (corte ou conversão).
     * Utiliza a técnica de "Output Seeking" (-ss após -i) para garantir precisão no corte.
     * * @param {Blob} fileBlob - O arquivo de vídeo original.
     * @param {string} fileName - Nome base para os arquivos virtuais.
     * @param {number} startTime - Tempo inicial do corte em segundos.
     * @param {number} duration - Duração do corte em segundos.
     * @param {string} format - Formato de saída desejado ('webm' ou 'mp4').
     * @returns {Promise<string>} URL (Blob URL) do vídeo processado.
     */
    async processVideo(fileBlob, fileName, startTime, duration, format = 'webm') {
        if (!this.isLoaded) await this.init();

        const { fetchFile } = window.FFmpegUtil;
        const inputName = `input_${fileName}`;
        const outputName = `output_${fileName}.${format}`;

        try {
            // 1. Escreve o arquivo Blob na memória virtual do FFmpeg (FS)
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            // 2. Monta o array de argumentos para o comando FFmpeg
            let command = [];

            // Input (-i)
            command.push("-i", inputName);

            // Start Time (-ss)
            // Posicionado DEPOIS do input para forçar "Output Seeking".
            // Isso decodifica o vídeo desde o início até o ponto de corte, garantindo precisão frame a frame.
            // (Input seeking seria mais rápido, mas impreciso em WebM).
            command.push("-ss", startTime.toString());

            // Duração (-t)
            command.push("-t", duration.toString());

            // Configurações de Codec baseadas no formato
            if (format === 'mp4') {
                // MP4: H.264 (vídeo) + AAC (áudio)
                // Preset ultrafast para velocidade máxima
                // Movflags faststart para permitir reprodução enquanto baixa (boa prática web)
                command.push(
                    "-c:v", "libx264", 
                    "-preset", "ultrafast", 
                    "-c:a", "aac",
                    "-movflags", "+faststart"
                );
            } else {
                // WebM: VP8 (vídeo) + Vorbis (áudio)
                // Deadline realtime e cpu-used 8 para máxima velocidade de encode em WASM
                command.push(
                    "-c:v", "libvpx", 
                    "-deadline", "realtime", 
                    "-cpu-used", "8", 
                    "-c:a", "libvorbis"
                );
            }

            // Arquivo de Saída
            command.push(outputName);

            console.log("Executando FFmpeg (Preciso):", command.join(" "));
            
            // 3. Executa o comando
            await this.ffmpeg.exec(command);

            // 4. Lê o arquivo gerado da memória virtual
            const data = await this.ffmpeg.readFile(outputName);
            
            // 5. Cria um novo Blob e retorna a URL
            const mimeType = format === 'mp4' ? "video/mp4" : "video/webm";
            const resultBlob = new Blob([data.buffer], { type: mimeType });
            
            return URL.createObjectURL(resultBlob);

        } catch (error) {
            console.error("Erro FFmpeg:", error);
            throw error;
        } finally {
            // 6. Limpeza (Garbage Collection Virtual)
            // Remove arquivos da memória do FFmpeg para liberar RAM do navegador
            try {
                await this.ffmpeg.deleteFile(inputName);
                await this.ffmpeg.deleteFile(outputName);
            } catch (e) {}
        }
    }
}
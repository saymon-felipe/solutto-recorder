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
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            let command = [];

            // Input e Corte
            command.push("-i", inputName);
            command.push("-ss", startTime.toString());
            command.push("-t", duration.toString());

            // --- LÓGICA ESPECÍFICA PARA CADA FORMATO ---
            if (format === 'gif') {
                // Comando Complexo para GIF de Alta Qualidade
                // 1. fps=10: Reduz frames para não ficar pesado
                // 2. scale=720:-1: Redimensiona largura para 720px (altura automática)
                // 3. split...paletteuse: Gera uma paleta de cores otimizada para evitar granulado
                command.push(
                    "-vf", "fps=10,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
                    "-f", "gif"
                );
            } 
            else if (format === 'mp4') {
                command.push(
                    "-c:v", "libx264", 
                    "-preset", "ultrafast", 
                    "-c:a", "aac",
                    "-movflags", "+faststart"
                );
            } 
            else {
                // WebM (Padrão)
                command.push(
                    "-c:v", "libvpx", 
                    "-deadline", "realtime", 
                    "-cpu-used", "8", 
                    "-c:a", "libvorbis"
                );
            }

            command.push(outputName);

            console.log("Executando FFmpeg:", command.join(" "));
            
            await this.ffmpeg.exec(command);

            const data = await this.ffmpeg.readFile(outputName);
            
            // Define o MIME type correto
            let mimeType = "video/webm";
            if (format === 'mp4') mimeType = "video/mp4";
            if (format === 'gif') mimeType = "image/gif";

            const resultBlob = new Blob([data.buffer], { type: mimeType });
            
            return URL.createObjectURL(resultBlob);

        } catch (error) {
            console.error("Erro FFmpeg:", error);
            throw error;
        } finally {
            try {
                await this.ffmpeg.deleteFile(inputName);
                await this.ffmpeg.deleteFile(outputName);
            } catch (e) {}
        }
    }
}
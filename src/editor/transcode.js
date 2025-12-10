/**
 * TranscodeService
 * * Wrapper para a biblioteca FFmpeg.wasm.
 * Responsável por inicializar o núcleo do FFmpeg (Core/WASM/Worker) e executar 
 * comandos complexos de processamento de mídia no navegador.
 */
export class TranscodeService {
    
    constructor() {
        this.ffmpeg = null;
        this.isLoaded = false;

        // Definição dos caminhos dos recursos estáticos
        const baseUrl = "/src/lib/ffmpeg/";
        this.coreUrl = chrome.runtime.getURL(`${baseUrl}ffmpeg-core.js`);
        this.wasmUrl = chrome.runtime.getURL(`${baseUrl}ffmpeg-core.wasm`);
        this.workerUrl = chrome.runtime.getURL(`${baseUrl}ffmpeg-core.worker.js`);
    }

    /**
     * Calcula a memória ideal para alocar ao WebAssembly baseada no hardware do dispositivo.
     * @private
     * @returns {{ pages: number }} Quantidade de páginas de memória (1 página = 64KB).
     */
    _calcMemory() {
        try {
            // Tenta detectar memória do dispositivo ou assume 4GB como fallback seguro
            const dm = navigator.deviceMemory || 4;
            
            // Limita a alocação a 80% da memória ou teto de 2GB (limite safe do WASM em alguns browsers)
            const maxMb = Math.min(dm * 1024 * 0.8, 2048);
            const pages = Math.floor((maxMb * 1024 * 1024) / 65536);
            
            return { pages }; 
        } catch {
            // Fallback conservador em caso de erro de acesso à API
            return { pages: 1024 };
        }
    }

    /**
     * Inicializa a instância do FFmpeg e carrega os binários WASM.
     * @returns {Promise<void>}
     */
    async init() {
        if (this.isLoaded) return;

        const scope = window.FFmpegWASM || window.FFmpeg;
        if (!scope) throw new Error("Biblioteca FFmpeg não encontrada no escopo global.");

        const { FFmpeg } = scope;
        const mem = this._calcMemory();
        const byteSize = mem.pages * 65536;

        this.ffmpeg = new FFmpeg({
            coreURL: this.coreUrl,
            wasmURL: this.wasmUrl,
            workerURL: this.workerUrl,
            wasmOptions: {
                initialMemory: byteSize,
                maximumMemory: byteSize,
            }
        });

        // Configuração de logs internos
        this.ffmpeg.on("log", (evt) => {
            const msg = typeof evt === "string" ? evt : evt && evt.message;
            if (typeof msg === "string") {
                console.log("[FFmpeg]:", msg); 
            }
        });

        try {
            await this.ffmpeg.load({
                coreURL: this.coreUrl,
                wasmURL: this.wasmUrl,
                workerURL: this.workerUrl
            });
            this.isLoaded = true;
        } catch (error) {
            console.error("Solutto Transcoder: Erro crítico na inicialização.", error);
            throw error;
        }
    }

    /**
     * Helper para recuperar a função utilitária fetchFile.
     * @private
     */
    _getFetchFile() {
        if (window.FFmpegUtil && window.FFmpegUtil.fetchFile) return window.FFmpegUtil.fetchFile;
        throw new Error("FFmpegUtil.fetchFile indisponível.");
    }

    /**
     * Encerra o processo atual do FFmpeg e limpa a instância.
     */
    async cancelJob() {
        if (this.ffmpeg) {
            try { 
                await this.ffmpeg.terminate(); 
            } catch (e) {
                console.warn("Erro ao terminar FFmpeg:", e);
            }
            this.ffmpeg = null;
            this.isLoaded = false;
        }
    }

    /**
     * Processa um vídeo ou imagem aplicando cortes, filtros e conversão de formato.
     * * @param {Blob} fileBlob - O arquivo de entrada.
     * @param {string} fileName - Nome original do arquivo.
     * @param {number} startTime - Tempo de início do corte (em segundos).
     * @param {number} duration - Duração do corte (em segundos).
     * @param {'webm'|'mp4'|'gif'} format - Formato de saída desejado.
     * @param {Object} options - Opções extras (ex: opacity).
     * @returns {Promise<string>} URL do Blob gerado.
     */
    async processVideo(fileBlob, fileName, startTime, duration, format = 'webm', options = {}, onProgress = null) {
        if (!this.isLoaded) await this.init();

        const { fetchFile } = window.FFmpegUtil;
        const safeId = Date.now() + "_" + Math.floor(Math.random()*1000);
        
        const type = fileBlob.type || '';
        let ext = 'webm';
        if (type.includes('mp4')) ext = 'mp4';
        else if (type.includes('jpeg') || type.includes('jpg')) ext = 'jpg';
        else if (type.includes('png')) ext = 'png';
        else if (type.includes('gif')) ext = 'gif';

        const inputName = `proc_in_${safeId}.${ext}`;
        const outputName = `proc_out_${safeId}.${format}`;

        const logHandler = ({ message }) => {
            if (!onProgress) return;
            const timeMatch = message.match(/time=\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
            const speedMatch = message.match(/speed=\s*([\d.]+)x/);
            
            if (timeMatch) {
                const timeStr = timeMatch[1];
                const [h, m, s] = timeStr.split(':');
                const secondsProcessed = (parseInt(h) * 3600) + (parseInt(m) * 60) + parseFloat(s);
                const speed = speedMatch ? parseFloat(speedMatch[1]) : 0;
                const pct = duration > 0 ? Math.min(1, secondsProcessed / duration) : 0;

                onProgress({ secondsProcessed, percent: pct, speed });
            }
        };

        this.ffmpeg.on("log", logHandler);

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            let command = [];
            const isImage = type.startsWith('image');

            if (isImage && format !== 'gif') command.push("-loop", "1");

            if (!isImage) {
                command.push("-r", "30"); 
            }

            command.push("-i", inputName);

            if (!isImage) command.push("-ss", startTime.toString());
            command.push("-t", duration.toString());

            let videoFilters = [];
            if (options.opacity !== undefined && options.opacity < 1 && format !== 'gif') {
                videoFilters.push("format=yuva420p"); 
                const alphaVal = Math.floor(options.opacity * 255);
                videoFilters.push(`lutyuv=a=${alphaVal}`);
            }

            // OOM Protection e Scale
            if (format === 'mp4') {
                videoFilters.push("scale='min(1920,iw)':-1:flags=lanczos");
            } else {
                videoFilters.push("setsar=1");
            }

            if (format === 'gif') {
                command.push("-vf", "fps=10,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", "-f", "gif");
            } 
            else if (format === 'mp4') {
                if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));
                command.push(
                    "-c:v", "libx264", 
                    "-preset", "superfast", 
                    "-crf", "20", 
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "160k", 
                    "-movflags", "+faststart"
                );
            } 
            else {
                if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));
                command.push("-c:v", "libvpx", "-deadline", "good", "-cpu-used", "2", "-crf", "10", "-b:v", "0", "-c:a", "libvorbis", "-b:a", "192k");
                if (options.opacity < 1) command.push("-auto-alt-ref", "0");
            }

            command.push(outputName);
            
            await this.ffmpeg.exec(command);

            const data = await this.ffmpeg.readFile(outputName);
            let mimeType = format === 'mp4' ? "video/mp4" : (format === 'gif' ? "image/gif" : "video/webm");
            
            return URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));

        } catch (error) {
            console.error("Transcode Error:", error);
            throw error; // Repassa erro para a UI tratar
        } finally {
            this.ffmpeg.off("log", logHandler);
            try { await this.ffmpeg.deleteFile(inputName); } catch (e) {}
            try { await this.ffmpeg.deleteFile(outputName); } catch (e) {}
        }
    }

    /**
     * Mescla múltiplos segmentos de vídeo em um único arquivo.
     * * @param {Array<Blob|string>} segments - Lista de blobs ou URLs dos vídeos.
     * @param {string} outputName - Nome base para o arquivo de saída.
     * @returns {Promise<string>} URL do Blob mesclado (WebM).
     */
    async mergeSegments(segments, outputName = "merged") {
        if (!this.isLoaded) await this.init();
        if (!segments || segments.length === 0) throw new Error("Sem segmentos para mesclar.");
        
        const fetchFile = this._getFetchFile();
        const timestamp = Date.now();
        
        // Listas para rastreamento de arquivos temporários
        const inputFiles = [];
        const listName = `list_${timestamp}.txt`;
        const outName = `merged_${timestamp}.webm`;

        try {
            // 1. Escreve cada segmento no FS virtual
            for (let i = 0; i < segments.length; i++) {
                const name = `seg_${i}_${timestamp}.webm`;
                await this.ffmpeg.writeFile(name, await fetchFile(segments[i]));
                inputFiles.push(name);
            }

            // 2. Cria o arquivo de lista para o concat demuxer
            const content = inputFiles.map(f => `file '${f}'`).join('\n');
            await this.ffmpeg.writeFile(listName, new TextEncoder().encode(content));
            
            // 3. Executa concat (copy codec para velocidade máxima)
            await this.ffmpeg.exec([
                "-f", "concat", 
                "-safe", "0", 
                "-i", listName, 
                "-c", "copy", 
                outName
            ]);
            
            const data = await this.ffmpeg.readFile(outName);
            return URL.createObjectURL(new Blob([data.buffer], { type: "video/webm" }));

        } catch (e) {
            throw e;
        } finally {
            // Limpeza de todos os artefatos
            try { await this.ffmpeg.deleteFile(listName); } catch(e){}
            try { await this.ffmpeg.deleteFile(outName); } catch(e){}
            for(const f of inputFiles) {
                try { await this.ffmpeg.deleteFile(f); } catch(e){}
            }
        }
    }
}
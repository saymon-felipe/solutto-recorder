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

    async load() {
        return this.init();
    }

    /**
     * Inicializa a instância do FFmpeg e carrega os binários WASM.
     * @returns {Promise<void>}
     */
    async init() {
        if (this.isLoaded && this.ffmpeg) return;

        const scope = window.FFmpegWASM || window.FFmpeg;
        if (!scope) throw new Error("Biblioteca FFmpeg não encontrada no escopo global.");

        const { FFmpeg } = scope;

        this.ffmpeg = new FFmpeg({
            coreURL: this.coreUrl,
            wasmURL: this.wasmUrl,
            workerURL: this.workerUrl
        });

        this.ffmpeg.on("log", (evt) => {
            // Garante que msg seja string segura
            const msg = (typeof evt === "string") ? evt : (evt && evt.message);

            // Verifica explicitamente se msg existe antes de usar startsWith
            if (msg && typeof msg === "string") {
                if (!msg.startsWith('Aborted')) {
                    console.log("[FFmpeg]:", msg);
                }
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
            this.isLoaded = false;
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
 * Versão Otimizada: Usa Stream Copy para cortes simples (sem re-encoding).
 * * @param {Blob} fileBlob - O arquivo de entrada.
 * @param {string} fileName - Nome original do arquivo.
 * @param {number} startTime - Tempo de início do corte (em segundos).
 * @param {number} duration - Duração do corte (em segundos).
 * @param {'webm'|'mp4'|'gif'} format - Formato de saída desejado.
 * @param {Object} options - Opções extras (ex: opacity).
 * @param {Function} onProgress - Callback de progresso.
 * @returns {Promise<string>} URL do Blob gerado.
 */
    async processVideo(fileBlob, fileName, startTime, duration, format = 'webm', options = {}, onProgress = null) {
        if (!this.isLoaded) await this.init();

        const { fetchFile } = window.FFmpegUtil;
        const safeId = Date.now() + "_" + Math.floor(Math.random() * 1000);

        const type = fileBlob.type || '';
        let ext = 'webm';
        if (type.includes('mp4')) ext = 'mp4';
        else if (type.includes('jpeg') || type.includes('jpg')) ext = 'jpg';
        else if (type.includes('png')) ext = 'png';
        else if (type.includes('gif')) ext = 'gif';

        const inputName = `proc_in_${safeId}.${ext}`;
        const outputName = `proc_out_${safeId}.${format}`;

        // Handler de Logs
        const logHandler = ({ message }) => {
            if (!onProgress) return;

            // Regex para capturar tempo e velocidade
            const timeMatch = message.match(/time=\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
            const speedMatch = message.match(/speed=\s*([\d.]+)x/);

            if (timeMatch) {
                const timeStr = timeMatch[1];
                const [h, m, s] = timeStr.split(':');
                const secondsProcessed = (parseInt(h) * 3600) + (parseInt(m) * 60) + parseFloat(s);

                // Lógica de Progresso para GIF Timelapse
                // Se for GIF acelerado, o FFmpeg reporta o tempo do VÍDEO DE SAÍDA (que é curto), não da entrada.
                // Ex: Vídeo de 100s virou GIF de 5s. O time= vai de 0 a 5.
                let targetDuration = duration;
                if (format === 'gif' && duration > 10) {
                    targetDuration = 5; // A duração fixa que definimos no timelapse
                }

                const pct = targetDuration > 0 ? Math.min(1, secondsProcessed / targetDuration) : 0;
                const speed = speedMatch ? parseFloat(speedMatch[1]) : 0;

                onProgress({ secondsProcessed, percent: pct, speed });
            }
        };

        this.ffmpeg.on("log", logHandler);

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            let command = [];
            const isImage = type.startsWith('image');
            const hasVisualFilters = (options.opacity !== undefined && options.opacity < 1);

            // Verifica se pode usar Stream Copy (Rápido)
            const canStreamCopy = !isImage && !hasVisualFilters && (ext === format);

            if (canStreamCopy) {
                // === MODO RÁPIDO (Copy) ===
                command.push("-ss", startTime.toString());
                command.push("-i", inputName);
                command.push("-t", duration.toString());
                command.push("-c", "copy", "-avoid_negative_ts", "make_zero");

                if (format === 'mp4') command.push("-movflags", "+faststart");

            } else {
                // === MODO TRANSCODE ===
                if (isImage && format !== 'gif') command.push("-loop", "1");

                // Força 30fps na entrada para corrigir metadados quebrados de WebM gravado
                if (!isImage) command.push("-r", "30");

                command.push("-i", inputName);

                if (!isImage) command.push("-ss", startTime.toString());
                command.push("-t", duration.toString());

                let videoFilters = [];

                // Filtros de Opacidade
                if (hasVisualFilters && format !== 'gif') {
                    videoFilters.push("format=yuva420p");
                    const alphaVal = Math.floor(options.opacity * 255);
                    videoFilters.push(`lutyuv=a=${alphaVal}`);
                }

                if (format === 'gif') {
                    const GIF_MAX_DURATION = 5;
                    let speedFactor = 1;

                    // Se o vídeo for longo, calcula fator de aceleração
                    if (duration > 10) {
                        speedFactor = duration / GIF_MAX_DURATION;
                        console.log(`Auto-Timelapse GIF: Acelerando ${speedFactor.toFixed(1)}x`);
                    }

                    // Filtro PTS para acelerar o vídeo (setpts = PTS / Fator)
                    const ptsFilter = speedFactor > 1 ? `,setpts=PTS/${speedFactor.toFixed(2)}` : '';

                    videoFilters.push(`fps=10,scale=480:-1:flags=lanczos${ptsFilter}`);

                    command.push("-vf", videoFilters.join(","));
                    command.push("-f", "gif");
                }
                else if (format === 'mp4') {
                    videoFilters.push("scale='min(1920,iw)':-2:flags=lanczos");
                    if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));

                    command.push(
                        "-c:v", "libx264",
                        "-preset", "ultrafast",
                        "-crf", "24",
                        "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "128k",
                        "-movflags", "+faststart"
                    );
                }
                else {
                    // WebM
                    videoFilters.push("setsar=1");
                    if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));

                    command.push("-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "5", "-crf", "15", "-b:v", "0", "-c:a", "libvorbis", "-b:a", "128k");
                    if (options.opacity < 1) command.push("-auto-alt-ref", "0");
                }
            }

            command.push(outputName);
            console.log("FFmpeg Cmd:", command.join(" "));

            await this.ffmpeg.exec(command);

            const data = await this.ffmpeg.readFile(outputName);
            let mimeType = format === 'mp4' ? "video/mp4" : (format === 'gif' ? "image/gif" : "video/webm");

            return URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));

        } catch (error) {
            console.error("Transcode Error:", error);
            throw error;
        } finally {
            this.ffmpeg.off("log", logHandler);
            try { await this.ffmpeg.deleteFile(inputName); } catch (e) { }
            try { await this.ffmpeg.deleteFile(outputName); } catch (e) { }
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
            try { await this.ffmpeg.deleteFile(listName); } catch (e) { }
            try { await this.ffmpeg.deleteFile(outName); } catch (e) { }
            for (const f of inputFiles) {
                try { await this.ffmpeg.deleteFile(f); } catch (e) { }
            }
        }
    }
}
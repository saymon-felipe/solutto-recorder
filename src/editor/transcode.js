/**
 * TranscodeService
 * Wrapper para a biblioteca FFmpeg.wasm.
 * Responsável por inicializar o núcleo do FFmpeg, gerenciar o carregamento dos módulos WASM/Core
 * e executar comandos de processamento de vídeo (corte, conversão, fusão).
 * */

const round = (num, precision = 3) => parseFloat(num.toFixed(precision));

export class TranscodeService {
    constructor() {
        this.ffmpeg = null;
        this.isLoaded = false;

        // Caminhos absolutos para os arquivos binários do FFmpeg dentro da extensão.
        this.coreUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.js");
        this.wasmUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.wasm");
        this.workerUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.worker.js");
    }

    _calcMemory() {
        try {
            const dm = navigator.deviceMemory || 4;
            const maxMb = Math.min(dm * 1024 * 0.8, 2048);
            const pages = Math.floor((maxMb * 1024 * 1024) / 65536);
            return { pages }; 
        } catch {
            return { pages: 1024 };
        }
    }

    /**
     * Inicializa a instância do FFmpeg e carrega os arquivos necessários.
     */
    async init() {
        if (this.isLoaded) return;

        const scope = window.FFmpegWASM || window.FFmpeg;
        if (!scope) throw new Error("Biblioteca FFmpeg não encontrada.");

        const { FFmpeg } = scope;
        const mem = this._calcMemory();
        this.ffmpeg = new FFmpeg({
            coreURL: this.coreUrl,
            wasmURL: this.wasmUrl,
            workerURL: this.workerUrl,
            wasmOptions: {
                initialMemory: mem.pages * 65536,
                maximumMemory: mem.pages * 65536,
            }
        });

        // Logs básicos globais
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
            console.error("Solutto Transcoder: Erro crítico.", error);
            throw error;
        }
    }

    _getFetchFile() {
        if (window.FFmpegUtil && window.FFmpegUtil.fetchFile) return window.FFmpegUtil.fetchFile;
        throw new Error("FFmpegUtil.fetchFile indisponível.");
    }

    /**
     * @param {Blob} fileBlob - Arquivo original
     * @param {Object} options - Opções de qualidade do proxy
     * @returns {Blob} - Arquivo proxy comprimido
     */
    async createProxy(fileBlob, options = {}) {
        if (!this.isLoaded) await this.init();

        const fetchFile = this._getFetchFile();

        const inputExt = (fileBlob.type && fileBlob.type.split("/")[1]) || "webm";
        const inputName = `proxy_input_${Date.now()}.${inputExt}`;
        const outputName = `proxy_output_${Date.now()}.webm`;

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            const command = [
                "-i", inputName,
                "-c:v", "libvpx",
                "-deadline", "realtime",
                "-cpu-used", "8",
                "-crf", options.crf || "30", // Qualidade baixa para proxy
                "-b:v", "500k", // Bitrate limitado
                "-c:a", "libvorbis",
                "-b:a", "64k",
                "-vf", `scale=${options.scale || '640:-1'}`, // Resolução reduzida
                "-an", // Remove áudio se não necessário (opcional)
                outputName
            ];

            console.log("[FFmpeg CREATE PROXY]:", command.join(" "));

            await this.ffmpeg.exec(command);

            const data = await this.ffmpeg.readFile(outputName);

            return new Blob([data.buffer], { type: "video/webm" });

        } catch (error) {
            console.error("Erro FFmpeg durante createProxy:", error);
            throw error;
        } finally {
            try {
                await this.ffmpeg.deleteFile(inputName);
            } catch (e) { }
            try {
                await this.ffmpeg.deleteFile(outputName);
            } catch (e) { }
        }
    }

    /**
     * Força o encerramento do Worker FFmpeg
     */
    async cancelJob() {
        if (this.ffmpeg) {
            try {
                await this.ffmpeg.terminate();
                console.log("[Transcoder] Worker encerrado.");
            } catch (e) {
                console.error("Erro ao encerrar worker:", e);
            } finally {
                this.ffmpeg = null;
                this.isLoaded = false;
            }
        }
    }

    /**
     * Processa vídeo aplicando corte e efeitos opcionais.
     */
    async processVideo(fileBlob, fileName, startTime, duration, format = 'webm', options = {}) {
        if (!this.isLoaded) await this.init();

        const { fetchFile } = window.FFmpegUtil;
        const inputName = `input_${fileName}`;
        const outputName = `output_${fileName}.${format}`;

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            let command = [];

            command.push("-i", inputName);
            command.push("-ss", startTime.toString());
            command.push("-t", duration.toString());

            let videoFilters = [];

            if (options.opacity !== undefined && options.opacity < 1 && format !== 'gif') {
                console.log(`[Transcoder] Aplicando opacidade otimizada: ${options.opacity}`);
                
                // 1. Promove para formato com Alpha (yuva420p)
                videoFilters.push("format=yuva420p"); 
                
                // 2. Define o valor do canal Alpha (A) usando LUT.
                const alphaVal = Math.floor(options.opacity * 255);
                videoFilters.push(`lutyuv=a=${alphaVal}`);
            }

            if (format === 'gif') {
                command.push(
                    "-vf", "fps=10,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
                    "-f", "gif"
                );
            } 
            else if (format === 'mp4') {
                if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));
                command.push(
                    "-c:v", "libx264", 
                    "-preset", "ultrafast", 
                    "-c:a", "aac",
                    "-movflags", "+faststart"
                );
            } 
            else {
                // WebM
                if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));

                command.push(
                    "-c:v", "libvpx", 
                    "-deadline", "realtime", // Garante velocidade máxima
                    "-cpu-used", "8",        // Usa todos os threads/recursos disponíveis
                    "-c:a", "libvorbis"
                );
                
                if (options.opacity < 1) {
                    command.push("-auto-alt-ref", "0");
                }
            }

            command.push(outputName);
            // console.log("Executando FFmpeg:", command.join(" "));
            
            await this.ffmpeg.exec(command);

            try {
                const data = await this.ffmpeg.readFile(outputName);
                let mimeType = format === 'mp4' ? "video/mp4" : (format === 'gif' ? "image/gif" : "video/webm");
                const resultBlob = new Blob([data.buffer], { type: mimeType });
                return URL.createObjectURL(resultBlob);
            } catch (readError) {
                throw new Error("Falha ao ler arquivo de saída do FFmpeg.");
            }

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

    /**
     * Converte um Blob de imagem ou GIF em um vídeo WebM de duração fixa.
     */
    async imageToVideo(fileBlob, durationSeconds = 5, options = {}) {
        if (!this.isLoaded) await this.init();
        const fetchFile = this._getFetchFile();

        const mimeType = fileBlob.type || "image/png";
        const fileExtension = fileBlob.name
            ? fileBlob.name.split(".").pop().toLowerCase()
            : (mimeType.split("/")[1] || "png");

        const inputName = `input_img_${Date.now()}.${fileExtension}`;
        const outputName = `output_img_${Date.now()}.webm`;

        const isGif = mimeType === "image/gif";

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            let command = [];

            if (isGif) {
                command.push("-i", inputName);
            } else {
                command.push("-loop", "1");
                command.push("-f", "image2");
                command.push("-i", inputName);
                command.push("-t", durationSeconds.toString());
            }

            const isProxy = options.isProxy || false;

            command.push(
                "-r", "25",
                "-g", "1",
                "-deadline", "realtime",
                "-cpu-used", "8",
                "-crf", isProxy ? "30" : "10",
                "-b:v", isProxy ? "500k" : "0",
                "-an", // Sem stream de áudio
                "-c:v", "libvpx",
                "-pix_fmt", "yuv420p",
                "-vf",
                isProxy
                    ? "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2"
                    : "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
                outputName
            );

            console.log("[FFmpeg IMAGE2VIDEO]:", command.join(" "));
            await this.ffmpeg.exec(command);

            const data = await this.ffmpeg.readFile(outputName);
            await this.ffmpeg.deleteFile(inputName);
            await this.ffmpeg.deleteFile(outputName);

            return URL.createObjectURL(new Blob([data.buffer], { type: "video/webm" }));
        } catch (e) {
            console.error(e);
            throw new Error("Falha imageToVideo: " + (e.message || String(e)));
        }
    }

    /**
     * Une múltiplos segmentos de vídeo em um único arquivo
     */
    async mergeSegments(segments, outputName = "merged") {
        if (!this.isLoaded) await this.init();

        if (!segments || segments.length === 0) {
            throw new Error("Nenhum segmento fornecido para mesclar");
        }

        if (segments.length === 1) {
            return URL.createObjectURL(segments[0]);
        }

        const fetchFile = this._getFetchFile();
        const filesToClean = [];

        try {
            const inputFiles = [];
            for (let i = 0; i < segments.length; i++) {
                const segmentName = `segment_${i}.webm`;
                await this.ffmpeg.writeFile(segmentName, await fetchFile(segments[i]));
                inputFiles.push(segmentName);
                filesToClean.push(segmentName);
            }

            const listContent = inputFiles.map(f => `file '${f}'`).join('\n');
            const listFileName = 'concat_list.txt';
            await this.ffmpeg.writeFile(listFileName, new TextEncoder().encode(listContent));
            filesToClean.push(listFileName);

            const outputFileName = `${outputName}.webm`;
            filesToClean.push(outputFileName);

            const command = [
                "-f", "concat",
                "-safe", "0",
                "-i", listFileName,
                "-c", "copy", 
                outputFileName
            ];

            console.log("[FFmpeg MERGE]:", command.join(" "));
            await this.ffmpeg.exec(command);

            const data = await this.ffmpeg.readFile(outputFileName);
            const blob = new Blob([data.buffer], { type: "video/webm" });

            return URL.createObjectURL(blob);

        } catch (error) {
            console.error("Erro ao mesclar segmentos:", error);
            throw new Error(`Falha ao mesclar segmentos: ${error.message || String(error)}`);
        } finally {
            for (const file of filesToClean) {
                try { await this.ffmpeg.deleteFile(file); } catch (e) { }
            }
        }
    }

    /**
     * Faz a mixagem do projeto completo (timeline → vídeo final)
     * Agora suporta detecção de faixas de áudio e múltiplos formatos.
     */
    async mixProject(allClips, assetsMap, totalDuration, progressCallback, options = {}) {
        if (!this.isLoaded) await this.init();

        const fetchFile = this._getFetchFile();
        
        // 1. Definição do Formato
        const reqFormat = options.format || 'webm';
        const isMp4 = reqFormat === 'mp4';
        const outputFormat = isMp4 ? 'mp4' : 'webm';

        const intermediateName = `intermediate_mix.${outputFormat}`;
        const finalOutputName = `final_mix_output.${outputFormat}`;
        const filesToClean = [intermediateName, finalOutputName];
        const inputFiles = []; 

        // Presets de Qualidade
        const qualityPresets = {
            veryslow: { preset: "veryslow", crf: 15, bitrate: null, audioBitrate: "320k" },
            high:     { preset: "slow",     crf: 18, bitrate: null, audioBitrate: "320k" },
            medium:   { preset: "medium",   crf: 23, bitrate: null, audioBitrate: "192k" },
            low:      { preset: "veryfast", crf: 28, bitrate: "2000k", audioBitrate: "128k" },
            proxy:    { preset: "ultrafast",crf: 35, bitrate: "500k", audioBitrate: "64k" }
        };

        const qualityKey = options.quality || 'medium';
        // CORREÇÃO: let para permitir fallback
        let quality = qualityPresets[qualityKey];

        if (!quality) {
            console.warn(`[FFmpeg] Preset '${qualityKey}' não encontrado, usando 'medium'`);
            quality = qualityPresets.medium;
        }

        console.log(`[FFmpeg MixProject] Qualidade: '${qualityKey}' | Formato: ${outputFormat.toUpperCase()}`);

        const TARGET_FPS = 30;

        const resolutionPresets = {
            high: { w: '1920', h: '1080' },
            medium: { w: '1280', h: '720' },
            low: { w: '640', h: '480' },
            proxy: { w: '640', h: '360' }
        };

        const resolution = resolutionPresets[options.quality] || resolutionPresets.medium;
        const targetW = resolution.w;
        const targetH = resolution.h;

        const safeProgress = typeof progressCallback === "function" ? progressCallback : () => { };

        const progressHandler = (evt) => {
            const message = typeof evt === "string" ? evt : evt && evt.message;
            if (typeof message === "string" && message.indexOf("frame=") === 0) {
                const timeMatch = message.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                const speedMatch = message.match(/speed=([\d\.]+)x/);
                if (timeMatch && totalDuration > 0) {
                    const [, h, m, s, cs] = timeMatch[1].match(/(\d{2}):(\d{2}):(\d{2})\.(\d{2})/).map(Number);
                    const currentTime = h * 3600 + m * 60 + s + cs / 100;
                    try { safeProgress(Math.min(1, currentTime / totalDuration), speedMatch ? speedMatch[1] : "N/A"); } catch (e) {}
                }
            }
        };

        try {
            if (!assetsMap || typeof assetsMap !== 'object') throw new Error("assetsMap inválido");
            if (!Array.isArray(allClips) || allClips.length === 0) throw new Error("Nenhum clipe fornecido");

            // 2. Carregar Assets no VFS
            let inputCommands = [];
            let assetFileMap = {};
            let inputIndex = 0;
            const probeList = []; 

            for (const assetId in assetsMap) {
                const assetBlob = assetsMap[assetId];
                if (!assetBlob) continue;

                // Importante: Detectar se é mp4 ou webm na entrada para a extensão correta
                const inExt = assetBlob.type.includes('mp4') ? 'mp4' : 'webm';
                const inputVFSName = `input_${assetId}.${inExt}`;
                
                await this.ffmpeg.writeFile(inputVFSName, await fetchFile(assetBlob));
                filesToClean.push(inputVFSName);
                inputFiles.push(inputVFSName);
                
                assetFileMap[assetId] = { name: inputVFSName, index: inputIndex };
                inputCommands.push("-i", inputVFSName);
                probeList.push("-i", inputVFSName);
                inputIndex++;
            }

            if (inputIndex === 0) throw new Error("Nenhum asset válido foi carregado");

            const inputsWithAudio = new Set();
            console.log("[FFmpeg] Sondando streams de áudio...");
            
            let currentProbeIndex = -1;
            const probeLogHandler = (log) => {
                const msg = log.message || log;
                if (typeof msg !== 'string') return;
                
                // Detecta Input #N
                const inputMatch = msg.match(/Input #(\d+),/);
                if (inputMatch) currentProbeIndex = parseInt(inputMatch[1]);
                
                // Detecta Stream Audio no Input atual
                if (currentProbeIndex >= 0 && msg.match(/Stream #\d+:\d+.*Audio:/)) {
                    inputsWithAudio.add(currentProbeIndex);
                }
            };

            this.ffmpeg.on("log", probeLogHandler);
            try { await this.ffmpeg.exec(probeList); } catch (e) { /* Ignora erro de output missing */ }
            this.ffmpeg.off("log", probeLogHandler);
            
            console.log("[FFmpeg] Inputs com áudio:", Array.from(inputsWithAudio));
            // -----------------------------------------------------

            // 4. Montar Filter Complex
            let filterComplex = "";
            let audioClips = allClips.filter((c) => c && (c.trackType === "audio" || (c.trackType === "video" && !c.muted)));
            let videoClips = allClips.filter((c) => c && c.trackType === "video");
            let audioStreamsToMix = [];
            let videoStreamsToMerge = [];

            // A. Streams de Áudio (Com verificação de existência)
            audioClips.forEach((clip) => {
                if (!clip || !clip.assetId) return;
                const map = assetFileMap[clip.assetId];
                if (!map) return;

                // SÓ PROCESSA SE TIVER ÁUDIO
                if (!inputsWithAudio.has(map.index)) {
                    if (clip.trackType === 'audio') console.warn(`Asset ${clip.assetId} não tem áudio.`);
                    return; 
                }

                const finalLabel = `a_clip_${clip.id}`;
                const offset = clip.offset || 0;
                const duration = clip.duration || 1;
                const level = clip.level ?? 1;

                let filterChain = `[${map.index}:a]atrim=start=${round(offset)}:duration=${round(duration)},asetpts=N/SR/TB,volume=${level}`;
                if (clip.start > 0) {
                    const delayMs = Math.round(clip.start * 1000);
                    filterChain += `,adelay=${delayMs}|${delayMs}`;
                }
                filterComplex += filterChain + `[${finalLabel}];`;
                audioStreamsToMix.push(finalLabel);
            });

            // B. Streams de Vídeo
            videoClips.forEach((clip) => {
                if (!clip || !clip.assetId) return;
                const map = assetFileMap[clip.assetId];
                if (!map) return;

                const finalLabel = `v_clip_${clip.id}`;
                const offset = clip.offset || 0;
                const duration = clip.duration || 1;
                const start = clip.start || 0;

                let filterChain = `[${map.index}:v]trim=start=${round(offset)}:duration=${round(duration)},setpts=PTS-STARTPTS`;
                filterChain += `,scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`;
                filterChain += `,fps=${TARGET_FPS}`;

                if (start > 0) filterChain += `,tpad=start=${round(start)}:color=black`;
                filterComplex += filterChain + `[${finalLabel}];`;
                videoStreamsToMerge.push(finalLabel);
            });

            // C. Mix Final
            if (audioStreamsToMix.length > 0) {
                filterComplex += `${audioStreamsToMix.map(l => `[${l}]`).join("")}amix=inputs=${audioStreamsToMix.length}:duration=longest[mixed_audio];`;
            } else {
                // Silêncio
                filterComplex += `anullsrc=channel_layout=stereo:sample_rate=44100[mixed_audio];`;
            }

            if (videoStreamsToMerge.length === 0) throw new Error("Sem vídeo.");

            filterComplex += `${videoStreamsToMerge.map(l => `[${l}]`).join("")}concat=n=${videoStreamsToMerge.length}:v=1:a=0[mixed_video]`;

            // 5. Execução de Codificação (WebM vs MP4)
            let encodeCommand = [...inputCommands];
            encodeCommand.push("-filter_complex", filterComplex);
            encodeCommand.push("-map", "[mixed_video]");
            encodeCommand.push("-map", "[mixed_audio]");

            if (isMp4) {
                // Configuração H.264 (MP4)
                encodeCommand.push(
                    "-c:v", "libx264",
                    "-c:a", "aac",
                    "-preset", quality.preset === 'ultrafast' ? 'ultrafast' : 'veryfast',
                    "-b:a", quality.audioBitrate || "128k",
                    "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart"
                );
                if(quality.bitrate) encodeCommand.push("-b:v", quality.bitrate);
                else encodeCommand.push("-crf", String(quality.crf));
            } else {
                // Configuração VP8 (WebM)
                encodeCommand.push(
                    "-c:v", "libvpx",
                    "-deadline", "realtime",
                    "-cpu-used", "8",
                    "-c:a", "libvorbis",
                    "-b:a", quality.audioBitrate || "128k"
                );
                if(quality.bitrate) encodeCommand.push("-b:v", quality.bitrate);
                else encodeCommand.push("-crf", "30", "-b:v", "1M"); 
            }

            encodeCommand.push("-t", totalDuration.toString());
            encodeCommand.push(intermediateName);

            this.ffmpeg.on("log", progressHandler);
            console.log("[FFmpeg ENCODE]:", encodeCommand.join(" "));

            await this.ffmpeg.exec(encodeCommand);

            // 6. REMUX (Se necessário, ou apenas leitura final)
            // Para simplificar e evitar erros de cópia em wasm, lemos diretamente se possível, 
            // mas o remux garante metadados limpos.
            this.ffmpeg.off("log", progressHandler);
            safeProgress(1.0, 'Finalizando...');

            const remuxCommand = [
                '-i', intermediateName,
                '-c', 'copy',
                '-max_interleave_delta', '0',
                finalOutputName
            ];

            await this.ffmpeg.exec(remuxCommand);

            // 7. Retorno
            const data = await this.ffmpeg.readFile(finalOutputName);
            const mimeType = `video/${outputFormat}`;
            const resultBlob = new Blob([data.buffer], { type: mimeType });

            return URL.createObjectURL(resultBlob);

        } catch (error) {
            console.error("Erro FFmpeg durante Mixagem:", error);
            throw new Error(`Mixagem falhou: ${error.message || String(error)}`);
        } finally {
            for (const file of filesToClean) try { await this.ffmpeg.deleteFile(file); } catch (e) { }
            for (const file of inputFiles) try { await this.ffmpeg.deleteFile(file); } catch (e) { }
        }
    }
}
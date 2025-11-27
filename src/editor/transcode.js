/**
 * TranscodeService
 * Wrapper para a biblioteca FFmpeg.wasm.
 * Responsável por inicializar o núcleo do FFmpeg, gerenciar o carregamento dos módulos WASM/Core
 * e executar comandos de processamento de vídeo (corte, conversão, fusão).
 * 
 */

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

    /**
     * Inicializa a instância do FFmpeg e carrega os arquivos necessários.
     */
    async init() {
        if (this.isLoaded) return;

        const scope = window.FFmpegWASM || window.FFmpeg;
        if (!scope) throw new Error("Biblioteca FFmpeg não encontrada.");

        const { FFmpeg } = scope;
        this.ffmpeg = new FFmpeg();

        // Logs básicos globais (cuidado para não re-registrar demais)
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
     * @param {Blob} fileBlob - Arquivo original
     * @param {string} fileName - Nome identificador
     * @param {number} startTime - Início do corte
     * @param {number} duration - Duração
     * @param {string} format - 'webm', 'mp4', 'gif'
     * @param {object} options - Opções extras como { opacity: 0.5 }
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
            console.log("Executando FFmpeg:", command.join(" "));
            
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

        // Detecta se o arquivo deve ser lido como animação
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

            // 2. ENCODING (Configurações de qualidade baseada em options)
            const isProxy = options.isProxy || false;

            command.push(
                "-r", "25", // Taxa de quadros fixa
                "-g", "1", // Keyframe a cada quadro (garante seeking)
                "-crf", isProxy ? "30" : "10",
                "-b:v", isProxy ? "500k" : "0",
                "-an", // Sem stream de áudio
                "-c:v", "libvpx",
                "-pix_fmt", "yuv420p",

                // Filtros de Escala e Padding
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
     * @param {Blob[]} segments - Array de blobs de vídeo
     * @param {string} outputName - Nome do arquivo de saída
     * @returns {string} - URL do vídeo mesclado
     */
    async mergeSegments(segments, outputName = "merged") {
        if (!this.isLoaded) await this.init();

        if (!segments || segments.length === 0) {
            throw new Error("Nenhum segmento fornecido para mesclar");
        }

        if (segments.length === 1) {
            // Se houver apenas um segmento, retorna diretamente
            return URL.createObjectURL(segments[0]);
        }

        const fetchFile = this._getFetchFile();
        const filesToClean = [];

        try {
            // 1. Escrever todos os segmentos no sistema de arquivos virtual
            const inputFiles = [];
            for (let i = 0; i < segments.length; i++) {
                const segmentName = `segment_${i}.webm`;
                await this.ffmpeg.writeFile(segmentName, await fetchFile(segments[i]));
                inputFiles.push(segmentName);
                filesToClean.push(segmentName);
            }

            // 2. Criar arquivo de lista de concatenação
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

            // 4. Ler o arquivo mesclado
            const data = await this.ffmpeg.readFile(outputFileName);
            const blob = new Blob([data.buffer], { type: "video/webm" });

            return URL.createObjectURL(blob);

        } catch (error) {
            console.error("Erro ao mesclar segmentos:", error);
            throw new Error(`Falha ao mesclar segmentos: ${error.message || String(error)}`);
        } finally {
            // Limpar arquivos temporários
            for (const file of filesToClean) {
                try {
                    await this.ffmpeg.deleteFile(file);
                } catch (e) {
                    // Ignora erros de limpeza
                }
            }
        }
    }

    /**
     * Faz a mixagem do projeto completo (timeline → vídeo final)
     */
    async mixProject(allClips, assetsMap, totalDuration, progressCallback, options = {}) {
        if (!this.isLoaded) await this.init();

        const fetchFile = this._getFetchFile();
        const outputFormat = "mp4";

        const intermediateName = `intermediate_mix.${outputFormat}`;
        const finalOutputName = `final_mix_output.${outputFormat}`;
        const filesToClean = [intermediateName, finalOutputName];
        const inputFiles = []; 

        const qualityPresets = {
            veryslow: { 
                preset: "veryslow",
                crf: 15,
                bitrate: null,
                audioBitrate: "320k"
            },
            high: {
                preset: "veryslow",
                crf: 15,
                bitrate: null,
                audioBitrate: "320k"
            },
            medium: {
                preset: "medium",
                crf: 20,
                bitrate: null,
                audioBitrate: "192k"
            },
            low: {
                preset: "fast",
                crf: 25,
                bitrate: "2000k",
                audioBitrate: "128k"
            },
            proxy: {
                preset: "ultrafast",
                crf: 30,
                bitrate: "500k",
                audioBitrate: "64k"
            }
        };

        // Validação e fallback para medium
        const qualityKey = options.quality || 'medium';
        const quality = qualityPresets[qualityKey];

        if (!quality) {
            console.warn(`[FFmpeg] Preset '${qualityKey}' não encontrado, usando 'medium'`);
            quality = qualityPresets.medium;
        }

        console.log(`[FFmpeg MixProject] Qualidade selecionada: '${qualityKey}'`, quality);

        // Configurações de estabilidade e resolução
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

        // Progress handler robusto para evitar TypeError em worker crash
        const progressHandler = (evt) => {
            const message = typeof evt === "string" ? evt : evt && evt.message;

            if (typeof message === "string" && message.indexOf("frame=") === 0) {
                const timeMatch = message.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                const speedMatch = message.match(/speed=([\d\.]+)x/);

                if (timeMatch && totalDuration > 0) {
                    const timeStr = timeMatch[1];
                    const match = timeStr.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                    if (!match) return;

                    const [, h, m, s, cs] = match.map(Number);
                    const currentTime = h * 3600 + m * 60 + s + cs / 100;

                    const ratio = Math.min(1, currentTime / totalDuration);
                    const speed = speedMatch ? speedMatch[1] : "N/A";

                    try {
                        safeProgress(ratio, speed);
                    } catch (e) {
                        console.warn("Erro no progressCallback (mixProject):", e);
                    }
                }
            }
        };

        try {
            // Validações iniciais
            if (!assetsMap || typeof assetsMap !== 'object') {
                throw new Error("assetsMap inválido ou não fornecido");
            }

            if (!Array.isArray(allClips) || allClips.length === 0) {
                throw new Error("Nenhum clipe fornecido para mixagem");
            }

            // 1. Escrever assets (usa originais se options.useOriginals === true)
            let inputCommands = [];
            let assetFileMap = {};
            let inputIndex = 0;

            for (const assetId in assetsMap) {
                const assetBlob = assetsMap[assetId];

                if (!assetBlob) {
                    console.warn(`Asset ${assetId} é null/undefined, pulando...`);
                    continue;
                }

                const inputVFSName = `input_${assetId}.${outputFormat}`;
                await this.ffmpeg.writeFile(inputVFSName, await fetchFile(assetBlob));
                filesToClean.push(inputVFSName);
                inputFiles.push(inputVFSName);
                assetFileMap[assetId] = { name: inputVFSName, index: inputIndex };
                inputCommands.push("-i", inputVFSName);
                inputIndex++;
            }

            if (inputIndex === 0) {
                throw new Error("Nenhum asset válido foi carregado");
            }

            // 2. Monta o Filter Complex
            let filterComplex = "";
            let audioClips = allClips.filter((c) => c && (c.trackType === "audio" || (c.trackType === "video" && !c.muted)));
            let videoClips = allClips.filter((c) => c && c.trackType === "video");
            let audioStreamsToMix = [];
            let videoStreamsToMerge = [];

            if (videoClips.length === 0) {
                throw new Error("Pelo menos um clipe de vídeo é necessário.");
            }

            // A. Streams de Áudio
            audioClips.forEach((clip) => {
                if (!clip || !clip.assetId) {
                    console.warn("Clipe de áudio inválido, pulando...", clip);
                    return;
                }

                const map = assetFileMap[clip.assetId];
                if (!map) {
                    console.warn(`Asset ${clip.assetId} não encontrado no mapa, pulando...`);
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
                if (!clip || !clip.assetId) {
                    console.warn("Clipe de vídeo inválido, pulando...", clip);
                    return;
                }

                const map = assetFileMap[clip.assetId];
                if (!map) {
                    console.warn(`Asset ${clip.assetId} não encontrado no mapa, pulando...`);
                    return;
                }

                const finalLabel = `v_clip_${clip.id}`;
                const offset = clip.offset || 0;
                const duration = clip.duration || 1;
                const start = clip.start || 0;

                // 1. TRIM, SETPTS
                let filterChain = `[${map.index}:v]trim=start=${round(offset)}:duration=${round(duration)},setpts=PTS-STARTPTS`;

                filterChain += `,scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`;
                filterChain += `,fps=${TARGET_FPS}`;

                if (start > 0) {
                    filterChain += `,tpad=start=${round(start)}:color=black`;
                }

                filterComplex += filterChain + `[${finalLabel}];`;
                videoStreamsToMerge.push(finalLabel);
            });

            // C. Mix Final
            if (audioStreamsToMix.length > 0) {
                const amixInput = audioStreamsToMix.map((l) => `[${l}]`).join("");
                filterComplex += amixInput + `amix=inputs=${audioStreamsToMix.length}:duration=longest[mixed_audio];`;
            } else {
                filterComplex += `anullsrc[mixed_audio];`;
            }

            if (videoStreamsToMerge.length === 0) {
                throw new Error("Nenhum clipe de vídeo válido encontrado após processamento.");
            }

            const vconcatInput = videoStreamsToMerge.map((l) => `[${l}]`).join("");
            filterComplex += vconcatInput + `concat=n=${videoStreamsToMerge.length}:v=1:a=0[mixed_video]`;

            console.log("[FFmpeg] Filter Complex gerado:", filterComplex);

            // 3. Execução de Codificação COM PRESET DE QUALIDADE
            let encodeCommand = [...inputCommands];
            encodeCommand.push("-filter_complex", filterComplex);
            encodeCommand.push("-map", "[mixed_video]");
            encodeCommand.push("-map", "[mixed_audio]");

            if (quality.bitrate && quality.bitrate !== null && quality.bitrate !== "") {
                encodeCommand.push("-b:v", quality.bitrate);
            }

            encodeCommand.push(
                "-c:v", "libx264",
                "-c:a", "aac",
                "-preset", quality.preset,
                "-crf", String(quality.crf),
                "-b:a", quality.audioBitrate,
                "-level", "4.0",
                "-profile:v", "main",
                "-async", "1",
                "-r", String(TARGET_FPS),
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                "-t", totalDuration.toString(),
                intermediateName
            );

            this.ffmpeg.on("log", progressHandler);
            console.log("[FFmpeg ENCODE]:", encodeCommand.join(" "));
            console.log(`[FFmpeg] Renderizando com qualidade: ${options.quality || 'medium'}`);

            await this.ffmpeg.exec(encodeCommand);

            // 4. REMUX
            this.ffmpeg.off("log", progressHandler);
            safeProgress(1.0, 'Finalizando...');

            const remuxCommand = [
                '-i', intermediateName,
                '-c', 'copy',
                '-max_interleave_delta', '0',
                finalOutputName
            ];

            console.log("[FFmpeg REMUX]:", remuxCommand.join(" "));
            await this.ffmpeg.exec(remuxCommand);

            // 5. Leitura do Arquivo FINAL
            const data = await this.ffmpeg.readFile(finalOutputName);
            const mimeType = `video/${outputFormat}`;
            const resultBlob = new Blob([data.buffer], { type: mimeType });

            return URL.createObjectURL(resultBlob);

        } catch (error) {
            console.error("Erro FFmpeg durante Mixagem:", error);
            throw new Error(`Mixagem falhou: ${error.message || String(error)}`);
        } finally {
            // 6. Limpeza de TODOS os arquivos
            for (const file of filesToClean) {
                try { await this.ffmpeg.deleteFile(file); } catch (e) { }
            }
            for (const file of inputFiles) {
                try { await this.ffmpeg.deleteFile(file); } catch (e) { }
            }
        }
    }
}
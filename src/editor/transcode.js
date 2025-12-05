/**
 * TranscodeService
 * Wrapper para a biblioteca FFmpeg.wasm.
 * Responsável por inicializar o núcleo do FFmpeg e executar comandos de processamento.
 * */

const round = (num, precision = 3) => parseFloat(num.toFixed(precision));

export class TranscodeService {
    constructor() {
        this.ffmpeg = null;
        this.isLoaded = false;

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

    async createProxy(fileBlob, options = {}) {
        if (!this.isLoaded) await this.init();
        const fetchFile = this._getFetchFile();

        const ext = (fileBlob.type && fileBlob.type.includes('image')) ? 'png' : 'webm';
        const inputName = `proxy_in_${Date.now()}.${ext}`;
        const outputName = `proxy_out_${Date.now()}.webm`;

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            const command = [];
            if(fileBlob.type.includes('image')) command.push("-loop", "1");
            
            command.push("-i", inputName);
            command.push(
                "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8",
                "-crf", options.crf || "30", "-b:v", "500k",
                "-c:a", "libvorbis", "-b:a", "64k",
                // Força SAR 1 para evitar problemas futuros
                "-vf", `scale=${options.scale || '640:-1'},setsar=1`,
                "-t", "5"
            );
            
            command.push(outputName);

            await this.ffmpeg.exec(command);
            const data = await this.ffmpeg.readFile(outputName);
            return new Blob([data.buffer], { type: "video/webm" });

        } catch (error) {
            console.error("Erro createProxy:", error);
            throw error;
        } finally {
            try { await this.ffmpeg.deleteFile(inputName); } catch (e) { }
            try { await this.ffmpeg.deleteFile(outputName); } catch (e) { }
        }
    }

    async cancelJob() {
        if (this.ffmpeg) {
            try { await this.ffmpeg.terminate(); } catch (e) {}
            this.ffmpeg = null;
            this.isLoaded = false;
        }
    }

    async processVideo(fileBlob, fileName, startTime, duration, format = 'webm', options = {}) {
        if (!this.isLoaded) await this.init();

        const { fetchFile } = window.FFmpegUtil;

        const type = fileBlob.type || '';
        const isImage = type.startsWith('image');
        
        let ext = 'webm';
        if (type.includes('mp4')) ext = 'mp4';
        else if (type.includes('jpeg') || type.includes('jpg')) ext = 'jpg';
        else if (type.includes('png')) ext = 'png';
        else if (type.includes('gif')) ext = 'gif';

        const safeId = Date.now() + "_" + Math.floor(Math.random()*1000);
        const inputName = `proc_in_${safeId}.${ext}`;
        const outputName = `proc_out_${safeId}.${format}`;

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            let command = [];

            if (isImage && format !== 'gif') {
                command.push("-loop", "1");
            }

            command.push("-i", inputName);

            if (!isImage) {
                command.push("-ss", startTime.toString());
            }
            command.push("-t", duration.toString());

            let videoFilters = [];

            if (options.opacity !== undefined && options.opacity < 1 && format !== 'gif') {
                console.log(`[Transcoder] Opacidade: ${options.opacity}`);
                videoFilters.push("format=yuva420p"); 
                const alphaVal = Math.floor(options.opacity * 255);
                videoFilters.push(`lutyuv=a=${alphaVal}`);
            }

            videoFilters.push("setsar=1");

            if (format === 'gif') {
                command.push("-vf", "fps=10,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", "-f", "gif");
            } else if (format === 'mp4') {
                if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));
                command.push("-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart");
            } else {
                if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));
                command.push("-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libvorbis");
                if (options.opacity < 1) command.push("-auto-alt-ref", "0");
            }

            command.push(outputName);
            
            await this.ffmpeg.exec(command);

            const data = await this.ffmpeg.readFile(outputName);
            let mimeType = format === 'mp4' ? "video/mp4" : (format === 'gif' ? "image/gif" : "video/webm");
            return URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));

        } catch (error) {
            console.error("Erro processVideo:", error);
            throw error;
        } finally {
            try { await this.ffmpeg.deleteFile(inputName); } catch (e) {}
            try { await this.ffmpeg.deleteFile(outputName); } catch (e) {}
        }
    }

    async imageToVideo(fileBlob, durationSeconds = 5, options = {}) {
        return this.processVideo(fileBlob, "img2vid", 0, durationSeconds, 'webm', options);
    }

    async mergeSegments(segments, outputName = "merged") {
        if (!this.isLoaded) await this.init();
        if (!segments || segments.length === 0) throw new Error("Sem segmentos");
        const fetchFile = this._getFetchFile();
        
        try {
            const inputFiles = [];
            for (let i = 0; i < segments.length; i++) {
                const name = `seg_${i}_${Date.now()}.webm`;
                await this.ffmpeg.writeFile(name, await fetchFile(segments[i]));
                inputFiles.push(name);
            }
            const listName = `list_${Date.now()}.txt`;
            const content = inputFiles.map(f => `file '${f}'`).join('\n');
            await this.ffmpeg.writeFile(listName, new TextEncoder().encode(content));
            
            const outName = `merged_${Date.now()}.webm`;
            await this.ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", listName, "-c", "copy", outName]);
            
            const data = await this.ffmpeg.readFile(outName);
            
            try { await this.ffmpeg.deleteFile(listName); } catch(e){}
            for(const f of inputFiles) try { await this.ffmpeg.deleteFile(f); } catch(e){}
            try { await this.ffmpeg.deleteFile(outName); } catch(e){}

            return URL.createObjectURL(new Blob([data.buffer], { type: "video/webm" }));
        } catch (e) {
            throw e;
        }
    }

    /**
     * Faz a mixagem do projeto completo.
     */
    async mixProject(allClips, assetsMap, totalDuration, progressCallback, options = {}) {
        if (!this.isLoaded) await this.init();

        const fetchFile = this._getFetchFile();
        const reqFormat = options.format || 'mp4';
        const isMp4 = reqFormat === 'mp4';
        const outputFormat = isMp4 ? 'mp4' : 'webm';

        const intermediateName = `intermediate_mix.${outputFormat}`;
        const finalOutputName = `final_mix_output.${outputFormat}`;
        const filesToClean = [intermediateName, finalOutputName];
        const inputFiles = []; 

        const qualityPresets = {
            veryslow: { 
                preset: "medium", crf: 22, 
                webmDeadline: "good", webmCpu: 2, webmCrf: 10 
            },
            high: { 
                preset: "fast", crf: 24, 
                webmDeadline: "realtime", webmCpu: 4, webmCrf: 20 
            },
            medium: { 
                preset: "superfast", crf: 27, 
                webmDeadline: "realtime", webmCpu: 6, webmCrf: 25 
            },
            low: { 
                preset: "ultrafast", crf: 30, 
                webmDeadline: "realtime", webmCpu: 8, webmCrf: 35 
            },
            proxy: { 
                preset: "ultrafast", crf: 35, 
                webmDeadline: "realtime", webmCpu: 8, webmCrf: 45 
            }
        };

        const qualityKey = options.quality || 'medium';
        let qConfig = qualityPresets[qualityKey] || qualityPresets.medium;

        const resolutionPresets = {
            high: { w: '1920', h: '1080' },
            medium: { w: '1280', h: '720' },
            low: { w: '640', h: '480' },
            proxy: { w: '640', h: '360' }
        };

        let targetW, targetH;
        if (options.width && options.height) {
            targetW = options.width;
            targetH = options.height;
        } else {
            const res = resolutionPresets[options.quality] || resolutionPresets.medium;
            targetW = res.w;
            targetH = res.h;
        }
        
        // Garante que sejam strings para o comando do FFmpeg
        targetW = String(targetW);
        targetH = String(targetH);

        const safeProgress = typeof progressCallback === "function" ? progressCallback : () => { };
        
        const progressHandler = (evt) => {
            const message = typeof evt === "string" ? evt : evt && evt.message;
            if (typeof message === "string" && message.indexOf("frame=") === 0) {
                const timeMatch = message.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                const speedMatch = message.match(/speed=\s*([0-9\.]+)x/);
                if (timeMatch && totalDuration > 0) {
                    const [, h, m, s, cs] = timeMatch[1].match(/(\d{2}):(\d{2}):(\d{2})\.(\d{2})/).map(Number);
                    const currentTime = h * 3600 + m * 60 + s + cs / 100;
                    const speed = speedMatch ? speedMatch[1] : "N/A";
                    try { safeProgress(Math.min(1, currentTime / totalDuration), speed); } catch (e) {}
                }
            }
        };

        try {
            if (!assetsMap) throw new Error("assetsMap inválido");

            const videoClips = [];
            const imageClips = [];
            const audioClips = [];

            allClips.forEach(c => {
                const asset = assetsMap[c.assetId];
                if (!asset) return;
                const isAudio = c.trackType === 'audio' || asset.type.startsWith('audio');
                const isImage = asset.type.startsWith('image');
                if (isAudio) audioClips.push(c);
                else if (isImage) imageClips.push(c);
                else videoClips.push(c);
            });

            imageClips.sort((a,b) => a.start - b.start);

            let inputCommands = [];
            let assetFileMap = {}; 
            let inputIndex = 0;

            const uniqueAssetIds = [...new Set(allClips.map(c => c.assetId))];

            for (const assetId of uniqueAssetIds) {
                const assetBlob = assetsMap[assetId];
                if (!assetBlob) continue;

                let ext = 'webm';
                if (assetBlob.type.includes('png')) ext = 'png';
                else if (assetBlob.type.includes('jpeg') || assetBlob.type.includes('jpg')) ext = 'jpg';
                else if (assetBlob.type.includes('mp4')) ext = 'mp4';
                else if (assetBlob.type.includes('gif')) ext = 'gif';

                const inputVFSName = `in_${assetId}.${ext}`;
                try { await this.ffmpeg.readFile(inputVFSName); } 
                catch { 
                    await this.ffmpeg.writeFile(inputVFSName, await fetchFile(assetBlob));
                    filesToClean.push(inputVFSName);
                }
                
                const isImage = assetBlob.type.startsWith('image');
                
                assetFileMap[assetId] = { 
                    index: inputIndex, 
                    type: isImage ? 'image' : 'video'
                };
                
                if (isImage) {
                    inputCommands.push(
                        "-loop", "1", 
                        "-framerate", "30", 
                        "-t", totalDuration.toString(), 
                        "-i", inputVFSName
                    );
                } else {
                    inputCommands.push("-i", inputVFSName);
                }
                inputIndex++;
            }

            const filterChains = [];
            let videoStreamsToConcat = [];
            
            // BASE DE VÍDEO
            if (videoClips.length === 0) {
                filterChains.push(`color=c=black:s=${targetW}x=${targetH}:d=${totalDuration}[base_video]`);
            } else {
                videoClips.forEach((clip) => {
                    const map = assetFileMap[clip.assetId];
                    if (!map) return;
                    const label = `v_seg_${clip.id}`;
                    const opacity = clip.level !== undefined ? clip.level : 1;
                    
                    let chain = `[${map.index}:v]trim=start=${round(clip.offset)}:duration=${round(clip.duration)},setpts=PTS-STARTPTS`;
                    
                    chain += `,scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`;
                    
                    chain += `,format=yuva420p,setsar=1`;

                    if (opacity < 1) {
                        const alphaVal = Math.floor(opacity * 255);
                        chain += `,lutyuv=a=${alphaVal}`;
                    }
                    
                    if (videoStreamsToConcat.length === 0 && clip.start > 0) {
                        chain += `,tpad=start=${round(clip.start)}:color=black`;
                    }
                    
                    filterChains.push(`${chain}[${label}]`);
                    videoStreamsToConcat.push(label);
                });
                
                if (videoStreamsToConcat.length > 0) {
                    const concatInputs = videoStreamsToConcat.map(l => `[${l}]`).join("");
                    
                    filterChains.push(`${concatInputs}concat=n=${videoStreamsToConcat.length}:v=1:a=0[base_video_raw]`);
                    filterChains.push(`[base_video_raw]fps=30[base_video]`);
                }
            }

            // OVERLAYS
            let lastBaseLabel = "[base_video]";

            imageClips.forEach((clip, i) => {
                const map = assetFileMap[clip.assetId];
                if (!map) return;
                
                const imgLabel = `img_${i}`;
                const overlayOutLabel = `vid_over_${i}`;
                const opacity = clip.level !== undefined ? clip.level : 1;
                const startT = round(clip.start);
                const endT = round(clip.start + clip.duration);
                
                let imgChain = `[${map.index}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,format=yuva420p,setsar=1`;
                
                if (opacity < 1) {
                    const alphaVal = Math.floor(opacity * 255);
                    imgChain += `,lutyuv=a=${alphaVal}`;
                }
                
                filterChains.push(`${imgChain}[${imgLabel}]`);
                
                filterChains.push(`${lastBaseLabel}[${imgLabel}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${startT},${endT})':eof_action=pass:shortest=1[${overlayOutLabel}]`);
                
                lastBaseLabel = `[${overlayOutLabel}]`;
            });

            filterChains.push(`${lastBaseLabel}null[mixed_video]`);

            // AUDIO
            let audioStreams = [];
            audioClips.forEach(clip => {
                let index = assetFileMap[clip.assetId] ? assetFileMap[clip.assetId].index : -1;
                if(index !== -1) {
                     const aLabel = `a_${clip.id}`;
                     const vol = clip.level !== undefined ? clip.level : 1;
                     
                     let aChain = `[${index}:a]atrim=start=${clip.offset}:duration=${clip.duration},asetpts=PTS-STARTPTS,volume=${vol}`;
                     if (clip.start > 0) {
                        const delayMs = Math.round(clip.start * 1000);
                        aChain += `,adelay=${delayMs}|${delayMs}`;
                     }
                     filterChains.push(`${aChain}[${aLabel}]`);
                     audioStreams.push(aLabel);
                }
            });
            
            if (audioStreams.length > 0) {
                const amixInputs = audioStreams.map(l=>`[${l}]`).join('');
                filterChains.push(`${amixInputs}amix=inputs=${audioStreams.length}[mixed_audio]`);
            } else {
                filterChains.push(`anullsrc=channel_layout=stereo:sample_rate=44100[mixed_audio]`);
            }

            const filterComplex = filterChains.join(';');

            let encodeCommand = [...inputCommands];
            encodeCommand.push("-filter_complex", filterComplex);
            encodeCommand.push("-map", "[mixed_video]");
            encodeCommand.push("-map", "[mixed_audio]");

            if (isMp4) {
                 encodeCommand.push("-c:v", "libx264");
                 encodeCommand.push("-threads", "1"); 
                 encodeCommand.push("-preset", qConfig.preset || "ultrafast"); 
                 encodeCommand.push("-bf", "0"); 
                 encodeCommand.push("-pix_fmt", "yuv420p");
                 encodeCommand.push("-c:a", "aac");
                 
                 if(qConfig.bitrate) encodeCommand.push("-b:v", qConfig.bitrate);
                 else encodeCommand.push("-crf", String(qConfig.crf));
            } else {
                 encodeCommand.push("-c:v", "libvpx");
                 encodeCommand.push("-deadline", qConfig.webmDeadline || "realtime"); 
                 encodeCommand.push("-cpu-used", String(qConfig.webmCpu)); 
                 
                 encodeCommand.push("-c:a", "libvorbis");
                 encodeCommand.push("-auto-alt-ref", "0"); 
                 
                 if(qConfig.bitrate) encodeCommand.push("-b:v", qConfig.bitrate);
                 else encodeCommand.push("-crf", String(qConfig.webmCrf), "-b:v", "0"); 
            }
            
            encodeCommand.push("-t", totalDuration.toString());
            encodeCommand.push(intermediateName);

            this.ffmpeg.on("log", progressHandler);
            console.log("[FFmpeg OVERLAY MIX V22]:", encodeCommand.join(" "));

            await this.ffmpeg.exec(encodeCommand);
            
            this.ffmpeg.off("log", progressHandler);
            safeProgress(1.0, 'Finalizando...');
            
            await this.ffmpeg.exec(['-i', intermediateName, '-c', 'copy', finalOutputName]);
            
            const data = await this.ffmpeg.readFile(finalOutputName);
            const mimeType = `video/${outputFormat}`;
            const resultBlob = new Blob([data.buffer], { type: mimeType });
            
            return URL.createObjectURL(resultBlob);

        } catch (error) {
            console.error("Erro Mixagem Overlay:", error);
            if (error.message && error.message.includes("No such filter")) {
                throw new Error("Erro interno de renderização (Sintaxe FFmpeg).");
            }
            throw error;
        } finally {
            for(const f of filesToClean) try { await this.ffmpeg.deleteFile(f); } catch(e){}
        }
    }
}
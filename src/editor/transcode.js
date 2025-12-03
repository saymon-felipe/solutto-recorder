/**
 * TranscodeService
 * Wrapper para a biblioteca FFmpeg.wasm.
 * Responsável por inicializar o núcleo do FFmpeg e executar comandos de processamento.
 * */

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
        
        const outputFormat = (options.format === 'mp4') ? 'mp4' : 'webm';
        const intermediateName = `inter_mix_${Date.now()}.${outputFormat}`;
        
        const filesToClean = new Set([intermediateName]);

        const qualityKey = options.quality || 'medium';
        const resPresets = {
            high: {w:1920, h:1080}, medium: {w:1280, h:720}, low: {w:640, h:480}, proxy: {w:640, h:360}
        };
        const res = resPresets[qualityKey] || resPresets.medium;

        const safeProgress = typeof progressCallback === "function" ? progressCallback : () => { };
        const progressHandler = (evt) => {
            const msg = typeof evt === "string" ? evt : evt?.message;
            if (typeof msg === "string" && msg.startsWith("frame=")) {
                const t = msg.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                if (t && totalDuration > 0) {
                    const p = t[1].split(':');
                    const sec = (+p[0])*3600 + (+p[1])*60 + parseFloat(p[2]);
                    safeProgress(Math.min(1, sec / totalDuration));
                }
            }
        };

        try {
            // 1. Inputs
            let inputCommands = [];
            let assetFileMap = {};
            let inputIndex = 0;
            const probeList = []; 

            for (const assetId in assetsMap) {
                const blob = assetsMap[assetId];
                if (!blob) continue;

                const isImg = blob.type.includes('image');
                let ext = 'webm';
                if (blob.type.includes('mp4')) ext = 'mp4';
                else if (isImg) ext = blob.type.includes('jpeg') ? 'jpg' : 'png';

                const vfsName = `src_${assetId}_${Date.now()}.${ext}`;
                await this.ffmpeg.writeFile(vfsName, await fetchFile(blob));
                filesToClean.add(vfsName);

                assetFileMap[assetId] = { name: vfsName, index: inputIndex };

                if (isImg) {
                    inputCommands.push("-loop", "1");
                    inputCommands.push("-t", (totalDuration + 5).toString());
                    inputCommands.push("-i", vfsName);
                } else {
                    inputCommands.push("-i", vfsName);
                    probeList.push("-i", vfsName);
                }
                inputIndex++;
            }

            // 2. Probe (Audio)
            const inputsWithAudio = new Set();
            if (probeList.length > 0) {
                let currIdx = -1;
                const ph = (log) => {
                    const m = log.message || log;
                    if (typeof m !== 'string') return;
                    const im = m.match(/Input #(\d+),/);
                    if (im) currIdx = parseInt(im[1]);
                    if (currIdx >= 0 && m.includes("Audio:")) inputsWithAudio.add(currIdx);
                };
                this.ffmpeg.on("log", ph);
                try { await this.ffmpeg.exec(probeList); } catch(e){}
                this.ffmpeg.off("log", ph);
            }

            // 3. Filter Complex
            let fc = "";
            let audios = [], videos = [];

            // Audio
            allClips.filter(c => c.trackType === 'audio' || (c.trackType === 'video' && !c.muted)).forEach(c => {
                const m = assetFileMap[c.assetId];
                if (!m) return;
                
                if (c.trackType === 'video' && !inputsWithAudio.has(m.index) && !c.assetId.includes('audio')) return;

                const lbl = `aud_${c.id}`;
                let chain = `[${m.index}:a]atrim=start=${c.offset}:duration=${c.duration},asetpts=N/SR/TB,volume=${c.level||1}`;
                if (c.start > 0) chain += `,adelay=${Math.round(c.start*1000)}|${Math.round(c.start*1000)}`;
                fc += chain + `[${lbl}];`;
                audios.push(lbl);
            });

            // Video
            allClips.filter(c => c.trackType === 'video').forEach(c => {
                const m = assetFileMap[c.assetId];
                if (!m) return;
                
                const lbl = `vid_${c.id}`;
                let chain = `[${m.index}:v]trim=start=${c.offset}:duration=${c.duration},setpts=PTS-STARTPTS`;
                
                if ((c.level||1) < 1) chain += `,format=yuva420p,colorchannelmixer=aa=${c.level}`;
                
                chain += `,scale=${res.w}:${res.h}:force_original_aspect_ratio=decrease,pad=${res.w}:${res.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
                chain += `,fps=30`;
                
                if (c.start > 0) chain += `,tpad=start=${c.start}:color=black:color_mode=preserve`;
                fc += chain + `[${lbl}];`;
                videos.push(lbl);
            });

            // Mix
            if (audios.length > 0) fc += `${audios.map(l=>`[${l}]`).join('')}amix=inputs=${audios.length}:duration=longest[a_out];`;
            else fc += `anullsrc=channel_layout=stereo:sample_rate=44100[a_out];`;

            if (videos.length === 0) throw new Error("Sem video");
            fc += `${videos.map(l=>`[${l}]`).join('')}concat=n=${videos.length}:v=1:a=0,format=yuv420p[v_out]`;

            // 4. Encode
            const cmd = [...inputCommands];
            cmd.push("-filter_complex", fc);
            cmd.push("-map", "[v_out]", "-map", "[a_out]");
            
            if (outputFormat === 'mp4') {
                cmd.push("-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart");
                cmd.push("-crf", "23");
            } else {
                cmd.push("-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libvorbis");
                cmd.push("-b:v", "2M");
            }
            
            cmd.push("-t", totalDuration.toString());
            cmd.push(intermediateName);

            this.ffmpeg.on("log", progressHandler);
            console.log("Mix CMD:", cmd.join(" "));
            await this.ffmpeg.exec(cmd);
            this.ffmpeg.off("log", progressHandler);

            try { await this.ffmpeg.readFile(intermediateName); } catch(e){ throw new Error("Falha no Encode final"); }

            const data = await this.ffmpeg.readFile(intermediateName);
            return URL.createObjectURL(new Blob([data.buffer], { type: `video/${outputFormat}` }));

        } catch (e) {
            console.error(e);
            throw e;
        } finally {
            for(const f of filesToClean) try { await this.ffmpeg.deleteFile(f); } catch(e){}
        }
    }
}
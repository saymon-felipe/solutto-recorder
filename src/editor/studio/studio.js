/**
 * StudioManager - NLE Avançado
 * ATUALIZADO: Fix Playhead Precision & Fader Handle (Opacity/Volume)
 */
let HEADER_WIDTH = 120;

export class StudioManager {
    constructor(editorManager) {
        this.editor = editorManager;
        this.isActive = false;
        
        this.project = {
            tracks: [
                { id: 1, type: 'video', name: 'V1 Principal', clips: [] },
                { id: 2, type: 'video', name: 'V2 Overlay', clips: [] },
                { id: 3, type: 'audio', name: 'A1 Áudio Orig.', clips: [] },
                { id: 4, type: 'audio', name: 'A2 Música/FX', clips: [] }
            ],
            assets: [],
            zoom: 20, 
            duration: 300,
            currentTime: 0
        };

        this.isPlaying = false;
        this.isScrubbing = false;
        this.tasks = []; 
        this.draggedAsset = null;
        this.selectedClip = null;
        
        this.previewVideo = null;
        this.previewAudio = null;
    }

    init() {
        this._buildUI();
        this.previewVideo = document.getElementById('studio-preview-video');
        this.previewAudio = document.getElementById('studio-audio-preview');
        this._bindGlobalEvents();
        
        setTimeout(() => {
            const h = document.querySelector('.track-header');
            if(h) HEADER_WIDTH = h.getBoundingClientRect().width;
        }, 500);
    }

    toggleMode() {
        this.isActive = !this.isActive;
        const el = document.getElementById("studio-app");
        el.style.display = this.isActive ? "flex" : "none";
        
        if (this.isActive) {
            if (this.project.assets.length === 0 && this.editor.videoBlob) {
                this.addTask("Importando gravação original...", async () => {
                    const asset = await this._createAsset(this.editor.videoBlob, "Gravação Original");
                    const assetObj = { ...asset, id: "asset_original", status: 'ready' };
                    this.project.assets.push(assetObj);
                    this.addClipToTrack(1, assetObj, 0);
                    this.addClipToTrack(3, assetObj, 0);
                    this._renderAll();
                });
            } else {
                this._renderAll();
            }
            this._updatePlayhead();
        } else {
            this.pause();
        }
    }

    // --- TASK MANAGER ---
    addTask(label, promiseFn) {
        const id = Date.now();
        this.tasks.push({ id, label });
        this._updateStatusBar();
        const execution = typeof promiseFn === 'function' ? promiseFn() : promiseFn;
        return Promise.resolve(execution)
            .catch(err => console.error(`Erro Task '${label}':`, err))
            .finally(() => {
                this.tasks = this.tasks.filter(t => t.id !== id);
                this._updateStatusBar();
            });
    }

    _updateStatusBar() {
        const bar = document.getElementById('studio-status-bar');
        const text = document.getElementById('studio-status-text');
        const btn = document.getElementById('btn-studio-render');
        if (this.tasks.length > 0) {
            bar.classList.remove('hidden');
            text.innerText = `${this.tasks[this.tasks.length - 1].label}`;
            if(btn) btn.disabled = true;
        } else {
            bar.classList.add('hidden');
            if(btn) btn.disabled = false;
        }
    }

    // --- ASSETS ---
    async importAsset(file, name = "Sem Nome") {
        const mime = file.type ? file.type.split('/')[0] : 'video';
        const assetId = "asset_" + Date.now();
        const placeholder = {
            id: assetId, name: (mime === 'image' ? "[IMG] " : "") + name,
            type: mime === 'image' ? 'video' : mime,
            blob: null, url: "", baseDuration: 5, status: 'processing'
        };
        this.project.assets.push(placeholder);
        this._renderBin();

        this.addTask(`Processando ${name}...`, async () => {
            const result = await this._createAsset(file, name, mime);
            const idx = this.project.assets.findIndex(a => a.id === assetId);
            if (idx !== -1) {
                this.project.assets[idx] = { ...result, id: assetId, status: 'ready' };
                this._renderAll();
            }
        });
    }

    async _createAsset(file, name, mimeOverride) {
        let type = 'unknown'; let blob = file; let duration = 0;
        const mime = mimeOverride || (file.type ? file.type.split('/')[0] : 'video');

        if (mime === 'image') {
            type = 'video'; name = "[IMG] " + name;
            const url = await this.editor.transcoder.imageToVideo(file, 5);
            const res = await fetch(url);
            blob = await res.blob();
            duration = 5;
        } else if (mime === 'video' || mime === 'application') {
            type = 'video'; duration = await this._getDuration(blob);
        } else if (mime === 'audio') {
            type = 'audio'; duration = await this._getDuration(blob);
        }
        if (duration < 0.1) duration = 10; 
        return { blob, name, type, baseDuration: duration, url: URL.createObjectURL(blob) };
    }

    _getDuration(blob) {
        return new Promise(resolve => {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.onloadedmetadata = () => {
                if (v.duration === Infinity || isNaN(v.duration)) {
                    v.currentTime = 1e101;
                    v.ontimeupdate = () => { v.ontimeupdate = null; resolve(v.duration); v.src = ""; };
                } else resolve(v.duration);
            };
            v.onerror = () => resolve(0);
            v.src = URL.createObjectURL(blob);
            setTimeout(() => resolve(0), 3000);
        });
    }

    // --- PLAYBACK ---
    togglePlayback() { this.isPlaying ? this.pause() : this.play(); }
    play() {
        this.isPlaying = true;
        document.getElementById('btn-play-pause').innerHTML = '<i class="fa-solid fa-pause"></i>';
        let lastTime = performance.now();
        const loop = (now) => {
            if (!this.isPlaying) return;
            const dt = (now - lastTime) / 1000; lastTime = now;
            this.project.currentTime += dt;
            if (this.project.currentTime >= this.project.duration) this.pause();
            this._updatePlayhead(); this._syncPreview();
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }
    pause() {
        this.isPlaying = false;
        document.getElementById('btn-play-pause').innerHTML = '<i class="fa-solid fa-play"></i>';
        if(this.previewVideo) this.previewVideo.pause();
        if(this.previewAudio) this.previewAudio.pause();
    }
    stop() { this.pause(); this.project.currentTime = 0; this._updatePlayhead(); this._syncPreview(); }

    _syncPreview() {
        const time = this.project.currentTime;
        let activeVideo = null;
        const track2 = this.project.tracks.find(t => t.id === 2);
        const track1 = this.project.tracks.find(t => t.id === 1);
        if (track2) activeVideo = track2.clips.find(c => time >= c.start && time < (c.start + c.duration));
        if (!activeVideo && track1) activeVideo = track1.clips.find(c => time >= c.start && time < (c.start + c.duration));
        this._syncPlayer(this.previewVideo, activeVideo, time);

        const audioTracks = this.project.tracks.filter(t => t.type === 'audio');
        let activeAudio = null;
        for (const t of audioTracks) {
            const clip = t.clips.find(c => time >= c.start && time < (c.start + c.duration));
            if (clip) { activeAudio = clip; break; }
        }
        this._syncPlayer(this.previewAudio, activeAudio, time);
        document.getElementById('studio-time-display').innerText = this._fmtTime(time);
    }

    _syncPlayer(player, clip, globalTime) {
        if (!player) return;
        if (clip) {
            const asset = this.project.assets.find(a => a.id === clip.assetId);
            if (!asset || asset.status !== 'ready') { player.style.display = 'none'; return; }

            player.style.display = 'block';
            if (player.dataset.currentClipId !== clip.id) {
                player.src = asset.url;
                player.dataset.currentClipId = clip.id;
                player.load();
            }

            // APLICA EFEITOS EM TEMPO REAL
            if (player.tagName === 'VIDEO') player.style.opacity = clip.level; // Video: Opacidade CSS
            if (player.tagName === 'AUDIO') player.volume = clip.level; // Audio: Volume

            let localTime = (globalTime - clip.start) + clip.offset;
            if (localTime > asset.baseDuration) localTime = localTime % asset.baseDuration;

            if (Math.abs(player.currentTime - localTime) > 0.3 || player.ended) player.currentTime = localTime;
            
            if (this.isPlaying && player.paused) { const p = player.play(); if(p) p.catch(e => {}); }
            else if (!this.isPlaying && !player.paused) player.pause();
        } else {
            player.style.display = 'none'; player.pause(); player.dataset.currentClipId = "";
        }
    }

    _updatePlayhead() {
        const x = HEADER_WIDTH + (this.project.currentTime * this.project.zoom);
        const el = document.getElementById('timeline-playhead');
        if(el) el.style.left = x + "px";
        if (this.isPlaying) {
            const area = document.getElementById('studio-scroll-area');
            if (x - area.scrollLeft > area.clientWidth * 0.9) area.scrollLeft = x - 150;
        }
    }

    // --- EVENTOS ---
    _bindGlobalEvents() {
        document.addEventListener('keydown', (e) => {
            if (!this.isActive) return;
            if (e.code === 'Space') { e.preventDefault(); this.togglePlayback(); }
            if (e.code === 'KeyS') this.splitClip();
            if (e.code === 'Delete') this.deleteClip();
        });

        const scrollArea = document.getElementById('studio-scroll-area');
        scrollArea.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                this.setZoom(this.project.zoom * delta);
            }
        });

        document.getElementById('studio-zoom-slider').oninput = (e) => this.setZoom(parseInt(e.target.value));

        // FIX DA AGULHA: Usa getBoundingClientRect da Régua para precisão absoluta
        const ruler = document.getElementById('timeline-ruler-container');
        if(ruler) {
            ruler.onmousedown = (e) => {
                // Ponto zero da régua (onde começam os ticks)
                const startX = document.querySelector('.ruler-ticks').getBoundingClientRect().left;
                const clickX = e.clientX;
                // Diferença = pixels na timeline (já considera scroll pq os ticks rolam)
                const diff = clickX - startX;
                
                if (diff >= 0) {
                    this.project.currentTime = diff / this.project.zoom;
                    this._updatePlayhead();
                    this._syncPreview();
                }
            };
        }

        document.getElementById("btn-studio-add").onclick = () => document.getElementById("studio-upload").click();
        document.getElementById("studio-upload").onchange = async (e) => { for(const f of e.target.files) await this.importAsset(f, f.name); };
        document.getElementById("btn-studio-render").onclick = () => this.renderProject();
        document.getElementById("btn-studio-close").onclick = () => this.toggleMode();
        document.getElementById("btn-play-pause").onclick = () => this.togglePlayback();
        document.getElementById("btn-stop").onclick = () => this.stop();
    }

    setZoom(newZoom) {
        this.project.zoom = Math.max(1, Math.min(newZoom, 600));
        this._renderAll(); this._updatePlayhead();
        document.getElementById('studio-zoom-slider').value = this.project.zoom;
    }

    // --- EDIÇÃO ---
    splitClip() {
        if (!this.selectedClip) return;
        const { clip, trackId } = this.selectedClip;
        const time = this.project.currentTime;
        if (time <= clip.start || time >= (clip.start + clip.duration)) return;
        const relativeSplit = time - clip.start;
        const oldDuration = clip.duration;
        clip.duration = relativeSplit;
        const track = this.project.tracks.find(t => t.id === trackId);
        const newClip = {
            ...clip, id: "clip_" + Date.now(), start: time, duration: oldDuration - relativeSplit, offset: clip.offset + relativeSplit
        };
        track.clips.push(newClip);
        this.selectedClip = null;
        this._renderTracks();
    }

    deleteClip() {
        if (!this.selectedClip) return;
        const { clip, trackId } = this.selectedClip;
        const track = this.project.tracks.find(t => t.id === trackId);
        track.clips = track.clips.filter(c => c.id !== clip.id);
        this.selectedClip = null;
        this._renderTracks();
    }

    addClipToTrack(trackId, asset, startTime) {
        const track = this.project.tracks.find(t => t.id === trackId);
        if (!track) return;
        if (track.type === 'video' && asset.type === 'audio') return alert("Track incorreta");
        
        const clip = {
            id: "clip_" + Date.now() + Math.random(), assetId: asset.id,
            start: startTime, offset: 0, duration: asset.baseDuration,
            type: asset.type, name: asset.name,
            level: 1.0 // OPACIDADE/VOLUME (1.0 = 100%)
        };
        track.clips.push(clip);
        this._renderTracks();
    }

    // --- RENDER UI ---
    _renderAll() { this._renderBin(); this._renderRuler(); this._renderTracks(); }

    _renderBin() {
        const list = document.getElementById("studio-bin-list");
        list.innerHTML = "";
        this.project.assets.forEach(asset => {
            const item = document.createElement("div");
            item.className = `bin-item type-${asset.type} ${asset.status==='processing'?'processing':''}`;
            item.draggable = asset.status !== 'processing';
            item.innerHTML = `<i class="fa-solid ${asset.type==='audio'?'fa-music':(asset.type==='video'?'fa-film':'fa-image')}"></i><span>${asset.name}</span>`;
            if(asset.status !== 'processing') {
                item.ondragstart = (e) => { this.draggedAsset = asset; e.dataTransfer.effectAllowed = "copy"; };
            }
            list.appendChild(item);
        });
    }

    _renderRuler() {
        const container = document.querySelector('.ruler-ticks');
        if(!container) return;
        container.innerHTML = '';
        container.style.width = (this.project.duration * this.project.zoom) + "px";
        let interval = 1;
        if(this.project.zoom < 10) interval = 10; if(this.project.zoom > 50) interval = 0.5;
        for(let t=0; t<=this.project.duration; t+=interval) {
            const pos = t * this.project.zoom;
            const tick = document.createElement('div');
            const isMajor = Math.abs(t % 1) < 0.001;
            tick.className = `tick ${isMajor?'major':'minor'}`;
            tick.style.left = pos + "px";
            if(isMajor) tick.innerText = this._fmtTime(t);
            container.appendChild(tick);
        }
    }

    _renderTracks() {
        const container = document.getElementById("studio-tracks");
        if(!container) return;
        container.innerHTML = "";
        const totalWidth = (this.project.duration * this.project.zoom) + HEADER_WIDTH + 500;
        const wrapper = document.getElementById('timeline-content-wrapper');
        if(wrapper) wrapper.style.width = totalWidth + "px";

        this.project.tracks.forEach(track => {
            const el = document.createElement("div");
            el.className = `track ${track.type}`;
            el.innerHTML = `<div class="track-header"><div class="track-name">${track.name}</div></div><div class="track-lane"></div>`;
            const lane = el.querySelector(".track-lane");
            
            lane.ondragover = (e) => { e.preventDefault(); lane.style.background = "rgba(255,255,255,0.1)"; };
            lane.ondragleave = () => { lane.style.background = ""; };
            lane.ondrop = (e) => {
                e.preventDefault(); lane.style.background = "";
                if (this.draggedAsset) {
                    const rect = lane.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const time = Math.max(0, x / this.project.zoom);
                    this.addClipToTrack(track.id, this.draggedAsset, time);
                    this.draggedAsset = null;
                }
            };

            // Scrubbing na Lane (Mesma lógica da régua)
            lane.onmousedown = (e) => {
                if(e.target === lane) {
                    this.isScrubbing = true;
                    const handle = (ev) => {
                        const rect = lane.getBoundingClientRect();
                        const x = ev.clientX - rect.left;
                        this.project.currentTime = Math.max(0, x / this.project.zoom);
                        this._updatePlayhead(); this._syncPreview();
                    };
                    handle(e);
                    const onMove = (ev) => { if(this.isScrubbing) handle(ev); };
                    const onUp = () => {
                        this.isScrubbing = false;
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                    };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                    this.selectedClip = null; this._renderTracks();
                }
            };

            track.clips.forEach(clip => {
                const clipEl = this._createClipElement(clip, track.id);
                lane.appendChild(clipEl);
            });
            container.appendChild(el);
        });
        this._updatePlayhead();
    }

    _createClipElement(clip, trackId) {
        const asset = this.project.assets.find(a => a.id === clip.assetId);
        if(!asset) return document.createElement('div');

        const el = document.createElement("div");
        el.className = `clip type-${clip.type}`;
        if (this.selectedClip && this.selectedClip.clip.id === clip.id) el.classList.add('selected');
        
        el.style.left = (clip.start * this.project.zoom) + "px";
        el.style.width = (clip.duration * this.project.zoom) + "px";
        el.innerHTML = `
            <div class="fader-handle" data-action="fader"></div>
            <div class="clip-opacity-overlay" style="opacity: ${1 - clip.level}"></div>
            <div class="clip-name">${clip.name}</div>
            <div class="resize-handle right" data-action="resize"></div>
        `;

        if (clip.duration > asset.baseDuration) {
            const loops = Math.floor(clip.duration / asset.baseDuration);
            for(let i=1; i<=loops; i++) {
                const m = document.createElement("div");
                m.className = "loop-marker";
                m.style.left = (i * asset.baseDuration * this.project.zoom) + "px";
                el.appendChild(m);
            }
        }

        el.onmousedown = (e) => {
            e.stopPropagation();
            this.selectedClip = { clip, trackId };
            this._renderTracks();
            const action = e.target.dataset.action;
            if (action === 'resize') this._startResize(e, clip, el, asset.baseDuration);
            else if (action === 'fader') this._startFader(e, clip, el);
            else this._startMove(e, clip, el);
        };
        return el;
    }

    // --- FADER LOGIC (Opacity/Volume) ---
    _startFader(e, clip, el) {
        const startY = e.clientY;
        const startLevel = clip.level;
        
        const onMove = (ev) => {
            const deltaY = ev.clientY - startY;
            // 50px de arrasto = 100% de mudança
            let change = deltaY / 50; 
            let newLevel = Math.max(0, Math.min(1, startLevel - change));
            
            clip.level = newLevel;
            
            // Atualiza visual
            const overlay = el.querySelector('.clip-opacity-overlay');
            if(overlay) overlay.style.opacity = 1 - newLevel;
            
            // Se estiver tocando, atualiza player em tempo real
            if (this.previewVideo && this.previewVideo.dataset.currentClipId === clip.id) {
                this.previewVideo.style.opacity = newLevel;
            }
        };
        const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    }

    _startResize(e, clip, el, base) {
        const startX = e.clientX; const startW = clip.duration * this.project.zoom;
        const onMove = (ev) => {
            const diff = ev.clientX - startX;
            let newW = Math.max(10, startW + diff);
            clip.duration = newW / this.project.zoom;
            this._renderTracks();
        };
        const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    }

    _startMove(e, clip, el) {
        const startX = e.clientX; const startL = clip.start * this.project.zoom;
        const onMove = (ev) => {
            const diff = ev.clientX - startX;
            let newL = Math.max(0, startL + diff);
            clip.start = newL / this.project.zoom;
            this._renderTracks();
        };
        const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    }

    async renderProject() {
        if (this.tasks.length > 0) return alert("Aguarde processamento...");
        const btn = document.getElementById("btn-studio-render");
        btn.innerHTML = "Renderizando..."; btn.disabled = true;
        try {
            const videoTracks = this.project.tracks.filter(t => t.type === 'video');
            let clips = [];
            videoTracks.forEach(t => clips.push(...t.clips));
            clips.sort((a,b) => a.start - b.start);
            if (clips.length === 0) throw new Error("Nada para renderizar");

            const blobs = [];
            for (const clip of clips) {
                const asset = this.project.assets.find(a => a.id === clip.assetId);
                if (!asset || asset.status !== 'ready') continue;
                
                // APLICA EFEITOS SE NECESSÁRIO (Opacidade < 1)
                let blobToUse = asset.blob;
                if (clip.level < 1) {
                    this.addTask("Aplicando efeitos...", async () => {
                        const url = await this.editor.transcoder.processVideo(asset.blob, "effect_" + clip.id, 0, asset.baseDuration, "webm", { opacity: clip.level });
                        const res = await fetch(url);
                        blobToUse = await res.blob();
                    });
                    // Espera tasks terminarem (simplificado para v1, idealmente await task)
                }

                const loops = Math.ceil(clip.duration / asset.baseDuration);
                for(let i=0; i<loops; i++) blobs.push(blobToUse);
            }

            const url = await this.editor.transcoder.mergeSegments(blobs, "final");
            const res = await fetch(url);
            this.editor.videoBlob = await res.blob();
            await this.editor._loadVideo(url);
            this.toggleMode();
        } catch(e) { alert(e.message||e); } finally { btn.innerHTML = "Renderizar"; btn.disabled = false; }
    }

    _fmtTime(s) {
        const m = Math.floor(s / 60); const sec = Math.floor(s % 60); const ms = Math.floor((s % 1) * 10);
        return `${m}:${String(sec).padStart(2,'0')}.${ms}`;
    }

    _buildUI() {
        const div = document.createElement("div");
        div.id = "studio-app";
        div.innerHTML = `
            <div class="studio-toolbar">
                <div style="font-weight:bold;">Solutto Studio</div>
                <div class="zoom-control"><i class="fa-solid fa-minus"></i><input type="range" id="studio-zoom-slider" min="5" max="600" value="20"><i class="fa-solid fa-plus"></i></div>
                <div style="flex:1"></div>
                <button class="studio-btn" id="btn-studio-add"><i class="fa-solid fa-plus"></i> Add</button>
                <button class="studio-btn primary" id="btn-studio-render"><i class="fa-solid fa-file-export"></i> Renderizar</button>
                <button class="studio-btn" id="btn-studio-close"><i class="fa-solid fa-times"></i></button>
            </div>
            <div class="studio-workspace">
                <div class="studio-bin"><div class="bin-header">Mídia</div><div class="bin-content" id="studio-bin-list"></div></div>
                <div class="preview-container">
                    <div class="studio-preview"><video id="studio-preview-video"></video><audio id="studio-audio-preview"></audio></div>
                    <div class="preview-controls">
                        <button class="control-btn" id="btn-stop"><i class="fa-solid fa-stop"></i></button>
                        <button class="control-btn" id="btn-play-pause"><i class="fa-solid fa-play"></i></button>
                        <span id="studio-time-display" class="time-display">00:00.0</span>
                    </div>
                </div>
            </div>
            <div class="studio-timeline">
                <div class="timeline-scroll-area" id="studio-scroll-area">
                    <div class="timeline-content-wrapper" id="timeline-content-wrapper">
                        <div class="timeline-ruler-container" id="timeline-ruler-container"><div class="ruler-header-spacer"></div><div class="ruler-ticks"></div></div>
                        <div class="timeline-playhead-overlay" id="timeline-playhead"><div class="playhead-knob"></div><div class="playhead-line"></div></div>
                        <div class="timeline-tracks" id="studio-tracks"></div>
                    </div>
                </div>
            </div>
            <div class="status-bar hidden" id="studio-status-bar"><div class="status-spinner"></div><span id="studio-status-text">Processando...</span></div>
            <input type="file" id="studio-upload" multiple style="display:none" accept="video/*,audio/*,image/*">
        `;
        document.body.appendChild(div);
    }
}
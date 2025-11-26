import { getHeaderWidth, fmtTime } from '../utils.js';

export class TimelineManager {
    constructor(studio) {
        this.studio = studio;
        this.selectedClip = null;
        this.isScrubbing = false;
    }

    init() {
        this._bindEvents();
    }

    _bindEvents() {
        // Zoom Wheel
        const scrollArea = document.getElementById('studio-scroll-area');
        scrollArea.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                this.setZoom(this.studio.project.zoom * delta);
            }
        });

        // Ruler Click
        const ruler = document.getElementById('timeline-ruler-container');
        if(ruler) {
            ruler.onmousedown = (e) => {
                // Posição relativa aos ticks (que começam após o header)
                const ticks = document.querySelector('.ruler-ticks');
                const rect = ticks.getBoundingClientRect();
                const x = e.clientX - rect.left;
                
                if (x >= 0) {
                    this.studio.project.currentTime = Math.max(0, x / this.studio.project.zoom);
                    this.studio.playbackManager.updatePlayhead();
                    this.studio.playbackManager.syncPreview();
                }
            };
        }

        document.addEventListener('keydown', (e) => {
            if (!this.studio.isActive) return;
            if (e.code === 'Space') { e.preventDefault(); this.studio.playbackManager.togglePlayback(); }
            if (e.code === 'KeyS') this.splitClip();
            if (e.code === 'Delete') this.deleteClip();
        });
    }

    setZoom(newZoom) {
        this.studio.project.zoom = Math.max(1, Math.min(newZoom, 600));
        document.getElementById('studio-zoom-slider').value = this.studio.project.zoom;
        this.renderRuler();
        this.renderTracks();
        this.studio.playbackManager.updatePlayhead();
    }

    renderRuler() {
        const container = document.querySelector('.ruler-ticks');
        if(!container) return;
        container.innerHTML = '';
        container.style.width = (this.studio.project.duration * this.studio.project.zoom) + "px";
        
        let interval = 1;
        if(this.studio.project.zoom < 10) interval = 10;
        if(this.studio.project.zoom > 50) interval = 0.5;
        
        for(let t=0; t<=this.studio.project.duration; t+=interval) {
            const pos = t * this.studio.project.zoom;
            const tick = document.createElement('div');
            const isMajor = Math.abs(t % 1) < 0.001;
            tick.className = `tick ${isMajor?'major':'minor'}`;
            tick.style.left = pos + "px";
            if(isMajor) tick.innerText = fmtTime(t);
            container.appendChild(tick);
        }
    }

    renderTracks() {
        const container = document.getElementById("studio-tracks");
        if(!container) return;
        container.innerHTML = "";
        
        const totalWidth = (this.studio.project.duration * this.studio.project.zoom) + getHeaderWidth() + 500;
        const wrapper = document.getElementById('timeline-content-wrapper');
        if(wrapper) wrapper.style.width = totalWidth + "px";

        this.studio.project.tracks.forEach(track => {
            const el = document.createElement("div");
            el.className = `track ${track.type}`;
            el.innerHTML = `<div class="track-header"><div class="track-name">${track.name}</div></div><div class="track-lane"></div>`;
            const lane = el.querySelector(".track-lane");
            
            this._bindLaneEvents(lane, track);

            track.clips.forEach(clip => {
                const clipEl = this._createClipElement(clip, track.id);
                lane.appendChild(clipEl);
            });
            container.appendChild(el);
        });
        
        this.studio.playbackManager.updatePlayhead();
    }

    _bindLaneEvents(lane, track) {
        lane.ondragover = (e) => { e.preventDefault(); lane.style.background = "rgba(255,255,255,0.1)"; };
        lane.ondragleave = () => { lane.style.background = ""; };
        lane.ondrop = (e) => {
            e.preventDefault(); lane.style.background = "";
            if (this.studio.draggedAsset) {
                const rect = lane.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const time = Math.max(0, x / this.studio.project.zoom);
                this.addClipToTrack(track.id, this.studio.draggedAsset, time);
                this.studio.draggedAsset = null;
            }
        };

        // SCRUBBING NA TRACK (Clique na área vazia)
        lane.onmousedown = (e) => {
            if(e.target === lane) {
                this.isScrubbing = true;
                const handle = (ev) => {
                    const rect = lane.getBoundingClientRect();
                    const x = ev.clientX - rect.left;
                    this.studio.project.currentTime = Math.max(0, x / this.studio.project.zoom);
                    this.studio.playbackManager.updatePlayhead();
                    this.studio.playbackManager.syncPreview();
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
                
                // Deseleciona
                this.selectedClip = null;
                this.renderTracks();
            }
        };
    }

    _createClipElement(clip, trackId) {
        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if(!asset) return document.createElement('div');

        const el = document.createElement("div");
        el.className = `clip type-${clip.type}`;
        if (this.selectedClip && this.selectedClip.clip.id === clip.id) el.classList.add('selected');
        
        el.style.left = (clip.start * this.studio.project.zoom) + "px";
        el.style.width = (clip.duration * this.studio.project.zoom) + "px";
        
        // Posição do fader visual
        const faderTop = (1 - clip.level) * 100;

        el.innerHTML = `
            <div class="fader-handle" data-action="fader" title="Nível: ${Math.round(clip.level*100)}%"></div>
            <div class="fader-line" style="top: ${faderTop}%"></div>
            <div class="clip-opacity-overlay" style="opacity: ${1 - clip.level}"></div>
            
            <div class="clip-name">${clip.name}</div>
            <div class="resize-handle right" data-action="resize"></div>
        `;

        // Loops
        if (clip.duration > asset.baseDuration) {
            const loops = Math.floor(clip.duration / asset.baseDuration);
            for(let i=1; i<=loops; i++) {
                const m = document.createElement("div");
                m.className = "loop-marker";
                m.style.left = (i * asset.baseDuration * this.studio.project.zoom) + "px";
                el.appendChild(m);
            }
        }

        el.onmousedown = (e) => {
            e.stopPropagation();
            this.selectedClip = { clip, trackId };
            this.renderTracks();
            
            const action = e.target.dataset.action;
            if (action === 'resize') this._startResize(e, clip, el, asset.baseDuration);
            else if (action === 'fader') this._startFader(e, clip, el);
            else this._startMove(e, clip, el);
        };
        return el;
    }

    // --- FADER LOGIC ---
    _startFader(e, clip, el) {
        const startY = e.clientY;
        const startLevel = clip.level;
        const height = el.clientHeight;

        const onMove = (ev) => {
            const deltaY = ev.clientY - startY;
            const change = deltaY / height;
            let newLevel = Math.max(0, Math.min(1, startLevel - change));
            
            clip.level = newLevel;
            
            // Atualiza UI localmente sem re-renderizar tudo
            const line = el.querySelector('.fader-line');
            const overlay = el.querySelector('.clip-opacity-overlay');
            const handle = el.querySelector('.fader-handle');
            
            if(line) line.style.top = ((1 - newLevel) * 100) + "%";
            if(overlay) overlay.style.opacity = 1 - newLevel;
            if(handle) handle.title = `Nível: ${Math.round(newLevel*100)}%`;

            // Atualiza Preview em Tempo Real
            const pVideo = this.studio.playbackManager.previewVideo;
            const pAudio = this.studio.playbackManager.previewAudio;
            
            if (pVideo && pVideo.dataset.currentClipId === clip.id) {
                pVideo.style.opacity = newLevel;
            }
            if (pAudio && pAudio.dataset.currentClipId === clip.id) {
                pAudio.volume = newLevel;
            }
        };
        const onUp = () => { 
            window.removeEventListener("mousemove", onMove); 
            window.removeEventListener("mouseup", onUp); 
        };
        window.addEventListener("mousemove", onMove); 
        window.addEventListener("mouseup", onUp);
    }

    _startResize(e, clip, el, base) {
        const startX = e.clientX; const startW = clip.duration * this.studio.project.zoom;
        const onMove = (ev) => {
            let newW = Math.max(10, startW + (ev.clientX - startX));
            clip.duration = newW / this.studio.project.zoom;
            this.renderTracks();
        };
        const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    }

    _startMove(e, clip, el) {
        const startX = e.clientX; const startL = clip.start * this.studio.project.zoom;
        const onMove = (ev) => {
            let newL = Math.max(0, startL + (ev.clientX - startX));
            clip.start = newL / this.studio.project.zoom;
            this.renderTracks();
        };
        const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    }

    addClipToTrack(trackId, asset, startTime) {
        const track = this.studio.project.tracks.find(t => t.id === trackId);
        if (!track) return;
        if (track.type === 'video' && asset.type === 'audio') return alert("Track invalida");
        
        const clip = {
            id: "clip_" + Date.now() + Math.random(),
            assetId: asset.id, start: startTime, offset: 0,
            duration: asset.baseDuration, type: asset.type, name: asset.name,
            level: 1.0
        };
        track.clips.push(clip);
        this.renderTracks();
    }

    splitClip() {
        if (!this.selectedClip) return;
        const { clip, trackId } = this.selectedClip;
        const time = this.studio.project.currentTime;
        if (time <= clip.start || time >= (clip.start + clip.duration)) return;

        const relativeSplit = time - clip.start;
        const oldDuration = clip.duration;
        clip.duration = relativeSplit;

        const track = this.studio.project.tracks.find(t => t.id === trackId);
        const newClip = {
            ...clip, id: "clip_" + Date.now(),
            start: time, duration: oldDuration - relativeSplit,
            offset: clip.offset + relativeSplit
        };
        track.clips.push(newClip);
        this.selectedClip = null;
        this.renderTracks();
    }

    deleteClip() {
        if (!this.selectedClip) return;
        const { clip, trackId } = this.selectedClip;
        const track = this.studio.project.tracks.find(t => t.id === trackId);
        track.clips = track.clips.filter(c => c.id !== clip.id);
        this.selectedClip = null;
        this.renderTracks();
    }
}
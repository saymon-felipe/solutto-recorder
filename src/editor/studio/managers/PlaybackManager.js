import { getHeaderWidth, fmtTime } from '../utils.js';

export class PlaybackManager {
    constructor(studio) {
        this.studio = studio;
        this.isPlaying = false;
        this.previewVideo = null;
        this.previewAudio = null;
    }

    init() {
        this.previewVideo = document.getElementById('studio-preview-video');
        this.previewAudio = document.getElementById('studio-audio-preview');
        
        // Agulha (Drag do Knob)
        this._bindPlayheadEvents();

        document.getElementById("btn-play-pause").onclick = () => this.togglePlayback();
        document.getElementById("btn-stop").onclick = () => this.stop();
    }

    // Agulha: Drag
    _bindPlayheadEvents() {
        const knob = document.querySelector('.playhead-knob');
        const wrapper = document.getElementById('timeline-content-wrapper');
        
        if(!knob) return;

        knob.onmousedown = (e) => {
            e.stopPropagation();
            const onMove = (ev) => {
                const rect = wrapper.getBoundingClientRect();
                const x = ev.clientX - rect.left; // Relativo ao wrapper
                const trackX = x - getHeaderWidth();
                
                this.studio.project.currentTime = Math.max(0, trackX / this.studio.project.zoom);
                this.updatePlayhead();
                this.syncPreview();
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        };
    }

    togglePlayback() { this.isPlaying ? this.pause() : this.play(); }

    play() {
        this.isPlaying = true;
        document.getElementById('btn-play-pause').innerHTML = '<i class="fa-solid fa-pause"></i>';
        let lastTime = performance.now();
        const loop = (now) => {
            if (!this.isPlaying) return;
            const dt = (now - lastTime) / 1000; lastTime = now;
            this.studio.project.currentTime += dt;
            if (this.studio.project.currentTime >= this.studio.project.duration) this.pause();
            this.updatePlayhead(); this.syncPreview();
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

    stop() {
        this.pause();
        this.studio.project.currentTime = 0;
        this.updatePlayhead();
        this.syncPreview();
    }

    updatePlayhead() {
        // Posição absoluta = Header + (Tempo * Zoom)
        const x = getHeaderWidth() + (this.studio.project.currentTime * this.studio.project.zoom);
        const el = document.getElementById('timeline-playhead');
        if(el) el.style.left = x + "px";
        
        if (this.isPlaying) {
            const area = document.getElementById('studio-scroll-area');
            if (x - area.scrollLeft > area.clientWidth * 0.9) {
                area.scrollLeft = x - 150;
            }
        }
    }

    syncPreview() {
        const time = this.studio.project.currentTime;
        const tracks = this.studio.project.tracks;
        
        let activeVideo = null;
        // Lógica de procura do clipe de vídeo ativo (assumindo IDs 1 e 2)
        const videoTracks = tracks.filter(t => t.type === 'video').sort((a, b) => b.id - a.id); // Prioriza IDs maiores (overlay)
        for (const t of videoTracks) {
            const clip = t.clips.find(c => time >= c.start && time < (c.start + c.duration));
            if (clip) { activeVideo = clip; break; }
        }
        
        this._syncPlayer(this.previewVideo, activeVideo, time);

        let activeAudio = null;
        const audioTracks = tracks.filter(t => t.type === 'audio');
        for (const t of audioTracks) {
            const clip = t.clips.find(c => time >= c.start && time < (c.start + c.duration));
            if (clip) { activeAudio = clip; break; }
        }
        this._syncPlayer(this.previewAudio, activeAudio, time);

        const display = document.getElementById('studio-time-display');
        if(display) display.innerText = fmtTime(time);
    }

    _syncPlayer(player, clip, globalTime) {
        if (!player) return;
        if (clip) {
            const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
            if (!asset || asset.status !== 'ready') { player.style.display = 'none'; return; }

            player.style.display = 'block';
            if (player.dataset.currentClipId !== clip.id) {
                player.src = asset.url;
                player.dataset.currentClipId = clip.id;
                player.load();
            }

            if (player.tagName === 'VIDEO') {
                player.style.opacity = clip.level;
                
                player.muted = clip.muted === true; 
                
            }
            if (player.tagName === 'AUDIO') {
                player.volume = clip.level;
            }

            let localTime = (globalTime - clip.start) + clip.offset;
            if (localTime > asset.baseDuration) localTime = localTime % asset.baseDuration;

            if (Math.abs(player.currentTime - localTime) > 0.3 || player.ended) player.currentTime = localTime;
            
            if (this.isPlaying && player.paused) { const p = player.play(); if(p) p.catch(()=>{}); }
            else if (!this.isPlaying && !player.paused) player.pause();
        } else {
            player.style.display = 'none'; player.pause(); player.dataset.currentClipId = "";
        }
    }
}
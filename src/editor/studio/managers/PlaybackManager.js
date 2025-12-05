import { getHeaderWidth, fmtTime } from '../utils.js';

export class PlaybackManager {
    constructor(studio) {
        this.studio = studio;
        this.isPlaying = false;
        this.previewVideo = null;
        this.previewAudio = null;
        this.previewImageLayer = null; 
        
        this.lastPlayStartTime = 0;
        this.playedSinceLastSeek = false;
    }

    init() {
        this.previewVideo = document.getElementById('studio-preview-video');
        this.previewAudio = document.getElementById('studio-audio-preview');
        
        this._initImageLayer();

        this._bindPlayheadEvents();
        document.getElementById("btn-play-pause").onclick = () => this.togglePlayback();
        document.getElementById("btn-stop").onclick = () => this.stop();
    }

    _initImageLayer() {
        const container = document.querySelector('.studio-preview');
        if (container) {
            let img = document.getElementById('studio-preview-image-overlay');
            if (!img) {
                img = document.createElement('img');
                img.id = 'studio-preview-image-overlay';
                img.style.position = 'absolute';
                img.style.top = '0';
                img.style.left = '0';
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'contain';
                img.style.pointerEvents = 'none';
                img.style.display = 'none';
                img.style.zIndex = '10'; 
                container.appendChild(img);
            }
            this.previewImageLayer = img;
        }
    }

    _bindPlayheadEvents() {
        const knob = document.querySelector('.playhead-knob');
        const wrapper = document.getElementById('timeline-content-wrapper');
        
        if(!knob) return;

        knob.onmousedown = (e) => {
            e.stopPropagation();
            const onMove = (ev) => {
                const rect = wrapper.getBoundingClientRect();
                const x = ev.clientX - rect.left; 
                const trackX = x - getHeaderWidth();
                
                this.studio.project.currentTime = Math.max(0, trackX / this.studio.project.zoom);
                this.updatePlayhead();
                this.syncPreview();
                
                this.studio.timelineManager.lastSeekTime = this.studio.project.currentTime;
                this.playedSinceLastSeek = false;
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
        this.lastPlayStartTime = this.studio.project.currentTime;
        this.playedSinceLastSeek = true;

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

        if (this.playedSinceLastSeek) {
             this.studio.project.currentTime = this.lastPlayStartTime;
             this.playedSinceLastSeek = false;
             this.updatePlayhead();
             this.syncPreview();
        }
    }

    stop() {
        this.isPlaying = false;
        this.previewVideo.pause();
        this.previewAudio.pause();
        document.getElementById('btn-play-pause').innerHTML = '<i class="fa-solid fa-play"></i>';
        
        this.studio.project.currentTime = 0;
        this.updatePlayhead();
        this.syncPreview();
    }

    updatePlayhead() {
        const x = getHeaderWidth() + (this.studio.project.currentTime * this.studio.project.zoom);
        const el = document.getElementById('timeline-playhead-overlay'); 
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
        
        let activeVideoClip = null;
        let activeImageClip = null;

        const videoTracks = tracks.filter(t => t.type === 'video');

        for (const t of videoTracks) {
            const clip = t.clips.find(c => time >= c.start && time < (c.start + c.duration));
            if (!clip) continue;

            const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
            if (!asset) continue;

            if (asset.type === 'video') {
                activeVideoClip = clip; 
            } else if (asset.type === 'image') {
                activeImageClip = clip; 
            }
        }
        
        // 1. Sincroniza Vídeo de Fundo
        if (!activeVideoClip && this.previewVideo) {
            this.previewVideo.style.display = 'none';
        }
        this._syncPlayer(this.previewVideo, activeVideoClip, time);

        // 2. Sincroniza Imagem de Overlay
        this._syncImage(activeImageClip);

        // 3. Sincroniza Áudio (Busca apenas em tracks de ÁUDIO)
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

    _syncImage(clip) {
        if (!this.previewImageLayer) return;

        if (!clip) {
            this.previewImageLayer.style.display = 'none';
            this.previewImageLayer.src = "";
            return;
        }

        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if (!asset || asset.status !== 'ready') {
            this.previewImageLayer.style.display = 'none';
            return;
        }

        const currentSrc = this.previewImageLayer.getAttribute('src');
        if (currentSrc !== asset.url) {
            this.previewImageLayer.src = asset.url;
        }

        this.previewImageLayer.style.display = 'block';
        // Aplica opacidade corretamente na imagem
        this.previewImageLayer.style.opacity = clip.level !== undefined ? clip.level : 1;
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

            // Aplica propriedades visuais apenas se for elemento de vídeo
            if (player.tagName === 'VIDEO') {
                player.style.opacity = clip.level !== undefined ? clip.level : 1;
                player.muted = clip.muted === true;
            }
            // Aplica volume apenas se for elemento de áudio
            if (player.tagName === 'AUDIO') {
                player.volume = clip.level !== undefined ? clip.level : 1;
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
import { getHeaderWidth, fmtTime } from '../utils.js';

export class PlaybackManager {
    constructor(studio) {
        this.studio = studio;
        this.isPlaying = false;
        
        this.trackLayers = new Map();
        
        this.container = null;
        this.lastPlayStartTime = 0;
        this.playedSinceLastSeek = false;
    }

    init() {
        this.container = document.getElementById('studio-preview-canvas');
        
        if (!this.container) {
            console.warn("[PlaybackManager] Container de preview não encontrado. Verifique UIManager.");
            return;
        }

        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        this._bindPlayheadEvents();
        
        const btnPlay = document.getElementById("btn-play-pause");
        const btnStop = document.getElementById("btn-stop");
        
        if(btnPlay) btnPlay.onclick = () => this.togglePlayback();
        if(btnStop) btnStop.onclick = () => this.stop();
    }

    _initImageLayer() {
        const container = document.getElementById('studio-preview-canvas'); 
        
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
                
                container.appendChild(img);
            }
            this.previewImageLayer = img;
        } else {
            console.warn("[PlaybackManager] Canvas de preview não encontrado. Verifique UIManager.");
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
        const btn = document.getElementById('btn-play-pause');
        if(btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        
        this.trackLayers.forEach(layer => {
            if (layer.videoEl) layer.videoEl.pause();
            if (layer.audioEl) layer.audioEl.pause();
        });

        if (this.playedSinceLastSeek) {
             this.studio.project.currentTime = this.lastPlayStartTime;
             this.playedSinceLastSeek = false;
             this.updatePlayhead();
             this.syncPreview();
        }
    }

    stop() {
        this.isPlaying = false;

        this.trackLayers.forEach(layer => {
            if (layer.videoEl) {
                layer.videoEl.pause();
                layer.videoEl.currentTime = 0;
            }
            if (layer.audioEl) {
                layer.audioEl.pause();
                layer.audioEl.currentTime = 0;
            }
        });

        const btn = document.getElementById('btn-play-pause');
        if(btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        
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
        
        const currentTrackIds = new Set(tracks.map(t => t.id));
        for (const [trackId, layer] of this.trackLayers) {
            if (!currentTrackIds.has(trackId)) {
                if (layer.container) layer.container.remove();
                if (layer.audioEl) { layer.audioEl.pause(); layer.audioEl.src = ""; } 
                this.trackLayers.delete(trackId);
            }
        }

        const totalTracks = tracks.length;

        tracks.forEach((track, index) => {
            let layer = this.trackLayers.get(track.id);
            if (!layer) {
                layer = this._createTrackLayer(track);
                this.trackLayers.set(track.id, layer);
            }

            if (layer.container) {
                layer.container.style.zIndex = totalTracks - index;
            }

            const activeClip = track.clips.find(c => time >= c.start && time < (c.start + c.duration));
            
            if (track.type === 'video') {
                this._syncVideoTrack(layer, activeClip, time);
            } else if (track.type === 'audio') {
                this._syncAudioTrack(layer, activeClip, time);
            }
        });

        const display = document.getElementById('studio-time-display');
        if(display) display.innerText = fmtTime(time);
    }

    _createTrackLayer(track) {
        const layer = { type: track.type };

        if (track.type === 'video') {
            const div = document.createElement('div');
            div.className = `track-layer track-${track.id}`;
            div.style.position = 'absolute';
            div.style.top = '0';
            div.style.left = '0';
            div.style.width = '100%';
            div.style.height = '100%';
            div.style.pointerEvents = 'none'; 
            
            const vid = document.createElement('video');
            vid.style.width = '100%';
            vid.style.height = '100%';
            vid.style.objectFit = 'contain'; 
            vid.style.display = 'none';
            vid.crossOrigin = "anonymous"; 
            
            const img = document.createElement('img');
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'contain';
            img.style.display = 'none';

            div.appendChild(vid);
            div.appendChild(img);
            
            if (this.container) this.container.appendChild(div);

            layer.container = div;
            layer.videoEl = vid;
            layer.imgEl = img;
        } else {
            const aud = new Audio();
            aud.crossOrigin = "anonymous";
            layer.audioEl = aud;
        }

        return layer;
    }

    _syncVideoTrack(layer, clip, globalTime) {
        const { videoEl, imgEl } = layer;

        if (!clip) {
            videoEl.style.display = 'none';
            videoEl.pause();
            imgEl.style.display = 'none';
            videoEl.dataset.currentClipId = ""; 
            return;
        }

        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if (!asset || asset.status !== 'ready') return; 

        const isImage = asset.type === 'image';
        
        if (isImage) {
            videoEl.style.display = 'none';
            videoEl.pause();
            
            if (imgEl.src !== asset.url) {
                imgEl.src = asset.url;
            }
            imgEl.style.display = 'block';
            imgEl.style.opacity = clip.level !== undefined ? clip.level : 1;
            return;
        }

        imgEl.style.display = 'none';
        
        if (videoEl.dataset.currentClipId !== clip.id) {
            videoEl.src = asset.url;
            videoEl.dataset.currentClipId = clip.id;
            videoEl.load();
        }

        videoEl.style.display = 'block';
        videoEl.style.opacity = clip.level !== undefined ? clip.level : 1;
        videoEl.muted = clip.muted === true; 

        let localTime = (globalTime - clip.start) + clip.offset;
        if (asset.baseDuration && localTime > asset.baseDuration) {
            localTime = localTime % asset.baseDuration;
        }

        if (Math.abs(videoEl.currentTime - localTime) > 0.3 || videoEl.ended) {
            videoEl.currentTime = localTime;
        }

        if (this.isPlaying && videoEl.paused) {
            const p = videoEl.play();
            if(p) p.catch(() => {});
        } else if (!this.isPlaying && !videoEl.paused) {
            videoEl.pause();
        }
    }

    _syncAudioTrack(layer, clip, globalTime) {
        const { audioEl } = layer;
        
        if (!clip) {
            audioEl.pause();
            audioEl.dataset.currentClipId = "";
            return;
        }

        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if (!asset || asset.status !== 'ready') return;

        if (audioEl.dataset.currentClipId !== clip.id) {
            audioEl.src = asset.url;
            audioEl.dataset.currentClipId = clip.id;
            audioEl.load();
        }

        audioEl.volume = clip.level !== undefined ? clip.level : 1;

        let localTime = (globalTime - clip.start) + clip.offset;
        if (asset.baseDuration && localTime > asset.baseDuration) {
            localTime = localTime % asset.baseDuration;
        }

        if (Math.abs(audioEl.currentTime - localTime) > 0.3 || audioEl.ended) {
            audioEl.currentTime = localTime;
        }

        if (this.isPlaying && audioEl.paused) {
            const p = audioEl.play();
            if(p) p.catch(() => {});
        } else if (!this.isPlaying && !audioEl.paused) {
            audioEl.pause();
        }
    }
}
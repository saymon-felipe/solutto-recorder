import { getHeaderWidth, fmtTime } from '../utils.js';

export class PlaybackManager {
    constructor(studio) {
        this.studio = studio;
        this.isPlaying = false;
        
        // Gerenciador de players por Track ID (Multi-track)
        this.trackPlayers = new Map(); 

        this.lastPlayStartTime = 0;
        this.playedSinceLastSeek = false;
    }

    init() {
        this.previewContainer = document.getElementById('studio-preview-container');
        this._bindPlayheadEvents();
        document.getElementById("btn-play-pause").onclick = () => this.togglePlayback();
        document.getElementById("btn-stop").onclick = () => this.stop();
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
        
        this.trackPlayers.forEach(player => {
            if(player.tagName === 'VIDEO' || player.tagName === 'AUDIO') {
                player.pause();
            }
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
        document.getElementById('btn-play-pause').innerHTML = '<i class="fa-solid fa-play"></i>';
        
        this.trackPlayers.forEach(player => {
            if(player.tagName === 'VIDEO' || player.tagName === 'AUDIO') {
                player.pause();
            }
        });

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
        
        this.studio.project.tracks.forEach((track, index) => {
            const clip = track.clips.find(c => time >= c.start && time < (c.start + c.duration));
            this._syncTrackPlayer(track, clip, time, index);
        });

        const display = document.getElementById('studio-time-display');
        if(display && window.fmtTime) display.innerText = window.fmtTime(time); 
    }

    _syncTrackPlayer(track, clip, globalTime, zIndex) {
        if (!clip) {
            if (this.trackPlayers.has(track.id)) {
                const player = this.trackPlayers.get(track.id);
                player.style.display = 'none';
                if(player.pause) player.pause();
            }
            return;
        }

        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if (!asset || asset.status !== 'ready') return;

        let player = this._getTrackPlayer(track, asset);

        // 1. Visibilidade e Camada
        player.style.display = 'block';
        player.style.zIndex = 100 - zIndex;
        
        const opacity = (clip.level !== undefined && clip.level !== null) ? clip.level : 1;
        player.style.opacity = opacity;

        // 3. Verifica troca de source
        if (player.dataset.currentClipId !== clip.id) {
            player.src = asset.url;
            player.dataset.currentClipId = clip.id;
            if (player.load) player.load();
        }

        // 4. Aplica Volume/Mute específicos
        if (track.type === 'video') {
            if (player.tagName === 'VIDEO') player.muted = clip.muted === true;
        } else if (track.type === 'audio' && player.tagName === 'AUDIO') {
            player.volume = clip.level; // Volume do áudio
        }

        // 5. Sincronia de Tempo (Seek)
        if (player.tagName !== 'IMG') {
            let localTime = (globalTime - clip.start) + clip.offset;
            
            if (asset.baseDuration > 0 && localTime > asset.baseDuration) {
                localTime = localTime % asset.baseDuration;
            }

            if (Math.abs(player.currentTime - localTime) > 0.2 || player.ended) {
                player.currentTime = localTime;
            }

            if (this.isPlaying) {
                if (player.paused) {
                    const p = player.play();
                    if(p) p.catch(e => {}); 
                }
            } else {
                if (!player.paused) player.pause();
            }
        }
    }

    _getTrackPlayer(track, asset) {
        let player = this.trackPlayers.get(track.id);
        
        const isImage = asset.originalType && asset.originalType.startsWith('image');
        const desiredTag = track.type === 'audio' ? 'AUDIO' : (isImage ? 'IMG' : 'VIDEO');

        if (!player || player.tagName !== desiredTag) {
            if (player) player.remove();

            player = document.createElement(desiredTag.toLowerCase());
            player.className = 'track-player';
            player.id = `player-${track.id}`;
            
            if (track.type === 'video') {
                if (this.previewContainer) this.previewContainer.appendChild(player);
            } else {
                player.style.display = 'none'; 
                if (this.previewContainer) this.previewContainer.appendChild(player);
            }

            this.trackPlayers.set(track.id, player);
        }

        return player;
    }
}
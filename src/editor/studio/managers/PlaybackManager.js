import { getHeaderWidth, fmtTime } from '../utils.js';

export class PlaybackManager {
    constructor(studio) {
        this.studio = studio;
        this.isPlaying = false;
        this.trackLayers = new Map();
        this.container = null;
        
        // Contexto de Áudio e Nós
        this.audioCtx = null;
        this.monitorGain = null;      
        this.renderDestination = null; 
        
        // Cache do Canvas (Evita Garbage Collection)
        this.renderCanvas = null; 
    }

    init() {
        this.container = document.getElementById('studio-preview-canvas');
        if (!this.container) return;
        
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';
        
        const btnPlay = document.getElementById("btn-play-pause");
        const btnStop = document.getElementById("btn-stop");
        
        // Listeners com proteção de Renderização
        if(btnPlay) {
            btnPlay.onclick = () => {
                if (this.studio.renderManager.isRendering) return;
                this.togglePlayback();
            };
        }
        
        if(btnStop) {
            btnStop.onclick = () => {
                if (this.studio.renderManager.isRendering) return;
                this.stop();
            };
        }
    }

    togglePlayback() { 
        // Proteção extra caso seja chamado via atalho ou console
        if (this.studio.renderManager && this.studio.renderManager.isRendering) return;
        
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play(); 
        }
    }

    play() {
        // Salva o ponto onde o play começou para retornar depois (Comportamento estilo Vegas)
        this.lastPlayStartTime = this.studio.project.currentTime;
        this.playedSinceLastSeek = true;

        this.isPlaying = true;
        const btn = document.getElementById('btn-play-pause');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        
        let lastTime = performance.now();
        const loop = (now) => {
            if (!this.isPlaying) return;
            
            const dt = (now - lastTime) / 1000;
            lastTime = now;
            
            this.studio.project.currentTime += dt;
            
            if (this.studio.project.currentTime >= this.studio.project.duration) {
                this.pause();
            }
            
            this.updatePlayhead();
            this.syncPreview();
            
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    pause() {
        this.isPlaying = false;
        const btn = document.getElementById('btn-play-pause');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        
        // Pausa elementos DOM
        this.trackLayers.forEach(layer => {
            if (layer.videoEl) layer.videoEl.pause();
            if (layer.audioEl) layer.audioEl.pause();
        });

        // LÓGICA DE RETORNO DA AGULHA:
        // Se o usuário deu Play e depois Pause, volta para onde começou.
        // Se ele arrastou a agulha (seek) enquanto tocava, essa flag seria false (controlado pelo TimelineManager/Playhead).
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
            if (layer.videoEl) { layer.videoEl.pause(); layer.videoEl.currentTime = 0; }
            if (layer.audioEl) { layer.audioEl.pause(); layer.audioEl.currentTime = 0; }
        });
        const btn = document.getElementById('btn-play-pause');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        
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
            if (x - area.scrollLeft > area.clientWidth * 0.9) area.scrollLeft = x - 150;
        }
        
        const disp = document.getElementById('studio-time-display');
        if(disp) disp.innerText = fmtTime(this.studio.project.currentTime);
    }

    // =========================================================
    // ÁUDIO ENGINE
    // =========================================================

    toggleMonitorMute(shouldMute) {
        if (this.monitorGain && this.audioCtx) {
            const now = this.audioCtx.currentTime;
            this.monitorGain.gain.cancelScheduledValues(now);
            this.monitorGain.gain.linearRampToValueAtTime(shouldMute ? 0 : 1, now + 0.1);
        }
    }

    prepareForRendering() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

        // 1. Cria Nó de Monitoramento (se não existir)
        if (!this.monitorGain) {
            this.monitorGain = this.audioCtx.createGain();
            this.monitorGain.gain.value = 1; // Começa com volume 1
            this.monitorGain.connect(this.audioCtx.destination);
        }

        // 2. Cria Destino de Gravação
        if (!this.renderDestination) {
            this.renderDestination = this.audioCtx.createMediaStreamDestination();
        }

        // 3. Conecta cada track aos DOIS destinos
        this.trackLayers.forEach((layer, trackId) => {
            const mediaEl = layer.audioEl || layer.videoEl;
            const track = this.studio.project.tracks.find(t => t.id === trackId);
            
            if (mediaEl && track) {
                if (!mediaEl.crossOrigin) mediaEl.crossOrigin = "anonymous";
                mediaEl.volume = track.muted ? 0 : 1;

                if (!mediaEl._sourceNode) {
                    try { mediaEl._sourceNode = this.audioCtx.createMediaElementSource(mediaEl); } catch(e){}
                }
                
                if (mediaEl._sourceNode) {
                    try { mediaEl._sourceNode.disconnect(); } catch(e){}
                    
                    // Rota A: Para o Arquivo (Sempre ativo)
                    mediaEl._sourceNode.connect(this.renderDestination);
                    
                    // Rota B: Para o Usuário (Monitorável/Mutável)
                    mediaEl._sourceNode.connect(this.monitorGain);
                }
            }
        });

        return this.renderDestination.stream;
    }

    // =========================================================
    // RENDERIZAÇÃO DE VÍDEO (CANVAS)
    // =========================================================

    getCompositeStream(fps = 30) {
        const settings = this.studio.project.settings || { width: 1280, height: 720 };
        
        this.renderCanvas = document.createElement('canvas');
        this.renderCanvas.width = settings.width;
        this.renderCanvas.height = settings.height;
        
        const ctx = this.renderCanvas.getContext('2d', { alpha: false });
        
        this._startCanvasMirror(ctx, settings.width, settings.height);

        const videoStream = this.renderCanvas.captureStream(fps);
        const audioStream = this.prepareForRendering();

        return new MediaStream([
            ...videoStream.getVideoTracks(),
            ...audioStream.getAudioTracks()
        ]);
    }

    _startCanvasMirror(ctx, w, h) {
        const loop = () => {
            if (!this.isPlaying && !this.studio.renderManager.isRendering) return;
            this._drawCompositeFrame(ctx, w, h);
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    /**
     * Desenha o frame composto no Canvas.
     * CORRIGIDO: Seleciona corretamente Video ou Imagem e aplica transformações.
     */
    _drawCompositeFrame(ctx, cvWidth, cvHeight) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, cvWidth, cvHeight);

        const tracksReversed = [...this.studio.project.tracks].reverse();
        const currentTime = this.studio.project.currentTime;

        tracksReversed.forEach(track => {
            if (track.muted) return;
            const clip = track.clips.find(c => currentTime >= c.start && currentTime < (c.start + c.duration));
            if (!clip) return;

            const layer = this.trackLayers.get(track.id);
            if (!layer) return;

            // --- CORREÇÃO: Lógica robusta de seleção de elemento ---
            let domEl = null;
            if (layer.videoEl && layer.videoEl.style.display !== 'none') {
                domEl = layer.videoEl;
            } else if (layer.imgEl && layer.imgEl.style.display !== 'none') {
                domEl = layer.imgEl;
            }

            // Se não encontrou elemento visível ou vídeo não carregado, pula
            if (!domEl) return;
            if (domEl.tagName === 'VIDEO' && domEl.readyState < 2) return;
            
            ctx.save();
            
            let alpha = clip.level !== undefined ? clip.level : (clip.opacity || 1);
            ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

            // --- CORREÇÃO: Defaults de Transformação (Spread operator) ---
            const t = { x:0, y:0, width:100, height:100, rotation:0, ...clip.transform };
            
            // Aplica Matriz de Transformação (Pan/Crop)
            ctx.translate(cvWidth/2, cvHeight/2);
            ctx.translate(t.x, t.y);
            ctx.rotate(t.rotation * Math.PI / 180);
            ctx.scale(t.width/100, t.height/100);

            // Object Fit Contain no Canvas
            const nw = domEl.videoWidth || domEl.naturalWidth || cvWidth;
            const nh = domEl.videoHeight || domEl.naturalHeight || cvHeight;
            
            if (nw > 0 && nh > 0) {
                const ratioSrc = nw / nh;
                const ratioTgt = cvWidth / cvHeight;
                let dw, dh;
                
                if (ratioSrc > ratioTgt) { dw = cvWidth; dh = cvWidth / ratioSrc; }
                else { dh = cvHeight; dw = cvHeight * ratioSrc; }
                
                try { ctx.drawImage(domEl, -dw/2, -dh/2, dw, dh); } catch(e){}
            }
            ctx.restore();
        });
    }

    // =========================================================
    // PREVIEW SYNC DOM
    // =========================================================

    seekAndRender(time) {
        this.studio.project.currentTime = time;
        if(this.studio.timelineManager) this.studio.timelineManager.updatePlayheadPosition();
        this.syncPreview();
        this.trackLayers.forEach(layer => {
            const clip = this._getClipAtTime(layer.trackId, time);
            this._syncAudioTrack(layer, clip, time);
        });
    }

    syncPreview() {
        const time = this.studio.project.currentTime;
        const tracks = this.studio.project.tracks;
        
        const validIds = new Set(tracks.map(t => t.id));
        for (const [id, layer] of this.trackLayers) {
            if (!validIds.has(id)) {
                if(layer.container) layer.container.remove();
                if(layer.audioEl) layer.audioEl.pause();
                this.trackLayers.delete(id);
            }
        }

        tracks.forEach((track, idx) => {
            let layer = this.trackLayers.get(track.id);
            if (!layer) {
                layer = this._createTrackLayer(track);
                this.trackLayers.set(track.id, layer);
            }
            if(layer.container) layer.container.style.zIndex = tracks.length - idx;

            const clip = this._getClipAtTime(track.id, time);
            if(track.type === 'video') this._syncVideoTrack(layer, clip, time);
            else this._syncAudioTrack(layer, clip, time);
        });
    }

    _createTrackLayer(track) {
        const layer = { trackId: track.id };
        if (track.type === 'video') {
            const div = document.createElement('div');
            div.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;";
            
            const vid = document.createElement('video');
            vid.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
            vid.crossOrigin = "anonymous";
            
            const img = document.createElement('img');
            img.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
            
            div.append(vid, img);
            if(this.container) this.container.appendChild(div);
            
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

    _syncVideoTrack(layer, clip, time) {
        const { videoEl, imgEl } = layer;
        if (!clip) {
            videoEl.style.display = 'none'; videoEl.pause();
            imgEl.style.display = 'none'; return;
        }
        
        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if(!asset) return;

        let alpha = clip.level !== undefined ? clip.level : (clip.opacity || 1);
        alpha = Math.max(0, Math.min(1, alpha));

        // Aplica Transform no DOM (para preview visual fora da renderização)
        const applyDOMTransform = (el) => {
            this._applyClipTransform(el, clip);
        };

        if (asset.type === 'image') {
            videoEl.style.display = 'none'; videoEl.pause();
            if(imgEl.src !== asset.url) imgEl.src = asset.url;
            imgEl.style.display = 'block'; 
            imgEl.style.opacity = alpha;
            applyDOMTransform(imgEl);
            return;
        }

        imgEl.style.display = 'none';
        if (videoEl.dataset.curId !== clip.id) {
            videoEl.src = asset.url;
            videoEl.dataset.curId = clip.id;
            videoEl.load();
        }
        videoEl.style.display = 'block';
        videoEl.style.opacity = alpha;
        videoEl.muted = clip.muted === true;
        applyDOMTransform(videoEl);

        let localTime = (time - clip.start) + clip.offset;
        
        if (Math.abs(videoEl.currentTime - localTime) > 0.3 || videoEl.ended) {
            videoEl.currentTime = localTime;
        }

        const isRendering = this.studio.renderManager && this.studio.renderManager.isRendering;
        if (this.isPlaying || isRendering) {
            if(videoEl.paused) videoEl.play().catch(()=>{});
        } else {
            if(!videoEl.paused) videoEl.pause();
        }
    }

    /**
     * Aplica transformações CSS no elemento DOM (Preview em tempo real).
     */
    _applyClipTransform(element, clip) {
        if (!clip || !element) return;
        
        const t = { x:0, y:0, width:100, height:100, rotation:0, ...clip.transform };

        // Ordem: Center Origin -> Translate -> Rotate -> Scale
        const transform = `
            translate(-50%, -50%) 
            translate(${t.x}px, ${t.y}px) 
            rotate(${t.rotation}deg) 
            scale(${t.width / 100}, ${t.height / 100})
        `;

        element.style.transform = transform;
        element.style.position = 'absolute';
        element.style.left = '50%';
        element.style.top = '50%';
        element.style.transformOrigin = 'center center';
    }

    _syncAudioTrack(layer, clip, time) {
        const { audioEl } = layer;
        if(!audioEl) return;

        if (!clip) {
            if(!audioEl.paused) audioEl.pause();
            return;
        }
        
        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if(!asset) return;

        if(audioEl.dataset.curId !== clip.id) {
            audioEl.src = asset.url;
            audioEl.dataset.curId = clip.id;
        }

        let vol = clip.level !== undefined ? clip.level : (clip.volume || 1);
        if(vol > 1) vol = vol/100;
        audioEl.volume = Math.max(0, Math.min(1, vol));
        audioEl.muted = layer.muted || false;

        let localTime = (time - clip.start) + clip.offset;
        
        if (Math.abs(audioEl.currentTime - localTime) > 0.3) {
            audioEl.currentTime = localTime;
        }

        const isRendering = this.studio.renderManager && this.studio.renderManager.isRendering;
        
        // CORREÇÃO CRÍTICA:
        // Só toca se estiver 'playing' OU 'rendering', MAS...
        // Se estiver renderizando e nós PAUSAMOS explicitamente (fase de conversão), NÃO toque.
        const shouldPlay = this.isPlaying || (isRendering && this.isPlaying); 

        // Na prática, durante o render, this.isPlaying é true. 
        // Quando entra no _finishRender, chamamos pause(), this.isPlaying vira false.
        // Então shouldPlay vira false, e o áudio para.
        
        if (shouldPlay) {
            if(audioEl.paused) audioEl.play().catch(()=>{});
        } else {
            if(!audioEl.paused) audioEl.pause();
        }
    }

    _getClipAtTime(trackId, time) {
        const track = this.studio.project.tracks.find(t => t.id === trackId);
        if(!track || track.muted) return null;
        return track.clips.find(c => time >= c.start && time < (c.start + c.duration));
    }
}
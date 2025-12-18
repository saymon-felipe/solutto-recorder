const FPS = 30;

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

        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.id = 'studio-subtitle-overlay';
        this.overlayCanvas.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index: 4;";
        this.container.appendChild(this.overlayCanvas);

        this._startOverlayRenderLoop();
        
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
        if (this.studio.renderManager && this.studio.renderManager.isRendering) return;
        
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play(); 
        }
    }

    play() {
        this.prepareForRendering();

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
            if (layer.videoEl) { layer.videoEl.pause(); layer.videoEl.currentTime = 0; }
            if (layer.audioEl) { layer.audioEl.pause(); layer.audioEl.currentTime = 0; }
        });
        const btn = document.getElementById('btn-play-pause');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        
        this.studio.project.currentTime = 0;
        this.updatePlayhead();
        this.syncPreview();
    }

    _fmtSMPTE(time) {
        const totalFrames = Math.round(time * FPS);
        const frames = totalFrames % FPS;
        const totalSeconds = Math.floor(totalFrames / FPS);
        const s = totalSeconds % 60;
        const m = Math.floor(totalSeconds / 60) % 60;
        const h = Math.floor(totalSeconds / 3600);
        const pad = (n) => n.toString().padStart(2, '0');
        return `${pad(h)}:${pad(m)}:${pad(s)};${pad(frames)}`;
    }

    updatePlayhead() {
        const x = this.studio.project.currentTime * this.studio.project.zoom;
        const el = document.getElementById('timeline-playhead-overlay');
        if(el) el.style.left = x + "px";
        
        if (this.isPlaying) {
            const area = document.getElementById('studio-scroll-area');
            if (x - area.scrollLeft > area.clientWidth * 0.9) area.scrollLeft = x;
        }
        
        const disp = document.getElementById('studio-time-display');
        if(disp) disp.innerText = this._fmtSMPTE(this.studio.project.currentTime);
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
        
        // 1. Cria Nó de Monitoramento (se não existir)
        if (!this.monitorGain) {
            this.monitorGain = this.audioCtx.createGain();
            this.monitorGain.gain.value = 1.0; 
            this.monitorGain.connect(this.audioCtx.destination);
        }

        // 2. Cria Destino de Gravação (Render)
        if (!this.renderDestination) {
            this.renderDestination = this.audioCtx.createMediaStreamDestination();
        }

        // 3. Conecta cada track usando GainNodes individuais
        this.trackLayers.forEach((layer) => {
            // Processa tanto áudio quanto vídeo
            const mediaElements = [layer.audioEl, layer.audioEl2, layer.videoEl, layer.videoEl2];
            
            mediaElements.forEach(mediaEl => {
                if (!mediaEl) return;

                if (!mediaEl.crossOrigin) mediaEl.crossOrigin = "anonymous";
                
                // Inicializa SourceNode se necessário
                if (!mediaEl._sourceNode) {
                    try { mediaEl._sourceNode = this.audioCtx.createMediaElementSource(mediaEl); } catch(e){}
                }

                // Inicializa GainNode e conecta
                if (mediaEl._sourceNode) {
                    if (!mediaEl._gainNode) {
                        mediaEl._gainNode = this.audioCtx.createGain();
                        
                        // Tenta desconectar de destinos anteriores para evitar duplicação
                        try { mediaEl._sourceNode.disconnect(); } catch(e){}
                        
                        mediaEl._sourceNode.connect(mediaEl._gainNode);
                        mediaEl._gainNode.connect(this.renderDestination); // Para o arquivo
                        mediaEl._gainNode.connect(this.monitorGain);       // Para o ouvido
                    }
                }
            });
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
        let lastTime = 0;
        const interval = 1000 / 30; 

        const loop = (timestamp) => {
            if (!this.isPlaying && !this.studio.renderManager.isRendering) return;
            
            const elapsed = timestamp - lastTime;

            if (elapsed > interval) {
                lastTime = timestamp - (elapsed % interval);
                
                try {
                    this._drawCompositeFrame(ctx, w, h);
                } catch (e) {
                    console.error("Erro no frame de renderização:", e);
                }
            }
            
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    _drawCompositeFrame(ctx, cvWidth, cvHeight) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, cvWidth, cvHeight);

        const tracksReversed = [...this.studio.project.tracks].reverse();
        const currentTime = this.studio.project.currentTime;

        // --- LOOP 1: VÍDEO E IMAGEM (Camada de Fundo) ---
        tracksReversed.forEach(track => {
            if (track.muted || track.type !== 'video') return;
            
            const activeClips = track.clips.filter(c => 
                c.type !== 'subtitle' &&
                currentTime >= c.start && 
                currentTime < (c.start + c.duration)
            ).sort((a, b) => a.start - b.start);

            if (activeClips.length === 0) return;

            const layer = this.trackLayers.get(track.id);
            if (!layer) return;

            activeClips.forEach(clip => {
                let domEl = null;
                const slotId = clip._assignedSlotId;

                if (slotId === 1) {
                    domEl = (clip.type === 'image') ? layer.imgEl : layer.videoEl;
                } else if (slotId === 2) {
                    domEl = (clip.type === 'image') ? layer.imgEl2 : layer.videoEl2;
                } else {
                    if (layer.videoEl && (layer.videoEl.dataset.curId === clip.id || layer.imgEl.dataset.curId === clip.id)) {
                        domEl = (clip.type === 'image') ? layer.imgEl : layer.videoEl;
                    } else if (layer.videoEl2 && (layer.videoEl2.dataset.curId === clip.id || layer.imgEl2.dataset.curId === clip.id)) {
                        domEl = (clip.type === 'image') ? layer.imgEl2 : layer.videoEl2;
                    }
                }

                if (!domEl) return;
                if (domEl.tagName === 'VIDEO' && domEl.readyState < 2) return;
                if (domEl.tagName === 'IMG' && domEl.naturalWidth === 0) return;

                ctx.save();
                try {
                    let alpha = clip.level !== undefined ? clip.level : (clip.opacity || 1);
                    const fadeFactor = this._calculateFadeFactor(clip, currentTime); 
                    alpha *= fadeFactor;

                    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

                    const t = { x:0, y:0, width:100, height:100, rotation:0, ...clip.transform };
                    
                    ctx.translate(cvWidth/2, cvHeight/2);
                    ctx.translate(t.x, t.y);
                    ctx.rotate(t.rotation * Math.PI / 180);
                    ctx.scale(t.width/100, t.height/100);

                    const nw = domEl.videoWidth || domEl.naturalWidth || cvWidth;
                    const nh = domEl.videoHeight || domEl.naturalHeight || cvHeight;
                    
                    if (nw > 0 && nh > 0) {
                        const ratioSrc = nw / nh;
                        const ratioTgt = cvWidth / cvHeight;
                        let dw, dh;
                        
                        if (ratioSrc > ratioTgt) { dw = cvWidth; dh = cvWidth / ratioSrc; }
                        else { dh = cvHeight; dw = cvHeight * ratioSrc; }
                        
                        ctx.drawImage(domEl, -dw/2, -dh/2, dw, dh); 
                    }
                } catch(e) {}
                ctx.restore();
            });
        });

        try {
            this.studio.project.tracks.forEach(track => {
                if (track.muted) return;
                
                const activeSubClips = track.clips.filter(c => 
                    c.type === 'subtitle' && 
                    currentTime >= c.start && 
                    currentTime < (c.start + c.duration)
                );

                activeSubClips.forEach(clip => {
                    this._renderSubtitleOverlay(ctx, clip, currentTime, cvWidth, cvHeight);
                });
            });
        } catch (e) {
            console.warn("Erro ao renderizar legenda:", e);
        }
    }

    _startOverlayRenderLoop() {
        const ctx = this.overlayCanvas.getContext('2d');
        const loop = () => {
            if (!this.overlayCanvas) return;

            if (this.overlayCanvas.width !== this.overlayCanvas.offsetWidth || 
                this.overlayCanvas.height !== this.overlayCanvas.offsetHeight) {
                this.overlayCanvas.width = this.overlayCanvas.offsetWidth;
                this.overlayCanvas.height = this.overlayCanvas.offsetHeight;
            }

            ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

            const currentTime = this.studio.project.currentTime;
            this.studio.project.tracks.forEach(track => {
                if (track.muted) return;
                const activeSubClips = track.clips.filter(c => 
                    c.type === 'subtitle' && currentTime >= c.start && currentTime < (c.start + c.duration)
                );
                activeSubClips.forEach(clip => {
                    this._renderSubtitleOverlay(ctx, clip, currentTime, this.overlayCanvas.width, this.overlayCanvas.height);
                });
            });
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    async waitForReady(timeoutMs = 5000) {
        const promises = [];
        this.trackLayers.forEach(layer => {
            const elements = [layer.videoEl, layer.videoEl2, layer.imgEl, layer.imgEl2, layer.audioEl, layer.audioEl2];
            elements.forEach(el => {
                if (!el || el.style.display === 'none') return;
                if (el.tagName === 'AUDIO' && (!el.src || el.src === window.location.href)) return;

                promises.push(new Promise(resolve => {
                    if (el.tagName === 'IMG') {
                        if (el.complete && el.naturalWidth > 0) return resolve();
                        el.onload = () => resolve();
                        el.onerror = () => resolve(); 
                    } else if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
                        const isReady = () => el.readyState >= 3 && !el.seeking;
                        if (isReady()) return resolve();
                        
                        const onCheck = () => { if (isReady()) { cleanUp(); resolve(); } };
                        const cleanUp = () => {
                            el.removeEventListener('canplay', onCheck);
                            el.removeEventListener('seeked', onCheck); 
                            el.removeEventListener('playing', onCheck);
                            el.removeEventListener('error', resolve); 
                        };
                        el.addEventListener('canplay', onCheck);
                        el.addEventListener('seeked', onCheck);
                        el.addEventListener('playing', onCheck);
                        el.addEventListener('error', () => { cleanUp(); resolve(); });
                    } else {
                        resolve();
                    }
                }));
            });
        });
        if (promises.length === 0) return Promise.resolve();
        const timeout = new Promise(resolve => setTimeout(resolve, timeoutMs));
        return Promise.race([Promise.all(promises), timeout]);
    }

    _easeOutBack(x) {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }

    _renderSubtitleOverlay(ctx, clip, time, w, h) {
        // (Código de Legenda mantido igual ao anterior, omitido para brevidade pois não afeta áudio)
        // ... (Mesmo código do arquivo original)
        if (!clip.transcriptionData || clip.transcriptionData.length === 0) return;
        if (!clip.subtitleConfig) return;

        const assetTime = (time - clip.start) + clip.offset;
        const cfg = clip.subtitleConfig;
        
        let baseLevel = clip.level !== undefined ? clip.level : 1;
        const fadeFactor = this._calculateFadeFactor(clip, time);
        const finalAlpha = baseLevel * fadeFactor;
        if (finalAlpha < 0.01) return;

        ctx.save();
        ctx.globalAlpha = finalAlpha;

        const projectW = (this.studio.project.settings && this.studio.project.settings.width) || 1280;
        const s = w / projectW; 

        ctx.translate(w / 2, h / 2);
        if (clip.transform) {
            const t = clip.transform;
            ctx.translate(t.x * s, t.y * s);
            ctx.rotate(t.rotation * Math.PI / 180);
            ctx.scale(t.width / 100, t.height / 100);
        }

        const baseSize = cfg.size || 40;
        const scaledFontSize = Math.max(10, baseSize * s);
        const fontName = cfg.font || 'Arial';
        const fontStyle = cfg.italic ? 'italic' : 'normal';
        const fontWeight = cfg.bold ? 'bold' : 'normal';
        
        ctx.font = `${fontStyle} ${fontWeight} ${scaledFontSize}px ${fontName}`;
        ctx.textBaseline = 'middle';

        const visibleWords = clip.transcriptionData;
        const wordMetrics = visibleWords.map(wordObj => {
            const metrics = ctx.measureText(wordObj.text + " "); 
            return {
                obj: wordObj,
                width: metrics.width,
                text: wordObj.text,
                active: (assetTime >= wordObj.start && assetTime <= wordObj.end)
            };
        });

        const totalWidth = wordMetrics.reduce((acc, item) => acc + item.width, 0);
        let cursorX = -totalWidth / 2;

        const styleMode = cfg.styleMode || 'karaoke';
        const activeColor = cfg.highlightColor || '#ffff00';
        const inactiveColor = cfg.color || '#ffffff';
        const bgColor = cfg.bgColor || '#000000';

        if (styleMode === 'box') {
            const paddingX = 20 * s;
            const paddingY = 15 * s;
            const bgHeight = (scaledFontSize * 1.4);
            const radius = 12 * s;
            ctx.fillStyle = bgColor;
            this._drawRoundedRect(ctx, -totalWidth / 2 - paddingX, -bgHeight / 2, totalWidth + (paddingX * 2), bgHeight, radius);
            ctx.fill();
        }

        wordMetrics.forEach((item, index) => {
            let fillStyle = inactiveColor;
            
            if (styleMode === 'karaoke') {
                if (item.active) fillStyle = activeColor;
            } else if (styleMode === 'word-pill') {
                if (item.active) fillStyle = '#000000'; 
            }

            if (styleMode === 'word-pill' && item.active) {
                const pillPaddingX = 6 * s;
                const pillHeight = scaledFontSize * 1.2;
                const pillY = -pillHeight / 2;
                const radius = 8 * s;
                const animDuration = 0.15; 
                const timeIn = assetTime - item.obj.start;
                const timeOut = item.obj.end - assetTime;
                
                let scaleAnim = 1;
                let opacityAnim = 1;

                if (timeIn < animDuration) {
                    if (index === 0) {
                        opacityAnim = Math.min(1, timeIn / (animDuration * 0.3)); 
                        scaleAnim = 1; 
                    } else {
                        scaleAnim = this._easeOutBack(timeIn / animDuration);
                        opacityAnim = Math.min(1, timeIn / (animDuration * 0.5));
                    }
                } else if (timeOut < animDuration) {
                    const p = Math.max(0, timeOut / animDuration);
                    scaleAnim = p;
                    opacityAnim = p;
                }

                ctx.save();
                const wordCenterX = cursorX + (item.width / 2);
                ctx.translate(wordCenterX, 0);
                ctx.scale(scaleAnim, scaleAnim);
                ctx.translate(-wordCenterX, 0);
                ctx.globalAlpha = finalAlpha * opacityAnim;
                ctx.fillStyle = activeColor; 
                const visualWordWidth = ctx.measureText(item.text).width;
                this._drawRoundedRect(ctx, cursorX - pillPaddingX, pillY, visualWordWidth + (pillPaddingX*2), pillHeight, radius);
                ctx.fill();
                ctx.shadowColor = 'rgba(0,0,0,0.3)';
                ctx.shadowBlur = 4 * s;
                ctx.restore();
            }

            ctx.fillStyle = fillStyle;
            if (styleMode !== 'box' && !(styleMode === 'word-pill' && item.active)) {
                ctx.shadowColor = 'rgba(0,0,0,0.5)';
                ctx.shadowBlur = 2 * s;
            } else {
                ctx.shadowColor = 'transparent';
            }

            if (styleMode === 'karaoke' && item.active) {
                ctx.save();
                const wordCenterX = cursorX + (item.width / 2);
                ctx.translate(wordCenterX, 0);
                ctx.scale(1.1, 1.1); 
                ctx.translate(-wordCenterX, 0);
                ctx.fillText(item.text, cursorX, 0);
                ctx.restore();
            } else {
                ctx.fillText(item.text, cursorX, 0);
            }
            cursorX += item.width;
        });
        ctx.restore();
    }

    _drawRoundedRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    seekAndRender(time) {
        this.studio.project.currentTime = time;
        if(this.studio.timelineManager) this.studio.timelineManager.updatePlayheadPosition();
        this.syncPreview();
        this.trackLayers.forEach(layer => {
            const clips = this._getClipsAtTime(layer.trackId, time);
            this._syncAudioTrack(layer, clips, time);
        });
    }

    syncPreview() {
        if (!this.container) this.container = document.getElementById('studio-preview-canvas');
        if (!this.container) return;

        const time = this.studio.project.currentTime;
        const tracks = this.studio.project.tracks;
        
        const validIds = new Set(tracks.map(t => t.id));
        for (const [id, layer] of this.trackLayers) {
            if (!validIds.has(id)) {
                if(layer.container) layer.container.remove();
                if(layer.audioEl) { layer.audioEl.pause(); layer.audioEl.src = ""; }
                if(layer.audioEl2) { layer.audioEl2.pause(); layer.audioEl2.src = ""; }
                this.trackLayers.delete(id);
            }
        }

        tracks.forEach((track, idx) => {
            let layer = this.trackLayers.get(track.id);
            if (!layer) {
                layer = this._createTrackLayer(track);
                this.trackLayers.set(track.id, layer);
            }

            if (layer.container && !this.container.contains(layer.container)) {
                this.container.appendChild(layer.container);
            }

            if(layer.container) layer.container.style.zIndex = tracks.length - idx;

            const clips = this._getClipsAtTime(track.id, time);
            if(track.type === 'video') this._syncVideoTrack(layer, clips, time);
            else this._syncAudioTrack(layer, clips, time);
        });

        if (!this.overlayCanvas) {
            this.overlayCanvas = document.createElement('canvas');
            this.overlayCanvas.id = 'studio-subtitle-overlay';
            this.overlayCanvas.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index: 4;";
            this.container.appendChild(this.overlayCanvas);
        } else {
            this.container.appendChild(this.overlayCanvas);
        }
        this._forceSeek = false;
    }

    _updateSingleMediaElement(domEl, clip, time, isImage) {
        const EPSILON = 0.005; 
        
        if (!clip) {
            domEl.style.display = 'none';
            domEl.dataset.curId = ""; 
            if(!isImage) domEl.pause();
            return;
        }

        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if(!asset || asset.status === 'unloaded') { 
            domEl.style.display = 'none';
            return;
        }

        if(domEl.dataset.curId !== clip.id) {
            domEl.src = asset.url;
            domEl.dataset.curId = clip.id;
            if(!isImage) domEl.load(); 
        }

        let alpha = clip.level !== undefined ? clip.level : (clip.opacity || 1);
        alpha *= this._calculateFadeFactor(clip, time);
        alpha = Math.max(0, Math.min(1, alpha));
        if (alpha < 0.001) alpha = 0;

        const t = { x:0, y:0, width:100, height:100, rotation:0, ...clip.transform };
        const transform = `translate(-50%, -50%) translate(${t.x}px, ${t.y}px) rotate(${t.rotation}deg) scale(${t.width / 100}, ${t.height / 100})`;
        
        domEl.style.transform = transform;
        domEl.style.position = 'absolute';
        domEl.style.left = '50%';
        domEl.style.top = '50%';
        domEl.style.transformOrigin = 'center center';
        domEl.style.display = 'block';
        domEl.style.opacity = alpha;

        if (!isImage) {
            domEl.muted = false; 

            if (domEl._gainNode && this.audioCtx) {
                const now = this.audioCtx.currentTime;
                // Aplica volume no GainNode
                try {
                    const currentGain = domEl._gainNode.gain.value;
                    if (Math.abs(currentGain - alpha) > 0.0001) {
                        domEl._gainNode.gain.cancelScheduledValues(now);
                        domEl._gainNode.gain.setValueAtTime(currentGain, now);
                        domEl._gainNode.gain.linearRampToValueAtTime(alpha, now + 0.03);
                    }
                } catch(e) {
                    domEl._gainNode.gain.value = alpha; 
                }
            } else {
                domEl.volume = alpha; 
            }

            let rawTime = (time - clip.start) + clip.offset;
            let localTime = rawTime;
            let DURATION = 0; 
            if (domEl.duration && Number.isFinite(domEl.duration) && domEl.duration > 0) {
                DURATION = domEl.duration;
                localTime = rawTime % DURATION;
            }
            if (DURATION > 0) {
                if (localTime > (DURATION - EPSILON) && localTime < DURATION) localTime = DURATION - EPSILON;
            }
            
            const needsSeek = this._forceSeek || Math.abs(domEl.currentTime - localTime) > 0.3 || domEl.ended;
            if (needsSeek && Number.isFinite(localTime)) {
                try { domEl.currentTime = localTime; } catch(e) {}
            }

            const isRendering = this.studio.renderManager && this.studio.renderManager.isRendering;
            if (this.isPlaying || isRendering) {
                if(domEl.paused) domEl.play().catch(()=>{}); 
            } else {
                if(!domEl.paused) domEl.pause();
            }
        }
    }

    _createTrackLayer(track) {
        const layer = { trackId: track.id };
        if (track.type === 'video') {
            const div = document.createElement('div');
            div.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;";
            
            const vid1 = document.createElement('video');
            vid1.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
            vid1.crossOrigin = "anonymous";
            const img1 = document.createElement('img');
            img1.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
            
            const vid2 = document.createElement('video');
            vid2.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
            vid2.crossOrigin = "anonymous";
            const img2 = document.createElement('img');
            img2.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";

            div.append(vid1, img1, vid2, img2);
            if(this.container) this.container.appendChild(div);
            
            layer.container = div;
            layer.videoEl = vid1;
            layer.imgEl = img1;
            layer.videoEl2 = vid2;
            layer.imgEl2 = img2;
        } else {
            const aud1 = new Audio();
            aud1.crossOrigin = "anonymous";
            aud1.volume = 1.0; 
            
            const aud2 = new Audio();
            aud2.crossOrigin = "anonymous";
            aud2.volume = 1.0;
            
            layer.audioEl = aud1;
            layer.audioEl2 = aud2;
        }
        return layer;
    }

    _syncVideoTrack(layer, clips, time) {
        const slots = [
            { id: 1, video: layer.videoEl, image: layer.imgEl },
            { id: 2, video: layer.videoEl2, image: layer.imgEl2 }
        ];
        const usedSlotIds = new Set();

        clips.forEach(clip => {
            if (clip._assignedSlotTrackId && clip._assignedSlotTrackId !== layer.trackId) {
                clip._assignedSlotId = null;
                clip._assignedSlotTrackId = null;
            }
        });

        clips.forEach(clip => {
            const domMatch = slots.find(s => 
                (s.video.dataset.curId === clip.id) || (s.image.dataset.curId === clip.id)
            );
            if (domMatch) {
                clip._assignedSlotId = domMatch.id;
                clip._assignedSlotTrackId = layer.trackId;
                usedSlotIds.add(domMatch.id);
            } else if (clip._assignedSlotId) {
                if (!usedSlotIds.has(clip._assignedSlotId)) {
                    usedSlotIds.add(clip._assignedSlotId);
                    clip._assignedSlotTrackId = layer.trackId;
                } else {
                    clip._assignedSlotId = null;
                }
            }
        });

        clips.forEach(clip => {
            if (!clip._assignedSlotId) {
                const freeSlot = slots.find(s => !usedSlotIds.has(s.id));
                if (freeSlot) {
                    clip._assignedSlotId = freeSlot.id;
                    clip._assignedSlotTrackId = layer.trackId;
                    usedSlotIds.add(freeSlot.id);
                }
            }
        });

        slots.forEach(slot => {
            const assignedClip = clips.find(c => c._assignedSlotId === slot.id);
            if (assignedClip) {
                const isImage = assignedClip.type === 'image';
                if (isImage) {
                    this._updateSingleMediaElement(slot.image, assignedClip, time, true);
                    this._updateSingleMediaElement(slot.video, null, time, false);
                } else {
                    this._updateSingleMediaElement(slot.video, assignedClip, time, false);
                    this._updateSingleMediaElement(slot.image, null, time, true);
                }
            } else {
                this._updateSingleMediaElement(slot.image, null, time, true);
                this._updateSingleMediaElement(slot.video, null, time, false);
            }
        });
    }

    _applyClipTransform(element, clip) {
        if (!clip || !element) return;
        const t = { x:0, y:0, width:100, height:100, rotation:0, ...clip.transform };
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

    _calculateFadeFactor(clip, globalTime) {
        if (!clip) return 1;
        const timeInClip = globalTime - clip.start;
        const duration = clip.duration;
        const fadeIn = Number(clip.fadeIn) || 0;
        const fadeOut = Number(clip.fadeOut) || 0;

        let factorIn = 1.0;
        let factorOut = 1.0;

        if (fadeIn > 0) {
            if (timeInClip < 0) factorIn = 0; 
            else if (timeInClip < fadeIn) {
                const progress = timeInClip / fadeIn;
                factorIn = 0.5 * (1 - Math.cos(progress * Math.PI));
            }
        }

        if (fadeOut > 0) {
            const timeStartFadeOut = duration - fadeOut;
            if (timeInClip > duration) factorOut = 0; 
            else if (timeInClip > timeStartFadeOut) {
                const remaining = duration - timeInClip;
                const progress = remaining / fadeOut; 
                factorOut = 0.5 * (1 - Math.cos(progress * Math.PI));
            }
        }
        return Math.max(0, Math.min(1, factorIn * factorOut));
    }

    _syncAudioTrack(layer, clips, time) {
        const trackId = layer.trackId;
        const track = this.studio.project.tracks.find(t => t.id === trackId);
        let allClipsOnTrack = track ? track.clips : [];
        
        const updateAudio = (audioEl, clip, clipIndex) => {
            const EPSILON = 0.005;
            
            if(!audioEl) return;
            if (!clip) { 
                if (audioEl._gainNode && this.audioCtx && !audioEl.paused) {
                    const now = this.audioCtx.currentTime;
                    try {
                        audioEl._gainNode.gain.cancelScheduledValues(now);
                        audioEl._gainNode.gain.setValueAtTime(audioEl._gainNode.gain.value, now);
                        audioEl._gainNode.gain.linearRampToValueAtTime(0, now + 0.08);
                        setTimeout(() => { if (!clip && !audioEl.paused) audioEl.pause(); }, 100);
                    } catch(e) {
                        audioEl.pause();
                    }
                } else if(!audioEl.paused) {
                    audioEl.pause();
                }
                return; 
            }

            const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
            if(!asset || asset.status === 'unloaded') { return; }

            if(audioEl.dataset.curId !== clip.id) {
                audioEl.src = asset.url;
                audioEl.dataset.curId = clip.id;
                audioEl.load(); 
            }

            let vol = clip.level !== undefined ? clip.level : (clip.volume || 1);
            if(vol > 1) vol = vol/100;
            
            let fadeFactor = this._calculateFadeFactor(clip, time);
            
            // Lógica de Overlap (Crossfade automático entre clipes)
            const clipStart = clip.start;
            const clipEnd = clip.start + clip.duration;
            let hasLeftOverlap = false;
            let leftOverlapFade = 0;
            
            for (const otherClip of allClipsOnTrack) {
                if (otherClip.id === clip.id) continue;
                const otherEnd = otherClip.start + otherClip.duration;
                if (otherClip.start < clipStart && otherEnd > clipStart && otherEnd < clipEnd) {
                    hasLeftOverlap = true;
                    if (time >= clipStart && time < otherEnd) {
                        const otherFade = this._calculateFadeFactor(otherClip, time);
                        leftOverlapFade = otherFade;
                    }
                    break;
                }
            }
            
            let normalizedFadeFactor = fadeFactor;
            if (hasLeftOverlap && leftOverlapFade > 0.01) {
                const totalFade = fadeFactor + leftOverlapFade;
                if (totalFade > 0.01) normalizedFadeFactor = fadeFactor / totalFade;
            }
            vol *= normalizedFadeFactor;
            
            let finalVol = Math.max(0, Math.min(1, vol));
            if (finalVol < 0.0001) finalVol = 0;

            // [CORREÇÃO] Nunca "mutar" o elemento se a track não estiver mutada.
            // O volume é controlado pelo GainNode. Mutar o elemento silencia o nó de origem.
            audioEl.muted = false;

            if (audioEl._gainNode && this.audioCtx) {
                const now = this.audioCtx.currentTime;
                try {
                    const currentGain = audioEl._gainNode.gain.value;
                    if (Math.abs(currentGain - finalVol) > 0.00001) {
                        audioEl._gainNode.gain.cancelScheduledValues(now);
                        audioEl._gainNode.gain.setValueAtTime(currentGain, now);
                        audioEl._gainNode.gain.linearRampToValueAtTime(finalVol, now + 0.1);
                    }
                } catch(e) {
                    audioEl._gainNode.gain.value = finalVol;
                }
            } else {
                audioEl.volume = finalVol;
            }

            let rawTime = (time - clip.start) + clip.offset;
            let localTime = rawTime;
            let DURATION = 0; 

            if (audioEl.duration && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
                DURATION = audioEl.duration;
                localTime = rawTime % DURATION;
            }
            
            if (DURATION > 0) {
                if (localTime > (DURATION - EPSILON) && localTime < DURATION) localTime = DURATION - EPSILON;
            }

            const needsSeek = this._forceSeek || Math.abs(audioEl.currentTime - localTime) > 0.3;
            if (needsSeek && Number.isFinite(localTime)) {
                try { audioEl.currentTime = localTime; } catch(e) {}
            }
            
            const isRendering = this.studio.renderManager && this.studio.renderManager.isRendering;
            if (this.isPlaying || isRendering) {
                if(audioEl.paused) audioEl.play().catch(()=>{});
            } else {
                if(!audioEl.paused) audioEl.pause();
            }
        };

        updateAudio(layer.audioEl, clips[0] || null, 0);
        updateAudio(layer.audioEl2, clips[1] || null, 1);
    }

    _getClipsAtTime(trackId, time) {
        const track = this.studio.project.tracks.find(t => t.id === trackId);
        if(!track || track.muted) return [];
        return track.clips.filter(c => c.type !== 'subtitle' && time >= c.start && time < (c.start + c.duration))
                          .sort((a, b) => a.start - b.start); 
    }

    async renderFrameOffline(time, ctx, w, h) {
        this.studio.project.currentTime = time;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, w, h);

        const visibleClips = [];
        const tracks = [...this.studio.project.tracks].reverse();
        
        tracks.forEach(track => {
            if (track.muted || track.type !== 'video') return;
            const clips = this._getClipsAtTime(track.id, time);
            if (clips.length > 0) visibleClips.push({ clip: clips[0], track });
        });

        await this._waitForMediaReady(visibleClips, time);

        visibleClips.forEach(({ clip, track }) => {
            const asset = this.studio.assetManager.getAsset(clip.assetId);
            if (!asset) return;

            let layer = this.trackLayers.get(track.id);
            if (!layer) {
                layer = this._createTrackLayer(track);
                this.trackLayers.set(track.id, layer);
            }

            const drawable = (asset.type === 'image') ? layer.imgEl : layer.videoEl;

            let alpha = clip.level !== undefined ? clip.level : (clip.opacity || 1);
            const fadeFactor = this._calculateFadeFactor(clip, time);
            alpha *= fadeFactor;

            ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

            ctx.save();
            const t = { x:0, y:0, width:100, height:100, rotation:0, ...clip.transform };
            ctx.translate(w/2, h/2);
            ctx.translate(t.x, t.y);
            ctx.rotate(t.rotation * Math.PI / 180);
            ctx.scale(t.width / 100, t.height / 100);

            const dw = drawable.videoWidth || drawable.naturalWidth || w;
            const dh = drawable.videoHeight || drawable.naturalHeight || h;
            
            if (dw > 0 && dh > 0) {
                const ratioSrc = dw / dh;
                const ratioDest = w / h;
                let renderW, renderH;
                if (ratioSrc > ratioDest) { renderW = w; renderH = w / ratioSrc; }
                else { renderH = h; renderW = h * ratioSrc; }
                ctx.drawImage(drawable, -renderW/2, -renderH/2, renderW, renderH);
            }
            ctx.restore();
        });

        this.studio.project.tracks.forEach(track => {
            if (track.muted) return;
            const activeSubClips = track.clips.filter(c => 
                c.type === 'subtitle' && time >= c.start && time < (c.start + c.duration)
            );
            activeSubClips.forEach(clip => {
                this._renderSubtitleOverlay(ctx, clip, time, w, h);
            });
        });

        ctx.globalAlpha = 1;
        return new Promise(resolve => {
            ctx.canvas.toBlob(resolve, 'image/jpeg', 0.90);
        });
    }

    async _waitForMediaReady(visibleClips, globalTime) {
        const promises = [];
        visibleClips.forEach(({ clip, track }) => {
            const layer = this.trackLayers.get(track.id);
            if (!layer) return;

            const asset = this.studio.assetManager.getAsset(clip.assetId);
            if (!asset || asset.type === 'image') return; 

            const video = layer.videoEl;
            if (video.src !== asset.url) video.src = asset.url;

            const videoTime = clip.offset + (globalTime - clip.start);
            const needsSeek = Math.abs(video.currentTime - videoTime) > 0.01 || video.readyState < 2;

            if (needsSeek) {
                video.currentTime = videoTime;
                const p = new Promise(resolve => {
                    if (video.readyState >= 3 && Math.abs(video.currentTime - videoTime) < 0.01 && !video.seeking) { 
                        resolve(); return;
                    }
                    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
                    setTimeout(() => { video.removeEventListener('seeked', onSeeked); resolve(); }, 1000); 
                    video.addEventListener('seeked', onSeeked);
                });
                promises.push(p);
            }
        });
        await Promise.all(promises);
    }
}
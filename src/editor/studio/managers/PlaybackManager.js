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
        // Garante que o contexto de áudio e os GainNodes existam para o Preview
        this.prepareForRendering();

        // Salva o ponto onde o play começou
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
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

        // 1. Cria Nó de Monitoramento (se não existir)
        if (!this.monitorGain) {
            this.monitorGain = this.audioCtx.createGain();
            this.monitorGain.gain.value = 1; 
            this.monitorGain.connect(this.audioCtx.destination);
        }

        // 2. Cria Destino de Gravação
        if (!this.renderDestination) {
            this.renderDestination = this.audioCtx.createMediaStreamDestination();
        }

        // 3. Conecta cada track usando GainNodes individuais
        this.trackLayers.forEach((layer, trackId) => {
            // Processa tanto áudio quanto vídeo
            const mediaElements = [layer.audioEl, layer.audioEl2, layer.videoEl, layer.videoEl2];
            
            mediaElements.forEach(mediaEl => {
                if (!mediaEl) return;

                if (!mediaEl.crossOrigin) mediaEl.crossOrigin = "anonymous";
                
                // Inicializa SourceNode se necessário
                if (!mediaEl._sourceNode) {
                    try { mediaEl._sourceNode = this.audioCtx.createMediaElementSource(mediaEl); } catch(e){}
                }

                // Inicializa GainNode (NOVO: Controle de Volume Individual)
                if (!mediaEl._gainNode && mediaEl._sourceNode) {
                    mediaEl._gainNode = this.audioCtx.createGain();
                    
                    try { mediaEl._sourceNode.disconnect(); } catch(e){}
                    
                    // Rota: Elemento -> Gain -> Destinos
                    mediaEl._sourceNode.connect(mediaEl._gainNode);
                    mediaEl._gainNode.connect(this.renderDestination); // Para o arquivo
                    mediaEl._gainNode.connect(this.monitorGain);       // Para o ouvido
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
        const loop = () => {
            if (!this.isPlaying && !this.studio.renderManager.isRendering) return;
            this._drawCompositeFrame(ctx, w, h);
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    /**
     * Desenha o frame composto no Canvas.
     */
    _drawCompositeFrame(ctx, cvWidth, cvHeight) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, cvWidth, cvHeight);

        const tracksReversed = [...this.studio.project.tracks].reverse();
        const currentTime = this.studio.project.currentTime;

        tracksReversed.forEach(track => {
            if (track.muted || track.type !== 'video') return;
            
            const activeClips = track.clips.filter(c => currentTime >= c.start && currentTime < (c.start + c.duration))
                                           .sort((a, b) => a.start - b.start);

            if (activeClips.length === 0) return;

            const layer = this.trackLayers.get(track.id);
            if (!layer) return;

            activeClips.forEach(clip => {
                let domEl = null;
                const slotId = clip._assignedSlotId;

                // Tenta recuperar pelo Slot ID da memória
                if (slotId === 1) {
                    domEl = (clip.type === 'image') ? layer.imgEl : layer.videoEl;
                } else if (slotId === 2) {
                    domEl = (clip.type === 'image') ? layer.imgEl2 : layer.videoEl2;
                } else {
                    // Fallback: Busca no DOM (somente se a layer tiver elementos de vídeo)
                    if (layer.videoEl && (layer.videoEl.dataset.curId === clip.id || layer.imgEl.dataset.curId === clip.id)) {
                        domEl = (clip.type === 'image') ? layer.imgEl : layer.videoEl;
                    } else if (layer.videoEl2 && (layer.videoEl2.dataset.curId === clip.id || layer.imgEl2.dataset.curId === clip.id)) {
                        domEl = (clip.type === 'image') ? layer.imgEl2 : layer.videoEl2;
                    }
                }

                if (!domEl) return;
                
                // Validações de carregamento
                if (domEl.tagName === 'VIDEO' && domEl.readyState < 2) return;
                if (domEl.tagName === 'IMG' && domEl.naturalWidth === 0) return;

                ctx.save();
                
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
                    
                    try { 
                        ctx.drawImage(domEl, -dw/2, -dh/2, dw, dh); 
                    } catch(e) {}
                }
                ctx.restore();
            });
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
            const clips = this._getClipsAtTime(layer.trackId, time);
            this._syncAudioTrack(layer, clips, time);
        });
    }

    syncPreview() {
        // Garante que temos o container principal
        if (!this.container) {
            this.container = document.getElementById('studio-preview-canvas');
        }
        if (!this.container) return;

        const time = this.studio.project.currentTime;
        const tracks = this.studio.project.tracks;
        
        // 1. Limpeza de tracks removidas
        const validIds = new Set(tracks.map(t => t.id));
        for (const [id, layer] of this.trackLayers) {
            if (!validIds.has(id)) {
                if(layer.container) layer.container.remove();
                if(layer.audioEl) { layer.audioEl.pause(); layer.audioEl.src = ""; }
                if(layer.audioEl2) { layer.audioEl2.pause(); layer.audioEl2.src = ""; }
                this.trackLayers.delete(id);
            }
        }

        // 2. Criação e Sincronização
        tracks.forEach((track, idx) => {
            let layer = this.trackLayers.get(track.id);
            
            if (!layer) {
                layer = this._createTrackLayer(track);
                this.trackLayers.set(track.id, layer);
            }

            if (layer.container && !this.container.contains(layer.container)) {
                this.container.appendChild(layer.container);
            }

            if(layer.container) {
                layer.container.style.zIndex = tracks.length - idx;
            }

            const clips = this._getClipsAtTime(track.id, time);
            
            if(track.type === 'video') this._syncVideoTrack(layer, clips, time);
            else this._syncAudioTrack(layer, clips, time);
        });
        
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

        // 1. Cálculo do Alvo de Volume (Target)
        let alpha = clip.level !== undefined ? clip.level : (clip.opacity || 1);
        alpha *= this._calculateFadeFactor(clip, time);
        alpha = Math.max(0, Math.min(1, alpha));
        
        // Corte de ruído digital (Clean Silence)
        if (alpha < 0.001) alpha = 0;

        // 2. Visuais
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
            domEl.muted = clip.muted === true;

            if (domEl._gainNode && this.audioCtx) {
                const now = this.audioCtx.currentTime;
                
                try {
                    // Valor atual real do nó
                    const currentGain = domEl._gainNode.gain.value;
                    
                    // Só agenda se houver mudança perceptível (evita sobrecarga)
                    if (Math.abs(currentGain - alpha) > 0.0001) {
                        domEl._gainNode.gain.cancelScheduledValues(now);
                        domEl._gainNode.gain.setValueAtTime(currentGain, now);
                        
                        // Rampa suave de 30ms para o novo valor. 
                        // Suaviza qualquer "degrau" entre frames (De-zippering).
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
                if (localTime > (DURATION - EPSILON) && localTime < DURATION) {
                    localTime = DURATION - EPSILON;
                }
            }
            
            const needsSeek = this._forceSeek || 
                            Math.abs(domEl.currentTime - localTime) > 0.3 || 
                            domEl.ended;

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
            // Z-index inicial e pointer-events
            div.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;";
            
            // Slot 1
            const vid1 = document.createElement('video');
            vid1.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
            vid1.crossOrigin = "anonymous";
            const img1 = document.createElement('img');
            img1.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
            
            // Slot 2 (Crossfade)
            const vid2 = document.createElement('video');
            vid2.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
            vid2.crossOrigin = "anonymous";
            const img2 = document.createElement('img');
            img2.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";

            div.append(vid1, img1, vid2, img2);
            
            // Tenta anexar imediatamente se o container já existir
            if(this.container) this.container.appendChild(div);
            
            layer.container = div;
            layer.videoEl = vid1;
            layer.imgEl = img1;
            layer.videoEl2 = vid2;
            layer.imgEl2 = img2;
        } else {
            // Áudio (sem container visual)
            const aud1 = new Audio();
            aud1.crossOrigin = "anonymous";
            const aud2 = new Audio();
            aud2.crossOrigin = "anonymous";
            
            layer.audioEl = aud1;
            layer.audioEl2 = aud2;
        }
        return layer;
    }

    _syncVideoTrack(layer, clips, time) {
        // Slots disponíveis (Máx 2 simultâneos para crossfade)
        const slots = [
            { id: 1, video: layer.videoEl, image: layer.imgEl },
            { id: 2, video: layer.videoEl2, image: layer.imgEl2 }
        ];
        
        const usedSlotIds = new Set();

        // 1. Limpeza de Referências de Outras Trilhas
        // Se o clipe diz que tem um slot, mas o ID da trilha não bate com a atual, reseta.
        clips.forEach(clip => {
            if (clip._assignedSlotTrackId && clip._assignedSlotTrackId !== layer.trackId) {
                clip._assignedSlotId = null;
                clip._assignedSlotTrackId = null;
            }
        });

        // 2. Persistência (Manter onde está)
        clips.forEach(clip => {
            // Tenta achar onde o clipe JÁ está carregado no DOM desta trilha
            const domMatch = slots.find(s => 
                (s.video.dataset.curId === clip.id) || (s.image.dataset.curId === clip.id)
            );

            if (domMatch) {
                clip._assignedSlotId = domMatch.id;
                clip._assignedSlotTrackId = layer.trackId;
                usedSlotIds.add(domMatch.id);
            } 
            else if (clip._assignedSlotId) {
                // Se o clipe lembra do seu slot e ele está livre, mantém
                if (!usedSlotIds.has(clip._assignedSlotId)) {
                    usedSlotIds.add(clip._assignedSlotId);
                    clip._assignedSlotTrackId = layer.trackId;
                } else {
                    clip._assignedSlotId = null; // Perdeu o lugar, vai para realocação
                }
            }
        });

        // 3. Alocação (Preencher vagas)
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

        // 4. Renderização DOM (Aplica src, display, opacity)
        slots.forEach(slot => {
            const assignedClip = clips.find(c => c._assignedSlotId === slot.id);

            if (assignedClip) {
                const isImage = assignedClip.type === 'image';
                
                if (isImage) {
                    this._updateSingleMediaElement(slot.image, assignedClip, time, true);
                    this._updateSingleMediaElement(slot.video, null, time, false); // Limpa vídeo
                } else {
                    this._updateSingleMediaElement(slot.video, assignedClip, time, false);
                    this._updateSingleMediaElement(slot.image, null, time, true); // Limpa imagem
                }
            } else {
                // Slot vazio: Limpa tudo para evitar "fantasmas"
                this._updateSingleMediaElement(slot.image, null, time, true);
                this._updateSingleMediaElement(slot.video, null, time, false);
            }
        });
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

    /**
     * Calcula o fator de atenuação (0.0 a 1.0) baseado no Fade In/Out do clipe.
     * Usa uma curva senoidal (Ease-In-Out) para suavidade igual ao visual da timeline.
     */
    _calculateFadeFactor(clip, globalTime) {
        if (!clip) return 1;

        const timeInClip = globalTime - clip.start;
        const duration = clip.duration;
        // Garante números válidos
        const fadeIn = Number(clip.fadeIn) || 0;
        const fadeOut = Number(clip.fadeOut) || 0;

        let factorIn = 1.0;
        let factorOut = 1.0;

        // 1. Cálculo do Fade In (Curva Senoidal)
        if (fadeIn > 0) {
            if (timeInClip < 0) factorIn = 0; // Antes do inicio
            else if (timeInClip < fadeIn) {
                const progress = timeInClip / fadeIn;
                factorIn = 0.5 * (1 - Math.cos(progress * Math.PI));
            }
        }

        // 2. Cálculo do Fade Out (Curva Senoidal)
        if (fadeOut > 0) {
            const timeStartFadeOut = duration - fadeOut;
            if (timeInClip > duration) factorOut = 0; // Depois do fim
            else if (timeInClip > timeStartFadeOut) {
                const remaining = duration - timeInClip;
                const progress = remaining / fadeOut; // Vai de 1 a 0
                factorOut = 0.5 * (1 - Math.cos(progress * Math.PI));
            }
        }

        // A combinação é multiplicativa (Se estiver a entrar e sair ao mesmo tempo, aplica ambos)
        return Math.max(0, Math.min(1, factorIn * factorOut));
    }

    _syncAudioTrack(layer, clips, time) {
        const trackId = layer.trackId;
        
        // PRÉ-ANÁLISE: Detecta se há clips adjacentes formando crossfade na timeline
        const track = this.studio.project.tracks.find(t => t.id === trackId);
        let allClipsOnTrack = track ? track.clips : [];
        
        const updateAudio = (audioEl, clip, clipIndex) => {
            const EPSILON = 0.005;
            
            if(!audioEl) return;
            if (!clip) { 
                // Fade out suave antes de pausar
                if (audioEl._gainNode && this.audioCtx && !audioEl.paused) {
                    const now = this.audioCtx.currentTime;
                    try {
                        audioEl._gainNode.gain.cancelScheduledValues(now);
                        audioEl._gainNode.gain.setValueAtTime(audioEl._gainNode.gain.value, now);
                        audioEl._gainNode.gain.linearRampToValueAtTime(0, now + 0.08);
                        
                        setTimeout(() => {
                            if (!clip && !audioEl.paused) audioEl.pause();
                        }, 100);
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

            // Cálculo do Volume Base
            let vol = clip.level !== undefined ? clip.level : (clip.volume || 1);
            if(vol > 1) vol = vol/100;
            
            let fadeFactor = this._calculateFadeFactor(clip, time);
            
            // Verifica se há um clip anterior que está fazendo fade out sobre este
            const clipStart = clip.start;
            const clipEnd = clip.start + clip.duration;
            
            let hasLeftOverlap = false;
            let leftOverlapFade = 0;
            
            // Procura clip anterior que esteja sobreposto
            for (const otherClip of allClipsOnTrack) {
                if (otherClip.id === clip.id) continue;
                
                const otherEnd = otherClip.start + otherClip.duration;
                
                // Verifica se o outro clip termina dentro deste
                if (otherClip.start < clipStart && otherEnd > clipStart && otherEnd < clipEnd) {
                    // Há overlap à esquerda
                    hasLeftOverlap = true;
                    
                    // Se o tempo atual está na zona de overlap
                    if (time >= clipStart && time < otherEnd) {
                        const otherFade = this._calculateFadeFactor(otherClip, time);
                        leftOverlapFade = otherFade;
                    }
                    break;
                }
            }
            
            let normalizedFadeFactor = fadeFactor;
            
            if (hasLeftOverlap && leftOverlapFade > 0.01) {
                // Durante overlap: normaliza
                const totalFade = fadeFactor + leftOverlapFade;
                if (totalFade > 0.01) {
                    normalizedFadeFactor = fadeFactor / totalFade;
                }
            }
            
            vol *= normalizedFadeFactor;
            
            let finalVol = Math.max(0, Math.min(1, vol));
            if (finalVol < 0.0001) finalVol = 0;

            audioEl.muted = layer.muted || false;

            // Aplicação do Volume - Rampa MUITO suave
            if (audioEl._gainNode && this.audioCtx) {
                const now = this.audioCtx.currentTime;
                try {
                    const currentGain = audioEl._gainNode.gain.value;
                    
                    if (Math.abs(currentGain - finalVol) > 0.00001) {
                        audioEl._gainNode.gain.cancelScheduledValues(now);
                        audioEl._gainNode.gain.setValueAtTime(currentGain, now);
                        // Rampa de 100ms para máxima suavidade
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
                if (localTime > (DURATION - EPSILON) && localTime < DURATION) {
                    localTime = DURATION - EPSILON;
                }
            }

            const needsSeek = this._forceSeek || 
                            Math.abs(audioEl.currentTime - localTime) > 0.3;
            
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

        return track.clips.filter(c => time >= c.start && time < (c.start + c.duration))
                          .sort((a, b) => a.start - b.start); // Ordena por início para estabilidade
    }
}
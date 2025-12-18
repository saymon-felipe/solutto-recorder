import { getHeaderWidth } from '../utils.js'; 

const FPS = 30;

/**
 * TimelineManager
 * Gerencia a lógica da linha do tempo, incluindo:
 * - Manipulação de zoom e scroll
 * - Renderização da régua e trilhas (tracks)
 * - Lógica de seleção, movimentação e redimensionamento de clipes
 * - Precisão de frames (Frame-perfect snapping)
 */
export class TimelineManager {
    
    constructor(studio) {
        this.studio = studio;
        
        // Estado de Seleção e Foco
        this.selectedClips = [];
        this.lastFocusedClipId = null;
        this.isScrubbing = false;

        this._forceSeek = false;

        // Cache para virtualização da régua (Performance)
        this.rulerTicksData = []; 
        this.lastRenderedRange = { start: -1, end: -1 };

        this.pendingVisualTasks = 0;

        if (!this.studio.project.markers) {
            this.studio.project.markers = [];
        }

        this.clipboard = null;
    }

    init() {
        this._bindEvents();
        // Inicializa com um nível de zoom confortável
        this.setZoom(this.studio.project.zoom - 1);
    }

    // =========================================================================
    // EVENTOS GLOBAIS (Scroll, Zoom, Teclado)
    // =========================================================================

    _bindEvents() {
        const scrollArea = document.getElementById('studio-scroll-area');
        
        if (scrollArea) {
            scrollArea.addEventListener('scroll', () => {
                this._syncRuler(scrollArea.scrollLeft);
            });
            
            scrollArea.addEventListener('wheel', (e) => {
                e.preventDefault();
                const project = this.studio.project;
                
                let newZoom = Math.max(10, Math.min(project.zoom * (e.deltaY > 0 ? 0.9 : 1.1), 600));
                if (newZoom === project.zoom) return;

                const currentTime = project.currentTime;
                
                this.setZoom(newZoom);

                scrollArea.scrollLeft = (currentTime * newZoom) - (scrollArea.clientWidth / 2);
            });

            scrollArea.addEventListener('mousedown', (e) => {
                if (e.target.closest('.clip') || e.target.closest('.track-header') || e.target.closest('.timeline-marker')) return;
                
                this._startScrubbingInteraction(e);
            });
        }

        const playheadOverlay = document.getElementById('timeline-playhead-overlay');
        if (playheadOverlay) {
            playheadOverlay.addEventListener('mousedown', (e) => {
                e.preventDefault(); 
                e.stopPropagation();
                this._startScrubbingInteraction(e);
            });
        }

        const ruler = document.getElementById('timeline-ruler-container');
        if (ruler) {
            ruler.onmousedown = (e) => {
                if (e.button === 2) return; 
                if (e.target.closest('.timeline-marker')) return; 
                this._startScrubbingInteraction(e);
            };

            ruler.oncontextmenu = (e) => this._handleRulerContextMenu(e);
        }

        // Atalhos de Teclado
        document.addEventListener('keydown', (e) => {
            if (!this.studio.isActive) return;
            if (this.studio.renderManager && this.studio.renderManager.isRendering) {
                e.preventDefault(); e.stopPropagation(); return;
            }
            if (['INPUT', 'TEXTAREA'].includes(document.target?.tagName)) return;
            if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

            const isCtrl = e.ctrlKey || e.metaKey;
            
            if (isCtrl && !e.shiftKey && !e.altKey) {
                if (e.key.toLowerCase() === 'c') {
                    this.copySelection();
                }
                if (e.key.toLowerCase() === 'v') {
                    e.preventDefault(); 
                    this.pasteSelection();
                }
            }
            
            // Playback (Espaço)
            if (e.code === 'Space') { 
                e.preventDefault(); 
                this.studio.playbackManager.togglePlayback(); 
            }

            if (e.code === 'KeyM') {
                e.preventDefault();
                this.addMarker(this.studio.project.currentTime);
            }

            // Navegação Frame a Frame (Setas)
            if (e.code === 'ArrowLeft') { e.preventDefault(); this._stepPlayhead(-1); }
            if (e.code === 'ArrowRight') { e.preventDefault(); this._stepPlayhead(1); }

            // Comandos de Edição
            if (!e.ctrlKey && e.code === 'KeyS') this.splitClip();
            if (e.code === 'Delete') this.deleteClips();
            if (e.code === 'KeyG') this.groupClips();
            if (e.code === 'KeyU') this.ungroupClips();
        });
    }

    copySelection() {
        if (!this.selectedClips || this.selectedClips.length === 0) return;

        const selectionData = this.selectedClips.map(wrapper => {
            const realClip = wrapper.clip || wrapper; 
            const trackIndex = this.studio.project.tracks.findIndex(t => t.clips.some(c => c.id === realClip.id));
            
            return {
                clipData: JSON.parse(JSON.stringify(realClip)),
                trackIndex: trackIndex
            };
        });

        const validItems = selectionData.filter(i => i.trackIndex !== -1);

        if (validItems.length > 0) {
            const minStart = Math.min(...validItems.map(d => d.clipData.start));
            
            this.clipboard = {
                items: validItems,
                anchorTime: minStart
            };
            
            this.studio.uiManager.showToast(`${validItems.length} item(s) copiado(s)`);
            console.log("[DEBUG] Clipboard salvo com sucesso. Anchor:", minStart);
        } else {
            console.warn("[DEBUG] Falha ao copiar: Clipes não encontrados nas trilhas.");
        }
    }

    pasteSelection() {
        if (!this.clipboard || !this.clipboard.items || this.clipboard.items.length === 0) return;

        const playhead = this.studio.project.currentTime;
        const anchor = this.clipboard.anchorTime;
        
        if (isNaN(anchor)) {
            console.error("[DEBUG] Erro: AnchorTime é NaN. Abortando colar.");
            return;
        }

        const newSelection = [];
        this._clearSelection();

        const groupMapping = {};

        this.clipboard.items.forEach(item => {
            const gid = item.clipData.groupId;
            if (gid && !groupMapping[gid]) {
                groupMapping[gid] = "group_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
            }
        });

        this.clipboard.items.forEach(item => {
            const originalData = item.clipData;
            
            const offsetFromAnchor = originalData.start - anchor;
            const newStart = Math.max(0, playhead + offsetFromAnchor);

            let targetTrack = this.studio.project.tracks[item.trackIndex];
            
            if (!targetTrack) {
                targetTrack = this.studio.project.tracks.find(t => t.type === originalData.type) || this.studio.project.tracks[0];
            }

            if (targetTrack) {
                const newClip = JSON.parse(JSON.stringify(originalData));
                
                newClip.id = `clip_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
                newClip.start = newStart;
                
                if(newClip.selected) delete newClip.selected;

                if (originalData.groupId) {
                    newClip.groupId = groupMapping[originalData.groupId];
                }

                targetTrack.clips.push(newClip);
                newSelection.push({ clip: newClip, trackId: targetTrack.id });
            }
        });

        this.renderTracks(); 
        if(this.studio.playbackManager) this.studio.playbackManager.syncPreview();

        newSelection.forEach(entry => {
            this._addToSelection(entry.clip, entry.trackId);
        });

        this.studio.historyManager.recordState();
        console.log(`[Studio] Colado em ${playhead.toFixed(2)}s com novos grupos.`);
    }

    _ensureMarkerLayer() {
        let layer = document.getElementById('timeline-markers-layer');
        if (!layer) {
            const wrapper = document.getElementById('timeline-content-wrapper');
            const playhead = document.getElementById('timeline-playhead-overlay');
            
            if (wrapper && playhead) {
                layer = document.createElement('div');
                layer.id = 'timeline-markers-layer';
                
                layer.style.cssText = `
                    position: absolute;
                    top: 0; left: 0; width: 100%; height: 100%;
                    pointer-events: none; 
                    z-index: 90;
                `;

                wrapper.insertBefore(layer, playhead);
            }
        }
        return layer;
    }

    _startAutoScroll() {
        if (this._autoScrollTimer) return;
        
        const loop = () => {
            if (!this.isScrubbing) return;
            
            const scrollArea = document.getElementById('studio-scroll-area');
            if (scrollArea) {
                const rect = scrollArea.getBoundingClientRect();
                
                const edgeSize = 1; 
                
                const maxSpeed = 30;      // Velocidade máxima desejada
                const rampDistance = 100; // Quantos pixels o mouse precisa andar para atingir a velocidade máxima
                
                let scrollSpeed = 0;

                // Mouse na DIREITA
                if (this._lastMouseX > rect.right - edgeSize) {
                    const distance = this._lastMouseX - (rect.right - edgeSize);
                    
                    const intensity = Math.min(1, Math.max(0, distance / rampDistance));
                    
                    scrollSpeed = intensity * maxSpeed;
                    
                    if (scrollSpeed > 0 && scrollSpeed < 1) scrollSpeed = 1;
                } 
                // Mouse na ESQUERDA
                else if (this._lastMouseX < rect.left + edgeSize) {
                    const distance = (rect.left + edgeSize) - this._lastMouseX;
                    const intensity = Math.min(1, Math.max(0, distance / rampDistance));
                    
                    scrollSpeed = -(intensity * maxSpeed);
                    
                    if (scrollSpeed < 0 && scrollSpeed > -1) scrollSpeed = -1;
                }

                if (scrollSpeed !== 0) {
                    scrollArea.scrollLeft += scrollSpeed;
                    this._updateSeekFromMouse(this._lastMouseX); 
                }
            }
            
            this._autoScrollTimer = requestAnimationFrame(loop);
        };
        
        this._autoScrollTimer = requestAnimationFrame(loop);
    }

    _stopAutoScroll() {
        if (this._autoScrollTimer) {
            cancelAnimationFrame(this._autoScrollTimer);
            this._autoScrollTimer = null;
        }
    }

    _updateSeekFromMouse(clientX) {
        const ticks = document.querySelector('.ruler-ticks');
        if (!ticks) return;
        
        const rect = ticks.getBoundingClientRect();
        const mx = clientX - rect.left;
        const zoom = this.studio.project.zoom;
        
        // Tempo bruto baseado no mouse
        let rawTime = Math.max(0, mx / zoom);
        
        // --- LÓGICA DE SNAP MAGNÉTICO (MARCADORES) ---
        const markers = this.studio.project.markers || [];
        const SNAP_THRESHOLD_PX = 15; // Distância em pixels para o ímã ativar
        const thresholdSec = SNAP_THRESHOLD_PX / zoom;
        
        let snapped = false;
        let finalTime = rawTime;

        // Procura o marcador mais próximo
        let bestDist = Infinity;
        let bestMarker = null;

        for (const m of markers) {
            const dist = Math.abs(m.time - rawTime);
            if (dist < thresholdSec && dist < bestDist) {
                bestDist = dist;
                bestMarker = m;
            }
        }

        if (bestMarker) {
            finalTime = bestMarker.time;
            snapped = true;
            // Mostra a linha azul de snap para feedback visual
            const tracksContainer = document.getElementById('studio-tracks');
            const h = tracksContainer ? tracksContainer.scrollHeight : 500;
            this._updateSnapLine(finalTime, true, 0, h);
        } else {
            // Se não grudou em marcador, arredonda pro frame
            finalTime = this._snapToFrame(rawTime);
            this._updateSnapLine(0, false); // Esconde linha guia
        }

        this._seekToTime(finalTime);
    }

    // =========================================================================
    // LÓGICA DE TEMPO E FRAMES (Core Precision)
    // =========================================================================

    /**
     * Arredonda um tempo flutuante para o frame exato mais próximo.
     * Ex: 1.03333 -> 1.0333333 (Frame 31 no FPS 30)
     */
    _snapToFrame(time) {
        const frameIndex = Math.round(time * FPS);
        return frameIndex / FPS;
    }

    /**
     * Formata o tempo em HH:MM:SS;FF (Estilo SMPTE).
     */
    _fmtSMPTE(time) {
        const totalFrames = Math.round(time * FPS);
        
        const frames = totalFrames % FPS;
        const totalSeconds = Math.floor(totalFrames / FPS);
        const seconds = totalSeconds % 60;
        const minutes = Math.floor(totalSeconds / 60) % 60;
        const hours = Math.floor(totalSeconds / 3600);

        const pad = (n) => n.toString().padStart(2, '0');

        if (hours > 0) {
            return `${pad(hours)}:${pad(minutes)}:${pad(seconds)};${pad(frames)}`;
        }
        return `${pad(minutes)}:${pad(seconds)};${pad(frames)}`;
    }

    /**
     * Define os intervalos da régua baseados em FRAMES para precisão visual.
     */
    _getFrameIntervals(zoom) {
        // Zoom = pixels por segundo
        let majorFrames, minorFrames, showMinor;

        if (zoom >= 200) { 
            // Super Zoom: Mostra cada frame
            majorFrames = 5;  
            minorFrames = 1;  
            showMinor = true;
        } else if (zoom >= 100) {
            majorFrames = 15; // Meio segundo
            minorFrames = 5;  
            showMinor = true;
        } else if (zoom >= 50) {
            majorFrames = 30; // 1 segundo
            minorFrames = 15; // Meio segundo
            showMinor = true;
        } else if (zoom >= 20) {
            majorFrames = 30 * 5; // 5 segundos
            minorFrames = 30;     // 1 segundo
            showMinor = true;
        } else {
            majorFrames = 30 * 10; // 10 segundos
            minorFrames = 30 * 5;  // 5 segundos
            showMinor = true;
        }

        return { majorFrames, minorFrames, showMinor };
    }

    // =========================================================================
    // CONTROLE DA AGULHA (PLAYHEAD)
    // =========================================================================

    updatePlayheadPosition() {
        const currentTime = this.studio.project.currentTime;
        const zoom = this.studio.project.zoom || 10;
        
        const position = (currentTime * zoom);
        
        const playhead = document.getElementById('studio-playhead');
        const line = document.getElementById('studio-playhead-line');
        
        if (playhead) playhead.style.left = `${position}px`;
        if (line) line.style.left = `${position}px`;
        
        if (this.studio.playbackManager && this.studio.playbackManager.isPlaying) {
             this._autoScrollPlayback(position);
        }
    }

    _autoScrollPlayback(pos) {
        const area = document.getElementById('studio-scroll-area');
        if (area) {
            // Se a agulha sair da tela pela direita
            if (pos > area.scrollLeft + area.clientWidth) {
                // Avança uma página
                area.scrollLeft = pos - 100; 
            }
        }
    }

    _stepPlayhead(direction) {
        const currentFrame = Math.round(this.studio.project.currentTime * FPS);
        const newFrame = currentFrame + direction;
        const newTime = Math.max(0, newFrame / FPS);
        
        this._seekToTime(newTime);
        this._ensurePlayheadVisible();
    }

    _seekToTime(time) {
        this.studio.project.currentTime = time;
        
        if (this.studio.playbackManager.isPlaying) {
            this.studio.playbackManager.lastPlayStartTime = time;
        }
        
        if (this.studio.playbackManager) {
            this.studio.playbackManager._forceSeek = true;
        }
        
        this.studio.playbackManager.updatePlayhead();
        this.studio.playbackManager.syncPreview();
        this.lastSeekTime = time; 
        this.playedSinceLastSeek = false;
    }

    /**
     * Inicia a lógica de Scrubbing (Arrastar Agulha) com Auto-Scroll.
     * Pode ser chamado pela Régua ou pelas Lanes.
     */
    _startScrubbingInteraction(initialEvent) {
        if (this.studio.renderManager && this.studio.renderManager.isRendering) return;

        // Impede que o clique no knob propague e cause comportamentos estranhos
        if(initialEvent.stopPropagation) initialEvent.stopPropagation();

        this.isScrubbing = true;
        this._lastMouseX = initialEvent.clientX; 
        
        this._startAutoScroll();
        this._updateSeekFromMouse(initialEvent.clientX);

        const onMove = (mv) => {
            // Previne seleção de texto enquanto arrasta
            mv.preventDefault(); 
            this._lastMouseX = mv.clientX;
            this._updateSeekFromMouse(mv.clientX);
        };
        
        const onUp = (upEvent) => {
            this.isScrubbing = false;
            this._stopAutoScroll();
            
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            
            this._updateSeekFromMouse(upEvent.clientX);
            this.studio.historyManager.recordState();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    _ensurePlayheadVisible() {
        const scrollArea = document.getElementById('studio-scroll-area');
        if (!scrollArea) return;

        // Posição da agulha em pixels (relativa ao início da timeline)
        const playheadPos = (this.studio.project.currentTime * this.studio.project.zoom);
        
        const startVisible = scrollArea.scrollLeft;
        const endVisible = startVisible + scrollArea.clientWidth;
        const buffer = 150; 

        // Se a agulha está à ESQUERDA da visão
        if (playheadPos < startVisible) {
            scrollArea.scrollLeft = Math.max(0, playheadPos - buffer);
        } 
        // Se a agulha está à DIREITA da visão
        else if (playheadPos > endVisible) {
            scrollArea.scrollLeft = playheadPos - scrollArea.clientWidth + buffer;
        }
    }

    _autoScrollTimeline(pos) {
        const area = document.getElementById('studio-scroll-area');
        if (area) {
            if (pos > area.scrollLeft + area.clientWidth) {
                area.scrollLeft = pos - 100;
            }
        }
    }

    // =========================================================================
    // SELEÇÃO E GRUPOS
    // =========================================================================

    groupClips() {
        if (this.selectedClips.length < 2) return;
        
        const newGroupId = "group_" + Date.now();

        this.studio.historyManager.recordState();

        this.selectedClips.forEach(selection => selection.clip.groupId = newGroupId);
        
        console.log("Clips vinculados:", newGroupId);

        this.studio.markUnsavedChanges();
        
        this.renderTracks(); 
    }

    ungroupClips() {
        if (this.selectedClips.length === 0) return;
        
        const clipToSelect = this.selectedClips[0]; 
        
        this.selectedClips.forEach(selection => selection.clip.groupId = null);

        this.studio.historyManager.recordState();
        
        this._clearSelection();
        if (clipToSelect) {
            this._addToSelection(clipToSelect.clip, clipToSelect.trackId);
        }

        this.studio.markUnsavedChanges();
        
        this.renderTracks();
    }

    _handleSelection(e, clip, trackId, el) {
        this.lastFocusedClipId = clip.id;
        const alreadySelected = this.selectedClips.some(s => s.clip.id === clip.id);
        
        let hasChanged = false;

        if (e.ctrlKey) {
            if (alreadySelected) {
                this._removeFromSelection(clip.id);
                if (clip.groupId) this._deselectGroup(clip.groupId);
                hasChanged = true;
            } else {
                this._addToSelection(clip, trackId, el);
                if (clip.groupId) this._selectGroup(clip.groupId);
                hasChanged = true;
            }
        } else {
            if (!alreadySelected || this.selectedClips.length > 1) {
                if (!alreadySelected) {
                    this._clearSelection();
                    this._addToSelection(clip, trackId, el);
                    if (clip.groupId) this._selectGroup(clip.groupId);
                    hasChanged = true;
                } else if (this.selectedClips.length > 1 && !e.shiftKey && !e.ctrlKey) {
                    this._clearSelection();
                    this._addToSelection(clip, trackId, el);
                    if (clip.groupId) this._selectGroup(clip.groupId);
                    hasChanged = true;
                }
            }
        }

        if (hasChanged) {
            this.studio.historyManager.recordState();
        }
    }

    _addToSelection(clip, trackId, domElement = null) {
        if (!this.selectedClips.some(s => s.clip.id === clip.id)) {
            this.selectedClips.push({ clip, trackId });
            const el = domElement || this._findDomElement(clip.id);
            if (el) {
                el.classList.add('selected');
                el.style.borderColor = '#2196F3';
            }
        }
    }

    _removeFromSelection(clipId) {
        const domEl = this._findDomElement(clipId);
        if (domEl) {
            domEl.classList.remove('selected');
            domEl.style.borderColor = 'transparent';
        }
        this.selectedClips = this.selectedClips.filter(s => s.clip.id !== clipId);
    }

    _selectGroup(groupId) {
        this.studio.project.tracks.forEach(track => {
            track.clips.forEach(c => {
                if (c.groupId === groupId && !this.selectedClips.some(s => s.clip.id === c.id)) {
                    const domEl = this._findDomElement(c.id);
                    this._addToSelection(c, track.id, domEl);
                }
            });
        });
    }

    _deselectGroup(groupId) {
        const groupItems = this.selectedClips.filter(s => s.clip.groupId === groupId);
        groupItems.forEach(item => this._removeFromSelection(item.clip.id));
    }

    _clearSelection() {
        this.selectedClips.forEach(s => {
            const domEl = this._findDomElement(s.clip.id);
            if(domEl) {
                domEl.classList.remove('selected');
                domEl.style.borderColor = 'transparent'; 
            }
        });
        this.selectedClips = [];
    }

    _findDomElement(clipId) {
        return document.querySelector(`.clip[data-clip-id="${clipId}"]`);
    }

    // =========================================================================
    // RENDERIZAÇÃO (Régua e Tracks)
    // =========================================================================

    setZoom(newZoom) {
        this.studio.project.zoom = Math.max(1, Math.min(newZoom, 600));
        const slider = document.getElementById('studio-zoom-slider');
        if (slider) slider.value = this.studio.project.zoom;
        
        this.renderRuler();
        this.renderTracks();
        this.renderMarkers(); 
        this.studio.playbackManager.updatePlayhead();
    }

    _getMaxTimelineTime() {
        let maxTime = this.studio.project.duration;
        this.studio.project.tracks.forEach(track => {
            track.clips.forEach(clip => {
                const clipEnd = clip.start + clip.duration;
                if (clipEnd > maxTime) maxTime = clipEnd;
            });
        });
        return Math.max(maxTime + 20, this.studio.project.duration + 20);
    }

    _syncRuler(scrollLeft) {
        const rulerContainer = document.getElementById('timeline-ruler-container');
        if (rulerContainer) {
            const ticks = rulerContainer.querySelector('.ruler-ticks');
            if(ticks) {
                ticks.style.transform = `translateX(-${scrollLeft}px)`;
                this._renderVisibleTicks(scrollLeft, rulerContainer.clientWidth);
            }
            
            // Sincroniza a camada de conectores dentro da régua
            const rulerConnectors = document.getElementById('timeline-ruler-marker-layer');
            if (rulerConnectors) {
                rulerConnectors.style.transform = `translateX(-${scrollLeft}px)`;
            }
        }

        // Sincroniza a faixa de cabeças superior
        const markerTrack = document.getElementById('timeline-marker-track');
        if (markerTrack) {
            markerTrack.style.transform = `translateX(-${scrollLeft}px)`;
        }
    }

    _ensureRulerMarkerLayer() {
        let layer = document.getElementById('timeline-ruler-marker-layer');
        if (!layer) {
            const container = document.getElementById('timeline-ruler-container');
            if (container) {
                layer = document.createElement('div');
                layer.id = 'timeline-ruler-marker-layer';
                layer.style.cssText = `
                    position: absolute;
                    top: 0; left: 0; height: 100%; width: 100%;
                    pointer-events: none;
                    z-index: 5; /* Atrás dos números da régua, mas visível */
                `;
                // Insere como primeiro filho para ficar no fundo
                container.insertBefore(layer, container.firstChild);
            }
        }
        return layer;
    }

    renderRuler() {
        const container = document.querySelector('.ruler-ticks');
        if (!container) return;
        
        const zoom = this.studio.project.zoom;
        let maxTime = this.studio.project.duration;
        
        // Garante que a timeline cubra todos os clips
        this.studio.project.tracks.forEach(track => {
            track.clips.forEach(clip => {
                const clipEnd = clip.start + clip.duration;
                if (clipEnd > maxTime) maxTime = clipEnd;
            });
        });
        maxTime = maxTime + 60; // Buffer
        const totalWidth = maxTime * zoom;
        
        container.style.minWidth = totalWidth + "px";
        container.style.width = totalWidth + "px";
        
        // Obtém intervalos em FRAMES
        const { majorFrames, minorFrames, showMinor } = this._getFrameIntervals(zoom);
        
        this.rulerTicksData = [];
        let currentFrame = 0;
        const maxFrames = maxTime * FPS;

        while (currentFrame <= maxFrames) {
            const timeInSec = currentFrame / FPS;
            const pos = timeInSec * zoom;
            
            // É um tick maior?
            if (currentFrame % majorFrames === 0) {
                this.rulerTicksData.push({
                    type: 'major',
                    left: pos,
                    label: this._fmtSMPTE(timeInSec)
                });
            } else if (showMinor && (currentFrame % minorFrames === 0)) {
                this.rulerTicksData.push({
                    type: 'minor',
                    left: pos,
                    label: null
                });
            }

            const step = showMinor ? minorFrames : majorFrames;
            currentFrame += step;
        }
        
        this.lastRenderedRange = { start: -1, end: -1 };
        container.innerHTML = '';
        
        const scrollArea = document.getElementById('studio-scroll-area');
        const initialScroll = scrollArea ? scrollArea.scrollLeft : 0;
        const viewportWidth = scrollArea ? scrollArea.clientWidth : window.innerWidth;
        
        this._renderVisibleTicks(initialScroll, viewportWidth);
    }
    
    _renderVisibleTicks(scrollLeft, viewportWidth) {
        const container = document.querySelector('.ruler-ticks');
        if(!container) return;

        const buffer = 300; 
        const startX = scrollLeft - buffer;
        const endX = scrollLeft + viewportWidth + buffer;
        
        const visibleTicks = this.rulerTicksData.filter(tick => tick.left >= startX && tick.left <= endX);
        const fragment = document.createDocumentFragment();
        
        container.innerHTML = ''; 
        visibleTicks.forEach(tick => {
            const el = document.createElement('div');
            el.className = `tick ${tick.type}`;
            el.style.left = tick.left + "px";
            if (tick.label) el.innerText = tick.label;
            fragment.appendChild(el);
        });
        
        container.appendChild(fragment);
    }

    addMarker(time) {
        if (!this.studio.project.markers) this.studio.project.markers = [];
        
        const marker = {
            id: 'marker_' + Date.now(),
            time: time,
            name: 'Marcador',
            color: '#ff9800'
        };

        this.studio.project.markers.push(marker);
        this.studio.project.markers.sort((a, b) => a.time - b.time);

        this.studio.markUnsavedChanges();
        this.renderMarkers();
        this.studio.historyManager.recordState();
    }

    deleteMarker(markerId) {
        if (!this.studio.project.markers) return;
        this.studio.project.markers = this.studio.project.markers.filter(m => m.id !== markerId);
        
        this.studio.markUnsavedChanges();
        this.renderMarkers(); 
        this.studio.historyManager.recordState();
    }

    updateMarkerName(markerId, newName) {
        if (!this.studio.project.markers) return;
        
        const marker = this.studio.project.markers.find(m => m.id === markerId);
        if (marker && marker.name !== newName) {
            marker.name = newName;
            this.studio.markUnsavedChanges();
            
            this.renderMarkers(); 
            this.studio.historyManager.recordState();
        }
    }

    renderMarkers() {
        // Layers: Linha (Fundo), Conector (Régua), Cabeça (Topo)
        const lineLayer = this._ensureMarkerLayer(); 
        const connectorLayer = this._ensureRulerMarkerLayer();
        const headLayer = document.getElementById('timeline-marker-track');

        if (!lineLayer || !headLayer || !this.studio.project.markers) return;

        lineLayer.innerHTML = ''; 
        headLayer.innerHTML = '';
        if (connectorLayer) connectorLayer.innerHTML = '';
        
        const zoom = this.studio.project.zoom;
        
        this.studio.project.markers.sort((a, b) => a.time - b.time);

        this.studio.project.markers.forEach((marker, index) => {
            const pos = marker.time * zoom;

            // --- LINHA PRINCIPAL ---
            const lineEl = document.createElement('div');
            lineEl.className = 'timeline-marker-line';
            lineEl.style.cssText = `
                position: absolute; left: ${pos}px; top: 0; bottom: 0; width: 1px;
                z-index: 100; pointer-events: none;
                background-color: ${marker.color}; opacity: 0.5;
            `;
            lineLayer.appendChild(lineEl);

            // --- CONECTOR ---
            if (connectorLayer) {
                const connEl = document.createElement('div');
                connEl.style.cssText = `
                    position: absolute; left: ${pos}px; top: 0; bottom: 0; width: 1px;
                    background-color: ${marker.color}; opacity: 0.5;
                `;
                connectorLayer.appendChild(connEl);
            }

            // --- CABEÇA ---
            const headEl = document.createElement('div');
            headEl.className = 'timeline-marker-head';
            headEl.dataset.markerId = marker.id; 
            
            headEl.style.cssText = `
                position: absolute;
                left: ${pos}px; 
                bottom: 0;      
                background-color: ${marker.color};
                padding: 2px 6px;
                border-radius: 0 4px 4px 0; 
                font-size: 10px;
                color: #fff;
                font-weight: 700;
                min-width: 16px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                box-shadow: 1px 1px 3px rgba(0,0,0,0.5);
                border: 1px solid rgba(255,255,255,0.2);
                border-left: none; 
                user-select: none;
                pointer-events: auto; 
                z-index: 110;
                white-space: nowrap;
                transform: translateX(120px);
            `;
            
            headEl.title = `${marker.name} (Botão Dir. para opções)`;
            
            // Label
            const span = document.createElement('span');
            if (marker.name === 'Marcador') {
                span.innerText = index + 1;
            } else {
                span.innerText = marker.name;
            }
            span.style.pointerEvents = 'none';
            headEl.appendChild(span);

            // Input Inline
            const input = document.createElement('input');
            input.type = "text";
            input.value = marker.name; 
            input.style.cssText = `
                display: none;
                width: 100px;
                background: #333;
                color: #fff;
                border: 1px solid ${marker.color};
                border-radius: 2px;
                font-size: 10px;
                padding: 0 4px;
                margin-left: 2px;
                outline: none;
                pointer-events: auto;
            `;
            
            const saveName = () => {
                const newName = input.value.trim();
                input.style.display = 'none';
                span.style.display = 'inline';
                headEl.style.minWidth = '16px';
                headEl.style.zIndex = '110';

                if (newName && newName !== marker.name) {
                    this.updateMarkerName(marker.id, newName);
                } else {
                    input.value = marker.name; 
                }
            };

            input.onblur = saveName;
            input.onkeydown = (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
                ev.stopPropagation(); 
            };
            input.onmousedown = (ev) => ev.stopPropagation(); 

            headEl.appendChild(input);

            // --- EVENTOS ---

            headEl.oncontextmenu = (e) => {
                e.preventDefault(); 
                e.stopPropagation();
                this._handleMarkerContextMenu(e, marker, input, span, headEl);
                return false;
            };

            headEl.onmousedown = (e) => {
                if (e.button !== 0 || input.style.display === 'block') { 
                    e.stopPropagation(); return; 
                }
                
                e.preventDefault();
                e.stopPropagation();

                this._seekToTime(marker.time);

                const startX = e.clientX;
                const initialTime = marker.time;
                let isDragging = false;

                const onMove = (ev) => {
                    const deltaX = ev.clientX - startX;
                    if (Math.abs(deltaX) > 2) isDragging = true;

                    const deltaSec = deltaX / zoom;
                    
                    // Calcula o tempo bruto e aplica a função de snap
                    const rawTime = Math.max(0, initialTime + deltaSec);
                    const snappedTime = this._snapToFrame(rawTime);
                    
                    marker.time = snappedTime;
                    
                    // Atualiza Visualmente (Agora "pulando" de frame em frame)
                    const newPos = snappedTime * zoom;
                    headEl.style.left = `${newPos}px`;
                    lineEl.style.left = `${newPos}px`;
                    if (connectorLayer && connectorLayer.lastChild) {
                        const conn = connectorLayer.children[index];
                        if(conn) conn.style.left = `${newPos}px`;
                    }
                    
                    // Formata com frames (;FF)
                    headEl.title = `${this._fmtSMPTE(snappedTime)}`;
                };

                const onUp = () => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    
                    if (isDragging) {
                        this.studio.project.markers.sort((a, b) => a.time - b.time);
                        this.renderMarkers(); 
                        this.studio.markUnsavedChanges();
                        this.studio.historyManager.recordState();
                    }
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            };

            headLayer.appendChild(headEl);
        });
    }

    _handleMarkerContextMenu(e, marker, inputElement, spanElement, headElement) {
        this._closeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'studio-context-menu dropdown-content-header show'; 
        
        const rect = headElement.getBoundingClientRect();
        
        menu.style.cssText = `
            position: fixed;
            left: ${rect.left}px;
            top: ${rect.bottom + 5}px;
            background: rgb(42, 42, 42);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            border-radius: 4px;
            padding: 5px 0;
            min-width: 140px;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            animation: fadeIn 0.1s ease-out;
        `;

        const titleItem = document.createElement('div');
        titleItem.style.cssText = "padding: 5px 15px; font-size: 10px; color: #888; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 2px;";
        titleItem.innerText = `Marcador: ${marker.name}`;
        menu.appendChild(titleItem);

        const btnRename = document.createElement('a');
        btnRename.href = "#";
        btnRename.innerHTML = `<i class="fa-solid fa-pen" style="width:20px; color:#aaa;"></i> Renomear`;
        btnRename.style.cssText = `display: flex; align-items: center; padding: 8px 15px; color: #e0e0e0; text-decoration: none; font-size: 12px; font-family: 'Segoe UI', sans-serif; cursor: pointer;`;
        btnRename.onmouseenter = () => btnRename.style.background = "#555";
        btnRename.onmouseleave = () => btnRename.style.background = "transparent";
        
        btnRename.onclick = (ev) => {
            ev.preventDefault();
            this._closeContextMenu();
            
            // Prepara UI para edição
            spanElement.style.display = 'none';
            inputElement.style.display = 'block';
            inputElement.value = marker.name; 
            
            headElement.style.minWidth = '110px';
            headElement.style.zIndex = '1000';
            
            inputElement.focus();
            inputElement.select();
        };

        const btnDelete = document.createElement('a');
        btnDelete.href = "#";
        btnDelete.innerHTML = `<i class="fa-solid fa-trash" style="width:20px; color:#ff5252;"></i> Excluir`;
        btnDelete.style.cssText = `display: flex; align-items: center; padding: 8px 15px; color: #ff9e9e; text-decoration: none; font-size: 12px; font-family: 'Segoe UI', sans-serif; cursor: pointer;`;
        btnDelete.onmouseenter = () => btnDelete.style.background = "#555";
        btnDelete.onmouseleave = () => btnDelete.style.background = "transparent";
        
        btnDelete.onclick = (ev) => {
            ev.preventDefault();
            this.deleteMarker(marker.id);
            this._closeContextMenu();
        };

        menu.appendChild(btnRename);
        menu.appendChild(btnDelete);
        document.body.appendChild(menu);

        setTimeout(() => {
            document.addEventListener('click', this._closeContextMenuBind);
            document.addEventListener('contextmenu', this._closeContextMenuBind); 
        }, 0);
    }

    _handleRulerContextMenu(e) {
        e.preventDefault();
        
        // Calcula o tempo baseado na posição do mouse
        const rulerRect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rulerRect.left + e.currentTarget.parentElement.scrollLeft;
        const time = Math.max(0, clickX / this.studio.project.zoom);

        this._closeContextMenu();

        // Cria o menu flutuante
        const menu = document.createElement('div');
        menu.className = 'studio-context-menu dropdown-content-header show'; 
        
        menu.style.cssText = `
            position: fixed;
            left: ${e.clientX}px;
            top: ${e.clientY}px;
            background: rgb(42, 42, 42);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            border-radius: 4px;
            padding: 5px 0;
            min-width: 150px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            animation: fadeIn 0.1s ease-out;
        `;

        // Item "Adicionar Marcador"
        const btnAdd = document.createElement('a');
        btnAdd.href = "#";
        btnAdd.innerHTML = `<i class="fa-solid fa-location-dot" style="color:#ff9800; width:20px;"></i> Adicionar Marcador`;
        btnAdd.style.cssText = `
            display: flex; align-items: center; 
            padding: 8px 15px; 
            color: #e0e0e0; 
            text-decoration: none; 
            font-size: 12px;
            font-family: 'Segoe UI', sans-serif;
            transition: background 0.2s;
        `;
        
        btnAdd.onmouseenter = () => btnAdd.style.background = "#555";
        btnAdd.onmouseleave = () => btnAdd.style.background = "transparent";
        
        btnAdd.onclick = (ev) => {
            ev.preventDefault();
            this.addMarker(time);
            this._closeContextMenu();
        };

        menu.appendChild(btnAdd);
        document.body.appendChild(menu);

        // Fecha ao clicar fora
        setTimeout(() => {
            document.addEventListener('click', this._closeContextMenuBind);
            document.addEventListener('contextmenu', this._closeContextMenuBind); 
        }, 0);
    }

    /**
     * Garante que a estrutura do DOM esteja configurada para o layout de duas colunas.
     * Cria a sidebar se não existir e ajusta margens.
     */
    _ensureLayoutStructure() {
        const timelineEl = document.getElementById("studio-timeline-el");
        const scrollArea = document.getElementById("studio-scroll-area");
        const rulerContainer = document.getElementById("timeline-ruler-container");
        
        if (!timelineEl || !scrollArea) return null;

        // Largura da Sidebar
        const headerWidth = getHeaderWidth(); 

        // 1. Cria ou Busca o Container da Sidebar (Esquerda)
        let sidebar = document.getElementById("studio-sidebar-container");
        if (!sidebar) {
            sidebar = document.createElement("div");
            sidebar.id = "studio-sidebar-container";
            
            // Estilo da Sidebar Principal (Container Geral)
            sidebar.style.cssText = `
                position: absolute;
                left: 0;
                top: 0;
                bottom: 0;
                width: ${headerWidth}px;
                background:rgb(42, 42, 42);
                border-right: 1px solid rgba(255, 255, 255, 0.1);;
                z-index: 102;
                display: flex;
                flex-direction: column;
            `;
            
            // Sub-container para o Botão de Adicionar (Topo, altura da régua)
            const sidebarTop = document.createElement("div");
            sidebarTop.id = "studio-sidebar-top";
            sidebarTop.style.cssText = `
                height: 24px; 
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                background: rgb(42, 42, 42);
                flex-shrink: 0;
                transform: translateY(24px);
                z-index: 104;
            `;
            
            // Sub-container para a Lista de Headers (Scrollável, mas sem barra visível)
            const sidebarList = document.createElement("div");
            sidebarList.id = "studio-sidebar-list";
            sidebarList.style.cssText = `
                flex: 1;
                overflow: hidden; 
                position: relative;
                background: rgb(42, 42, 42);
                padding-top: 25px;
            `;

            sidebar.appendChild(sidebarTop);
            sidebar.appendChild(sidebarList);
            timelineEl.insertBefore(sidebar, timelineEl.firstChild);

            // 2. Ajusta Margens do Conteúdo Principal (Direita) para não ficar embaixo da sidebar
            if (rulerContainer) {
                rulerContainer.style.marginLeft = `${headerWidth}px`;
                // Esconde o spacer antigo se existir
                const oldSpacer = rulerContainer.querySelector('.ruler-header-spacer');
                if (oldSpacer) oldSpacer.style.display = 'none';
            }
            scrollArea.style.marginLeft = `${headerWidth}px`; // Empurra as tracks
            
            // 3. Sincronia de Scroll Vertical
            // Quando rolar as tracks, rola os headers junto.
            scrollArea.addEventListener('scroll', () => {
                sidebarList.scrollTop = scrollArea.scrollTop;
            });
        }
        
        return sidebar;
    }

    renderTracks() {
        // 1. Prepara o Layout Físico
        const sidebar = this._ensureLayoutStructure();
        if (!sidebar) return;

        const sidebarTop = document.getElementById("studio-sidebar-top");
        const sidebarList = document.getElementById("studio-sidebar-list");
        const tracksContainer = document.getElementById("studio-tracks"); // Container das Lanes

        if (!sidebarList || !tracksContainer) return;

        // Limpa containers
        sidebarList.innerHTML = "";
        tracksContainer.innerHTML = "";

        // 2. Renderiza Botão Add Track (No topo da sidebar)
        this._renderAddTrackButton(sidebarTop);

        // Ajusta largura do wrapper de conteúdo
        const maxTime = this._getMaxTimelineTime();
        const totalWidth = (maxTime * this.studio.project.zoom) + 500;
        const wrapper = document.getElementById('timeline-content-wrapper');
        if(wrapper) wrapper.style.width = totalWidth + "px";

        // 3. Renderiza Listas Separadas (Headers vs Lanes)
        this.studio.project.tracks.forEach((track, index) => {
            
            // --- A. Renderiza HEADER (Na Sidebar) ---
            const headerEl = document.createElement("div");
            headerEl.className = "track-header-wrapper";
            // Altura fixa ou min-height é importante para sincronia
            headerEl.style.cssText = `
                height: 100px; /* Altura da Track */
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                box-sizing: border-box;
                display: flex;
                align-items: center;
                padding: 0 10px;
                background: rgb(42, 42, 42);
            `;
            
            headerEl.innerHTML = `
                <div class="track-header" draggable="true" style="width:100%; display:flex; align-items:center; gap:10px;">
                    <div class="drag-handle" style="cursor:grab; color:#999;"><i class="fa-solid fa-bars"></i></div>
                    <input type="text" class="track-name-input" title="${track.name}" value="${track.name}" style="flex:1; border:1px solid transparent; background:transparent;" />
                    <div class="track-type-icon"><i class="fa-solid ${track.type==='video'?'fa-video':'fa-volume-high'}"></i></div>
                </div>
            `;

            // Eventos do Header
            const headerContent = headerEl.querySelector(".track-header");
            const nameInput = headerEl.querySelector(".track-name-input");
            
            headerContent.oncontextmenu = (e) => this._handleTrackContextMenu(e, track);
            nameInput.onchange = (e) => { track.name = e.target.value; };
            nameInput.onmousedown = (e) => e.stopPropagation();
            this._bindTrackReorderEvents(headerContent, index);

            sidebarList.appendChild(headerEl);

            const laneEl = document.createElement("div");
            laneEl.className = `track-lane-wrapper track ${track.type}`; 
            laneEl.dataset.trackId = track.id;
            
            laneEl.style.cssText = `
                height: 100px; 
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                box-sizing: border-box;
                position: relative;
                width: 100%;
            `;

            // Área interna onde os clipes vivem
            const innerLane = document.createElement("div");
            innerLane.className = "track-lane";
            innerLane.style.cssText = "width: 100%; height: 100%; position: relative;";
            
            this._bindLaneEvents(innerLane, track);

            // Renderiza Clipes
            track.clips.forEach(clip => {
                const clipEl = this._createClipElement(clip, track.id);
                if (track.type !== 'audio' && ['video', 'image', 'subtitle'].includes(clip.type)) {
                     const btnPan = document.createElement('div');
                     btnPan.className = 'clip-tool-btn pan-crop-btn';
                     btnPan.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
                     btnPan.style.cssText = `position: absolute; bottom: 2px; right: 2px; width: 20px; height: 20px; background: rgba(0,0,0,0.7); color: white; border-radius: 3px; display: flex; align-items: center; justify-content: center; font-size: 10px; cursor: pointer; z-index: 100;`;
                     btnPan.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); this.studio.uiManager.openPanCropModal(clip); };
                     clipEl.appendChild(btnPan);
                }
                innerLane.appendChild(clipEl);
            });

            laneEl.appendChild(innerLane);
            tracksContainer.appendChild(laneEl);
        });
        
        this.renderRuler(); // Atualiza régua
        this._renderCrossfadeGuides(); // Atualiza guias
        
        // Garante sincronia inicial
        if (sidebarList && document.getElementById('studio-scroll-area')) {
            sidebarList.scrollTop = document.getElementById('studio-scroll-area').scrollTop;
        }
    }

    /**
     * Renderiza o fundo lateral fixo (Sidebar Background).
     * Ele é anexado ao container principal da timeline para ficar independente do scroll horizontal,
     * mas deve respeitar a altura do conteúdo.
     */
    _renderSidebarBackground() {
        const timelineEl = document.getElementById('studio-timeline-el');
        if (!timelineEl) return;

        const existingBg = timelineEl.querySelector('.timeline-sidebar-bg');
        if (existingBg) existingBg.remove();

        const bg = document.createElement('div');
        bg.className = 'timeline-sidebar-bg';
        
        const headerWidth = getHeaderWidth(); 
        
        bg.style.cssText = `
            position: absolute;
            left: 0;
            top: 0; 
            bottom: 0;
            width: ${headerWidth}px;
            background: rgb(30, 30, 30);
            border-bottom: 1px solid rgb(51, 51, 51);
            z-index: 103; 
            pointer-events: none;
        `;

        // Inserimos no início do container da timeline
        timelineEl.insertBefore(bg, timelineEl.firstChild);
    }

    // =========================================================================
    // CONTEXT MENU (Botão Direito)
    // =========================================================================

    _handleTrackContextMenu(e, track) {
        e.preventDefault(); 

        this._closeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'studio-context-menu';
        
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        menu.innerHTML = `
            <div class="ctx-menu-item disabled" style="opacity:0.6; cursor:default;">
                <i class="fa-solid fa-layer-group"></i> ${track.name}
            </div>
            <div class="ctx-menu-divider"></div>
            <div class="ctx-menu-item delete" id="ctx-btn-delete">
                <i class="fa-solid fa-trash"></i> Excluir Track
            </div>
        `;

        document.body.appendChild(menu);

        const btnDelete = menu.querySelector('#ctx-btn-delete');
        if (btnDelete) {
            btnDelete.onclick = () => {
                this.studio.deleteTrack(track.id);
                this._closeContextMenu();
            };
        }

        setTimeout(() => {
            document.addEventListener('click', this._closeContextMenuBind);
            document.addEventListener('contextmenu', this._closeContextMenuBind); 
        }, 0);
    }

    _closeContextMenu = () => {
        const existing = document.querySelector('.studio-context-menu');
        if (existing) existing.remove();
        
        document.removeEventListener('click', this._closeContextMenuBind);
        document.removeEventListener('contextmenu', this._closeContextMenuBind);
    }

    _closeContextMenuBind = (e) => {
        if (e.target.closest('.studio-context-menu')) return;
        this._closeContextMenu();
    }

    /**
     * Renderiza as guias verticais para TODOS os crossfades ativos na timeline.
     * Chamado automaticamente pelo renderTracks().
     */
    _renderCrossfadeGuides() {
        let container = document.getElementById('timeline-crossfade-container');
        const tracksContainer = document.getElementById('studio-tracks');
        
        if (!tracksContainer) return;

        // 1. Limpeza: Garante que nenhum clipe tenha opacidade residual de versões anteriores
        const allClips = tracksContainer.querySelectorAll('.clip');
        allClips.forEach(el => {
            if (el.style.pointerEvents !== 'none') { // Não mexe no que está sendo arrastado
                el.style.opacity = ''; 
            }
        });

        if (!container) {
            container = document.createElement('div');
            container.id = 'timeline-crossfade-container';
            container.style.cssText = `
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                pointer-events: none; z-index: 9998; overflow: visible;
            `;
            tracksContainer.appendChild(container);
        } else {
            container.innerHTML = ''; 
        }

        const containerRect = tracksContainer.getBoundingClientRect();
        const headerOffset = 120; 

        this.studio.project.tracks.forEach(track => {
            if (track.clips.length < 2) return;

            const sortedClips = [...track.clips].sort((a, b) => a.start - b.start);
            
            for (let i = 0; i < sortedClips.length - 1; i++) {
                const c1 = sortedClips[i]; // Clip de Baixo/Esquerda (Sendo coberto)
                const c2 = sortedClips[i+1]; // Clip de Cima/Direita (Cobrindo)

                const c1End = c1.start + c1.duration;
                
                // Detecta Interseção
                if (c2.start < c1End - 0.05) {
                    const intersectionStart = c2.start;
                    const intersectionEnd = c1End;

                    // Busca elementos DOM
                    const c1El = this._findDomElement(c1.id);
                    const c2El = this._findDomElement(c2.id);
                    const targetEl = c1El || c2El;

                    if (!targetEl) continue;

                    // --- GEOMETRIA ---
                    const rect = targetEl.getBoundingClientRect();
                    const guideTop = (rect.top - containerRect.top) + tracksContainer.scrollTop;
                    const guideHeight = targetEl.offsetHeight; // Altura exata do clipe

                    const xStart = (intersectionStart * this.studio.project.zoom) + headerOffset;
                    const xEnd = (intersectionEnd * this.studio.project.zoom) + headerOffset;
                    const width = xEnd - xStart;

                    // --- PARTE 1: GUIAS VERTICAIS ---
                    const lineStyle = `
                        position: absolute; width: 1px; 
                        top: ${guideTop}px; height: ${guideHeight}px;
                        background: rgba(255, 255, 255, 0.8); 
                        box-shadow: 0 0 4px rgba(0,0,0,0.5);
                        border-left: 1px dashed rgba(255,255,255,0.5);
                    `;
                    const l1 = document.createElement('div');
                    l1.style.cssText = lineStyle + `left: ${xStart}px;`;
                    const l2 = document.createElement('div');
                    l2.style.cssText = lineStyle + `left: ${xEnd}px;`;

                    container.appendChild(l1);
                    container.appendChild(l2);

                    if (c1El) {
                        const originalSvg = c1El.querySelector('.fade-curve-layer');
                        if (originalSvg) {
                            const ghostWrapper = document.createElement('div');
                            ghostWrapper.style.cssText = `
                                position: absolute;
                                left: ${xStart}px;
                                top: ${guideTop}px;
                                width: ${width}px; 
                                height: ${guideHeight}px;
                                overflow: hidden; /* O SEGREDO: Recorta o que está fora da interseção */
                                pointer-events: none;
                            `;

                            const clonedSvg = originalSvg.cloneNode(true);
                            
                            
                            const c1ScreenLeft = (c1.start * this.studio.project.zoom) + headerOffset;
                            const relativeOffset = c1ScreenLeft - xStart;
                            
                            clonedSvg.style.left = (relativeOffset - 2) + "px"; 
                            clonedSvg.style.top = "-2px";
                            
                            // Ajusta estilos para garantir visibilidade máxima (stroke branco forte)
                            const pathStroke = clonedSvg.querySelector('.fade-path-stroke');
                            if (pathStroke) {
                                pathStroke.setAttribute('stroke', '#ffffff');
                                pathStroke.setAttribute('stroke-width', '2'); 
                                pathStroke.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.8))'; 
                            }
                            
                            // Remove preenchimento escuro para não escurecer o clipe de cima
                            const pathFill = clonedSvg.querySelector('.fade-path-fill');
                            if(pathFill) pathFill.style.fill = 'none';

                            ghostWrapper.appendChild(clonedSvg);
                            container.appendChild(ghostWrapper);
                        }
                    }
                }
            }
        });
    }
    
    _renderAddTrackButton(container) {
        if (!container) return;
        container.innerHTML = "";

        const wrapper = document.createElement('div');
        wrapper.className = "track-add-dropdown-container";
        wrapper.style.cssText = `width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; position: relative;`;

        wrapper.innerHTML = `
            <button class="btn-add-track-header" title="Adicionar Track" style="border:none; background:transparent; cursor:pointer; font-weight:600; color:#b5b5b5; display:flex; gap:5px; width:100%; height:100%; align-items:center; justify-content:center;">
                <i class="fa-solid fa-plus"></i> Track
            </button>
            <div class="dropdown-content-header" style="top: 100%; left: 0; width: 100%;">
                <a href="#" data-type="video"><i class="fa-solid fa-video"></i> Video Track</a>
                <a href="#" data-type="audio"><i class="fa-solid fa-volume-high"></i> Audio Track</a>
            </div>
        `;
        
        const btn = wrapper.querySelector('.btn-add-track-header');
        const content = wrapper.querySelector('.dropdown-content-header');
        
        btn.onclick = (e) => { e.stopPropagation(); content.classList.toggle('show'); };
        
        if (!window.hasGlobalDropdownListener) {
            window.addEventListener('click', () => {
                document.querySelectorAll('.dropdown-content-header.show').forEach(el => el.classList.remove('show'));
            });
            window.hasGlobalDropdownListener = true;
        }
        
        wrapper.querySelectorAll('a').forEach(link => {
            link.onclick = (e) => {
                e.preventDefault();
                this.studio.addTrack(e.currentTarget.dataset.type);
                content.classList.remove('show');
            };
        });

        container.appendChild(wrapper);
    }

    _createClipElement(clip, trackId) {
        let asset = this.studio.project.assets.find(a => a.id === clip.assetId);

        if (!asset && clip.type === 'subtitle') {
            asset = { type: 'subtitle', name: 'Legendas', baseDuration: clip.duration };
        }

        if(!asset) return document.createElement('div');

        const track = this.studio.project.tracks.find(t => t.id === trackId);
        const isAudioTrack = track && track.type === 'audio';

        if (typeof clip.fadeIn === 'undefined') clip.fadeIn = 0;
        if (typeof clip.fadeOut === 'undefined') clip.fadeOut = 0;

        const el = document.createElement("div");
        el.className = `clip type-${clip.type}`;
        el.dataset.clipId = clip.id;
        el.dataset.assetId = clip.assetId;
        
        el.style.boxSizing = "border-box";
        el.style.borderWidth = "2px";
        el.style.borderStyle = "solid";
        
        // Seleção
        const isSelected = this.selectedClips.some(s => s.clip.id === clip.id);
        if (isSelected) {
            el.classList.add('selected');
            el.style.borderColor = '#2196F3';
        } else {
            el.style.borderColor = 'transparent';
        }
        
        el.style.left = (clip.start * this.studio.project.zoom) + "px";
        el.style.width = (clip.duration * this.studio.project.zoom) + "px";
        
        const faderTop = (1 - clip.level) * 100;
        
        const isVideoVisual = (clip.type === 'video' || clip.type === 'image') && !isAudioTrack;

        // Container de visuais
        const bgVisuals = `<div class="clip-visuals" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:0; pointer-events:none; overflow:hidden; display:flex;"></div>`;

        const fadeOverlay = `<div class="clip-fade-overlay" style="
            position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 5; pointer-events: none;
        "></div>`;

        // Estilos do Texto
        const nameStyle = `
            z-index: 6; 
            position: absolute; 
            top: 2px; 
            left: 2px;
            background: rgba(0, 0, 0, 0.75);
            color: rgba(255, 255, 255, 0.95);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-family: 'Segoe UI', sans-serif;
            font-weight: 500;
            line-height: 1.2;
            pointer-events: none;
            max-width: calc(100% - 10px);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            box-shadow: 0 1px 2px rgba(0,0,0,0.5);
        `;

        const isSubtitle = clip.type === 'subtitle';
        let warningBtn = '';

        if (isSubtitle && clip.needsTranscription) {
            warningBtn = `
                <div class="clip-tool-btn warning-btn" 
                     title="Trecho novo detectado. Clique para transcrever."
                     style="position: absolute; top: 2px; right: 25px; width: 20px; height: 20px; 
                            background: #ff9800; color: white; border-radius: 3px; 
                            display: flex; align-items: center; justify-content: center; 
                            font-size: 11px; cursor: pointer; z-index: 100; animation: pulse-warning 2s infinite;">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                </div>`;
        }

        el.innerHTML = `
            ${bgVisuals}
            ${fadeOverlay}
            <svg class="fade-curve-layer" preserveAspectRatio="none" style="position:absolute; top:-2px; left:-2px; width:calc(100% + 4px); height:calc(100% + 4px); pointer-events:none; z-index:1; opacity:0.6;">
                <path class="fade-path-fill" fill="rgba(0,0,0,0.2)" d=""></path>
                <path class="fade-path-stroke" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="1.5" vector-effect="non-scaling-stroke" d=""></path>
            </svg>

            <div class="fade-handle fade-in" data-action="fade-in" title="Fade In: 0.0s"></div>
            <div class="fade-handle fade-out" data-action="fade-out" title="Fade Out: 0.0s"></div>

            <div class="fader-handle" data-action="fader" style="top: ${faderTop}%; z-index: 25;" title="Nível: ${Math.round(clip.level*100)}%"></div>
            <div class="fader-line" style="top: ${faderTop}%"></div>
            
            ${isVideoVisual ? `<div class="clip-opacity-overlay" style="opacity: ${1 - clip.level}"></div>` : ''}
            ${warningBtn}
            <div class="clip-name" style="${nameStyle}">${clip.name}</div>
            
            <div class="resize-handle left" data-action="resize-left" style="z-index: 25; position: absolute; left: 0; top: 0; bottom: 0; width: 10px; cursor: w-resize;"></div>
            <div class="resize-handle right" data-action="resize-right" style="z-index: 25;"></div>
        `;
        
        this._injectFadeStyles(el);
        requestAnimationFrame(() => this._updateFadeVisuals(clip, el));

        if (isSubtitle && clip.needsTranscription) {
            const btnWarn = el.querySelector('.warning-btn');
            if (btnWarn) {
                btnWarn.onmousedown = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    // Chama a função global de re-transcrição parcial
                    if (this.studio.retranscribeClipGap) {
                        this.studio.retranscribeClipGap(clip);
                    } else {
                        console.error("Função retranscribeClipGap não implementada no Studio.");
                    }
                };
            }
        }

        if (clip.type === 'subtitle') {
            const btnSettings = document.createElement('div');
            btnSettings.className = 'clip-tool-btn settings-btn';
            btnSettings.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
            
            btnSettings.onmousedown = (e) => {
                e.preventDefault(); 
                e.stopPropagation(); 
                this.studio.uiManager.openSubtitleModal(clip);
            };
            el.appendChild(btnSettings);
            
            el.style.background = "#5e35b1";
            el.style.borderColor = "#7e57c2";
        }

        const visualsContainer = el.querySelector('.clip-visuals');
        
        // Se for arquivo de áudio OU se estiver numa track de áudio (mesmo sendo vídeo)
        if (asset.type === 'audio' || isAudioTrack) {
            // Renderiza Waveform (extraindo áudio do vídeo se necessário)
            this._renderWaveform(asset, visualsContainer, clip.level);
        } 
        else if (asset.type === 'video' || asset.type === 'image') {
            // Renderiza Thumbnails (com a lógica de não espremer)
            this._renderThumbnails(asset, visualsContainer, clip.duration, this.studio.project.zoom);
        }

        // Loop Markers
        if (clip.duration + clip.offset > asset.baseDuration) {
            const baseDur = asset.baseDuration;
            const totalTime = clip.duration + clip.offset;
            const loops = Math.floor(totalTime / baseDur);
            
            for(let i=1; i<=loops; i++) {
                const timePoint = i * baseDur;
                const relativePixel = (timePoint - clip.offset) * this.studio.project.zoom;

                // Só renderiza se estiver dentro da área visível do clipe
                if (relativePixel > 0 && relativePixel < (clip.duration * this.studio.project.zoom)) {
                    const m = document.createElement("div");
                    m.className = "loop-marker loop-vinco";
                    
                    m.style.left = relativePixel + "px";
                    
                    // Estilo do Vinco
                    m.style.cssText += `
                        position: absolute; 
                        top: 0; 
                        bottom: 0; 
                        width: 1px; 
                        background-color: rgba(255, 255, 255, 0.5); 
                        border-left: 2px dashed rgba(0, 0, 0, 0.5); 
                        z-index: 10;
                        pointer-events: none;
                    `;
                    
                    el.appendChild(m);
                }
            }
        }

        el.onmousedown = (e) => {
            e.stopPropagation(); 
            const startX = e.clientX;
            const startY = e.clientY;
            const action = e.target.dataset.action;

            if (action === 'fade-in' || action === 'fade-out') {
                this._startFade(e, clip, el, action);
                return;
            }

            this._handleSelection(e, clip, trackId, el);
            
            if (action === 'resize-left' || action === 'resize-right' || action === 'resize') {
                // Passa o action específico ('resize-left' ou 'resize-right')
                this._startResize(e, clip, el, asset.baseDuration, action);
            } else if (action === 'fader') {
                this._startFader(e, clip, el, track);
            } else {
                this._startMove(e, clip, el);
            }

            const onMouseUpCheck = (ev) => {
                const dist = Math.sqrt(Math.pow(ev.clientX - startX, 2) + Math.pow(ev.clientY - startY, 2));
                if (dist < 5 && !action) { 
                    const lane = el.closest('.track-lane');
                    if (lane) {
                        const rect = lane.getBoundingClientRect();
                        const x = ev.clientX - rect.left + 120;
                        const rawTime = Math.max(0, (x - 120) / this.studio.project.zoom);
                        this._seekToTime(this._snapToFrame(rawTime));
                    }
                }
                window.removeEventListener('mouseup', onMouseUpCheck);
            };
            window.addEventListener('mouseup', onMouseUpCheck);
        };

        return el;
    }

    _updateVisualStatus(increment) {
        this.pendingVisualTasks += increment;
        if (this.pendingVisualTasks < 0) this.pendingVisualTasks = 0;

        const statusBar = document.getElementById('studio-status-bar');
        const statusText = document.getElementById('studio-status-text');
        
        if (this.pendingVisualTasks > 0) {
            if (statusBar && statusBar.classList.contains('hidden')) {
                statusBar.classList.remove('hidden');
            }
            if (statusText) {
                statusText.innerText = `Processando visualizações (${this.pendingVisualTasks} pendentes)...`;
            }
        } else {
            // Pequeno delay para evitar flicker na barra se for muito rápido
            setTimeout(() => {
                if (this.pendingVisualTasks === 0 && statusBar) {
                    statusBar.classList.add('hidden');
                }
            }, 500);
        }
    }

    /**
     * Gera e armazena frames indexados e audio buffer (cache) no Asset.
     * Isso é a "Indexação" que permite o redimensionamento sem piscar.
     */
    async indexAssetVisuals(asset) {
        if (asset.type === 'audio' || (asset.type === 'video' && !asset.audioBufferCache)) {
            // Decodificar áudio (e cachear)
            if (!this.studio.timelineManager.audioContext) {
                 this.studio.timelineManager.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            try {
                const arrayBuffer = await asset.sourceBlob.arrayBuffer(); 
                asset.audioBufferCache = await this.studio.timelineManager.audioContext.decodeAudioData(arrayBuffer);
                console.log(`[AssetManager] Audio Buffer Indexado para ${asset.name}`);
            } catch (e) {
                console.error(`Erro ao indexar buffer de áudio para ${asset.name}:`, e);
            }
        }

        if (asset.type === 'video' || asset.type === 'image') {
            // Indexar Frames (Key frames)
            if (asset.type === 'image') {
                // Imagem: Usa a URL como índice único
                asset._frameCache = { '0': asset.url };
            } else if (asset.type === 'video') {
                console.log(`[AssetManager] Iniciando Indexação de Frames para ${asset.name}...`);

                // Indexamos 10 frames por segundo para ter alta densidade (10/FPS)
                const framesPerSecond = 10;
                const duration = asset.baseDuration; 
                
                const video = document.createElement('video');
                video.src = asset.url;
                video.crossOrigin = 'anonymous';
                video.muted = true;
                
                const frameCache = {};
                
                const capture = (time) => new Promise((resolve) => {
                    video.currentTime = time;
                    video.onseeked = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = 160; 
                        canvas.height = 90;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                        resolve(canvas.toDataURL());
                    };
                    setTimeout(() => resolve(null), 1000); 
                });

                // Espera metadados
                await new Promise(r => video.onloadedmetadata = r);
                
                // Indexação: 1 frame a cada 0.1s
                for (let t = 0; t <= duration; t += 1 / framesPerSecond) {
                    const timeKey = (Math.floor(t * 10) / 10).toFixed(1); // Ex: 10.1
                    const dataUrl = await capture(t);
                    if (dataUrl) {
                        frameCache[timeKey] = dataUrl;
                    }
                }
                asset._frameCache = frameCache;
                console.log(`[AssetManager] Indexação de ${asset.name} completa (${Object.keys(frameCache).length} frames).`);
            }
        }
    }

    async _renderThumbnails(asset, container, clipDuration, zoom) {
        // [CHECA INDEXAÇÃO] Se o cache não existe, mostra feedback.
        if (!asset._frameCache) {
             container.innerHTML = '<div style="color:#aaa;font-size:10px;padding:5px;">Indexando...</div>';
             return;
        }
        
        const clipId = container.closest('.clip')?.dataset.clipId;
        let clip = null;
        if (this.studio.project) {
            this.studio.project.tracks.forEach(t => {
                const c = t.clips.find(x => x.id === clipId);
                if(c) clip = c;
            });
        }
        if(!clip) return;

        // CÁLCULO DE LAYOUT
        const clipPixelWidth = clip.duration * zoom;
        const trackHeight = 80; 
        const idealThumbWidth = trackHeight * (16 / 9); 
        const capacity = Math.floor(clipPixelWidth / idealThumbWidth);
        
        let thumbCount = 3;
        if (capacity < 2) thumbCount = 1;
        else if (capacity < 3) thumbCount = 2;

        let percentages = [];
        if (thumbCount === 1) percentages = [0]; 
        else if (thumbCount === 2) percentages = [0, 0.99]; 
        else percentages = [0, 0.5, 0.99];
        
        const fragment = document.createDocumentFragment();
        const assetDuration = asset.baseDuration; 

        const createImg = (src) => {
            const img = document.createElement('img');
            img.src = src;
            img.style.height = '100%';
            img.style.width = 'auto';
            img.style.maxWidth = 'none';
            img.style.flexShrink = '0';
            img.style.objectFit = 'cover';
            img.style.opacity = '0.7';
            if (thumbCount > 1) img.style.borderRight = '1px solid rgba(0,0,0,0.5)';
            return img;
        };

        // Itera e usa o cache
        for (let i = 0; i < percentages.length; i++) {
            const p = percentages[i];
            
            const linearTime = clip.offset + (clip.duration * p);
            const loopTime = linearTime % assetDuration;
            
            // Chave de Cache: Arredondada para 1 casa decimal
            const cacheKey = (Math.floor(loopTime * 10) / 10).toFixed(1); 
            
            let dataUrl = asset._frameCache[cacheKey];
            
            // Fallback para o frame anterior se o exato não existir
            if (!dataUrl) {
                 const prevKey = (Math.floor((loopTime - 0.1) * 10) / 10).toFixed(1);
                 dataUrl = asset._frameCache[prevKey] || asset._frameCache['0.0']; 
            }
            
            if (dataUrl) {
                const img = createImg(dataUrl);
                if (i === percentages.length - 1) img.style.borderRight = 'none';
                fragment.appendChild(img);
            }
        }

        this._applyVisualStyles(container);
        container.innerHTML = ''; 
        container.appendChild(fragment);
    }

    _applyVisualStyles(container) {
        container.style.position = 'relative';
        container.style.overflow = 'hidden'; 
        container.style.display = 'flex'; 
        container.style.justifyContent = 'space-between'; 
        container.style.alignItems = 'center'; 
        container.style.background = '#000'; 
    }

    /**
     * Gera Waveform de áudio baseada no nível de volume.
     * Desenha a waveform base (1 ciclo) e usa clones de DOM para simular o loop.
     */
    async _renderWaveform(asset, container, level) {
        if (!container) return;

        // 1. Identificar clip
        const clipEl = container.closest(".clip");
        const clipId = clipEl?.dataset.clipId;
        let clip = null;
        if (this.studio.project) {
            for (const track of this.studio.project.tracks) {
                const c = track.clips.find(x => x.id === clipId);
                if (c) { clip = c; break; }
            }
        }
        if (!clip) return;

        // 2. Indexação
        if (!asset.audioWaveCache) {
             container.innerHTML = `<div style="color:#aaa;font-size:10px;padding:5px;">Waveform...</div>`;
             if (this.studio.assetManager && !asset._isIndexing) { 
                asset._isIndexing = true;
                this.studio.assetManager.indexAssetVisuals(asset).then(() => {
                    asset._isIndexing = false;
                    this.renderTracks(); 
                });
             }
            return; 
        }
        
        const zoom = this.studio.project.zoom;
        const baseAssetDuration = asset.baseDuration;
        const baseWaveformWidth = baseAssetDuration * zoom; 

        // Detecção de Canvas Gigante
        const MAX_CANVAS_WIDTH = 30000;
        const isHugeCanvas = baseWaveformWidth > MAX_CANVAS_WIDTH;

        this._applyVisualStyles(container);
        container.innerHTML = "";
        
        if (isHugeCanvas) {
            // Renderiza apenas o pedaço visível do clipe.
            // Permite offsets e fades específicos pois o canvas é único deste clipe.
            
            const clipPixelWidth = clip.duration * zoom;
            const dpr = window.devicePixelRatio || 1;
            const canvas = document.createElement("canvas");
            
            canvas.style.width = "100%"; 
            canvas.style.height = "100%";
            
            canvas.width = Math.max(1, Math.floor(clipPixelWidth * dpr));
            canvas.height = Math.max(1, Math.floor((clipEl.offsetHeight || 80) * dpr));

            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.scale(dpr, dpr);

            this._optimizedWaveDraw(
                ctx,
                asset.audioWaveCache,
                clipPixelWidth,
                (clipEl.offsetHeight || 80),
                level * (clip.volume ?? 1), 
                clip.duration, 
                clip.offset, // Passa o offset real
                clip         // Passa o clipe (aplica fades)
            );
            
            // Garante reset de transformações herdadas
            container.style.transform = 'none';
            container.appendChild(canvas);

        } else {
            // --- MODO PADRÃO (Cache Compartilhado) ---
            // Renderiza o ASSET INTEIRO (sem offset) e reutiliza via clones.
            // IMPORTANTE: Não passamos 'clip' nem 'offset' para não contaminar o cache.
            
            const numLoops = Math.ceil(clip.duration / baseAssetDuration);
            let baseCanvas;
            
            if (asset._waveformBaseCanvas) {
                baseCanvas = asset._waveformBaseCanvas;
            } else {
                baseCanvas = document.createElement("canvas");
                asset._waveformBaseCanvas = baseCanvas; 
                baseCanvas.style.height = "100%";
            }
            baseCanvas.style.width = `${baseWaveformWidth}px`; 

            // Redesenha o cache APENAS se o zoom mudou ou ainda não existe
            const targetHeight = clipEl.offsetHeight || 80; 
            const forceRedraw = !asset._isWaveformRendered || asset._lastRenderZoom !== zoom;
            
            if (forceRedraw) {
                const dpr = window.devicePixelRatio || 1;
                baseCanvas.width = Math.max(1, Math.floor(baseWaveformWidth * dpr));
                baseCanvas.height = Math.max(1, Math.floor(targetHeight * dpr));

                const ctx = baseCanvas.getContext("2d", { willReadFrequently: true });
                ctx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
                ctx.scale(dpr, dpr); 
                
                this._optimizedWaveDraw(
                    ctx,
                    asset.audioWaveCache,
                    baseWaveformWidth, 
                    targetHeight, 
                    1, // Volume 1 (neutro) para o cache base
                    baseAssetDuration, 
                    0,    // Offset 0 (sempre começa do início do arquivo)
                    null  // Sem clipe (sem fades baked-in)
                );
                
                asset._isWaveformRendered = true;
                asset._lastRenderZoom = zoom;
            }

            // Cria Repeater para deslocar o canvas base corretamente
            const repeater = document.createElement('div');
            repeater.className = 'waveform-repeater';
            repeater.style.display = 'flex';
            repeater.style.height = '100%';
            repeater.style.position = 'absolute';
            container.appendChild(repeater);
            
            for (let i = 0; i < numLoops; i++) {
                const displayCanvas = document.createElement("canvas");
                displayCanvas.width = baseCanvas.width;
                displayCanvas.height = baseCanvas.height;
                
                const ctx = displayCanvas.getContext('2d');
                ctx.drawImage(baseCanvas, 0, 0);

                displayCanvas.style.width = `${baseWaveformWidth}px`;
                displayCanvas.style.height = "100%";
                repeater.appendChild(displayCanvas);
            }
            
            // O deslocamento visual acontece aqui
            const offsetX = (clip.offset || 0) * zoom;
            repeater.style.transform = `translateX(-${offsetX}px)`;
            repeater.style.width = `${baseWaveformWidth * numLoops}px`;
        }
    }

    /**
     * Desenhador de waveform.
     */
    _optimizedWaveDraw(ctx, cache, width, height, level, clipDuration, clipOffset, clip) {
        const sampleRate = cache.sampleRate;
        const zoom = this.studio.project.zoom; 
        const samplesPerVisualPixel = sampleRate / zoom;
        const offsetSamples = clipOffset * sampleRate;

        ctx.clearRect(0, 0, width, height); 
        ctx.fillStyle = "#4fc3f7";

        const drawChannel = (channelData, topY, drawHeight) => {
            const mid = drawHeight / 2;
            
            let bins = channelData.full;
            let binSize = 1;
            if (samplesPerVisualPixel >= 8) { bins = channelData.eighth; binSize = 8; } 
            else if (samplesPerVisualPixel >= 4) { bins = channelData.quarter; binSize = 4; } 
            else if (samplesPerVisualPixel >= 2) { bins = channelData.half; binSize = 2; }

            if (!bins || bins.length === 0) return;
            const wrapLength = bins.length;

            for (let x = 0; x < width; x++) {
                const sourceTime = (x * samplesPerVisualPixel / sampleRate) + clipOffset;
                const absoluteSampleStart = Math.floor(offsetSamples + x * samplesPerVisualPixel);
                const sampleEnd = Math.floor(absoluteSampleStart + samplesPerVisualPixel);
                const binStart = Math.floor(absoluteSampleStart / binSize);
                const binEnd = Math.floor(sampleEnd / binSize);

                let min = 1.0, max = -1.0;

                for (let b = binStart; b <= binEnd; b++) {
                    const idx = ((b % wrapLength) + wrapLength) % wrapLength;
                    const binData = bins[idx];
                    if (!binData) continue; 
                    if (binData.min < min) min = binData.min;
                    if (binData.max > max) max = binData.max;
                }

                // Cálculo do Fade
                let fadeFactor = 1.0;
                if (clip && (clip.fadeIn > 0 || clip.fadeOut > 0)) { 
                     const timeRelative = sourceTime - (clip.offset || 0);
                     fadeFactor = this._calculateLocalFadeFactor(clip, timeRelative);
                }

                min *= level * fadeFactor;
                max *= level * fadeFactor;

                // Desenha relativo ao topY (metade superior ou inferior)
                const y = (topY + mid) + (min * mid);
                const h = Math.max(1, (max - min) * mid);

                ctx.fillRect(x, y, 1, h);
            }
        };

        if (cache.channels > 1 && cache.right) {
            // STEREO: Divide a altura em 2
            const halfHeight = height / 2;
            
            // Desenha Esquerda (Topo)
            drawChannel(cache.left, 0, halfHeight);
            
            // Desenha Direita (Baixo)
            drawChannel(cache.right, halfHeight, halfHeight);
            
            ctx.fillStyle = "rgba(255,255,255,0.1)";
            ctx.fillRect(0, halfHeight, width, 1);
            ctx.fillStyle = "#4fc3f7"; 
            
        } else {
            drawChannel(cache.left, 0, height);
        }
    }

    /**
     * Redesenha o Canvas Base da Waveform e propaga os novos pixels para todos os clones visíveis.
     * Acionado por _startFader e _startFade.
     */
    _rerenderWaveformOfClip(clip, track) {
        if (!clip || !clip.id) return;
        if (track.type !== "audio") return;

        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if (!asset || !asset.audioWaveCache || !asset._waveformBaseCanvas) return;

        const baseCanvas = asset._waveformBaseCanvas;
        const clipEl = document.querySelector(`.clip[data-clip-id="${clip.id}"]`);
        
        // 1. Redesenhar o CANVAS BASE (Apenas 1 ciclo) com o novo nível e FADE
        const visualLevel = (clip.level ?? 1) * (clip.volume ?? 1);
        const dpr = window.devicePixelRatio || 1;

        const ctx = baseCanvas.getContext("2d", { willReadFrequently: true });
        
        const cssW = asset._lastRenderZoom ? asset.baseDuration * asset._lastRenderZoom : baseCanvas.width / dpr;
        const cssH = clipEl?.offsetHeight || 80;

        baseCanvas.width = Math.max(1, Math.floor(cssW * dpr));
        baseCanvas.height = Math.max(1, Math.floor(cssH * dpr));
        
        ctx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
        ctx.scale(dpr, dpr);
        
        this._optimizedWaveDraw(
            ctx,
            asset.audioWaveCache,
            cssW, 
            cssH, 
            visualLevel,
            asset.baseDuration, 
            0,                  
            clip 
        );

        // 2. Propagar a mudança para TODOS os clones visíveis na timeline
        const allClipsWithAsset = document.querySelectorAll(`.clip[data-asset-id="${asset.id}"]`);
        
        const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
        // Proteção para evitar erro se width/height for 0
        if (baseCanvas.width > 0 && baseCanvas.height > 0) {
            const imageData = baseCtx.getImageData(0, 0, baseCanvas.width, baseCanvas.height);

            allClipsWithAsset.forEach(el => {
                const repeater = el.querySelector('.waveform-repeater');
                if (!repeater) return;

                Array.from(repeater.children).forEach(childCanvas => {
                    if (childCanvas.tagName === 'CANVAS') {
                        const cloneCtx = childCanvas.getContext('2d');
                        childCanvas.width = baseCanvas.width;
                        childCanvas.height = baseCanvas.height;
                        cloneCtx.putImageData(imageData, 0, 0); 
                    }
                });
            });
        }
    }

    /**
     * Injeta estilos e comportamentos visuais para os handles de fade.
     * Ajustado: top: -2px para alinhar com a borda (Box Model fix).
     */
    _injectFadeStyles(el) {
        const normalColor = '#2196F3';
        const hoverColor = '#64B5F6'; 

        const handleStyle = `
            position: absolute; top: -2px; width: 10px; height: 10px; 
            background-color: ${normalColor}; border: 1px solid rgba(255,255,255,0.8); 
            z-index: 30; cursor: ew-resize;
            box-shadow: 0 1px 3px rgba(0,0,0,0.4);
            transition: background-color 0.1s ease;
        `;
        
        const setupHandle = (handle, isLeft) => {
            if (!handle) return;
            
            handle.style.cssText = handleStyle + (isLeft 
                ? "left: 0; border-bottom-right-radius: 4px;" 
                : "right: 0; border-bottom-left-radius: 4px;"
            );
            
            handle.onmouseenter = () => handle.style.backgroundColor = hoverColor;
            handle.onmouseleave = () => handle.style.backgroundColor = normalColor;
        };

        setupHandle(el.querySelector('.fade-in'), true);
        setupHandle(el.querySelector('.fade-out'), false);
    }

    _startFade(e, clip, el, type) {
        // Encontra a track para a função de redraw
        const trackId = el.closest('.track')?.dataset.trackId;
        const track = this.studio.project.tracks.find(t => t.id === trackId);
        
        const startX = e.clientX;
        const initialFadeIn = clip.fadeIn || 0;
        const initialFadeOut = clip.fadeOut || 0;
        const duration = clip.duration;
        const zoom = this.studio.project.zoom;

        const preState = this.studio.historyManager._createSnapshot();
        let didChange = false;

        const onMove = (ev) => {
            const deltaPx = ev.clientX - startX;
            const deltaSec = deltaPx / zoom;
            
            didChange = true;

            if (type === 'fade-in') {
                let newVal = Math.max(0, initialFadeIn + deltaSec);
                newVal = Math.min(newVal, duration - initialFadeOut); // Não cruzar com fade out
                clip.fadeIn = newVal;
                
                const handle = el.querySelector('.fade-in');
                if(handle) handle.title = `Fade In: ${newVal.toFixed(2)}s`;

            } else {
                // Fade out: arrastar p/ esquerda (negativo) aumenta o tempo de fade
                let newVal = Math.max(0, initialFadeOut - deltaSec);
                newVal = Math.min(newVal, duration - initialFadeIn); // Não cruzar com fade in
                clip.fadeOut = newVal;
                
                const handle = el.querySelector('.fade-out');
                if(handle) handle.title = `Fade Out: ${newVal.toFixed(2)}s`;
            }

            this._updateFadeVisuals(clip, el);
            
            if (track) {
                 this._rerenderWaveformOfClip(clip, track);
            }
        };

        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (didChange) this.studio.historyManager.pushManualState(preState);
            this.studio.markUnsavedChanges();
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    /**
     * Calcula o fator de atenuação (0.0 a 1.0) baseado no Fade In/Out para um ponto de tempo relativo.
     * Deve corresponder à curva senoidal usada no PlaybackManager.
     * @param {object} clip - O objeto clipe contendo fadeIn e fadeOut.
     * @param {number} timeInClip - O tempo (em segundos) relativo ao início do clipe.
     */
    _calculateLocalFadeFactor(clip, timeInClip) {
        // Garante números válidos
        const duration = clip.duration;
        const fadeIn = Number(clip.fadeIn) || 0;
        const fadeOut = Number(clip.fadeOut) || 0;

        let factorIn = 1.0;
        let factorOut = 1.0;

        // 1. Cálculo do Fade In (Curva Senoidal)
        if (fadeIn > 0) {
            if (timeInClip < 0) factorIn = 0; // Antes do inicio
            else if (timeInClip < fadeIn) {
                const progress = timeInClip / fadeIn;
                // Curva Senoidal (Ease-In-Out)
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
                // Curva Senoidal (Ease-In-Out)
                factorOut = 0.5 * (1 - Math.cos(progress * Math.PI));
            }
        }

        return Math.max(0, Math.min(1, factorIn * factorOut));
    }

    _updateFadeVisuals(clip, el) {
        const zoom = this.studio.project.zoom;
        const w = clip.duration * zoom;
        const h = el.offsetHeight || 50; 
        
        // Larguras originais dos fades
        let fiW = (clip.fadeIn || 0) * zoom;
        let foW = (clip.fadeOut || 0) * zoom;
        
        const level = (clip.level !== undefined) ? clip.level : 1;
        const yTop = (1 - level) * h; 

        // Posiciona Handles (Usando valores reais para controle preciso)
        const handleIn = el.querySelector('.fade-in');
        const handleOut = el.querySelector('.fade-out');
        if(handleIn) handleIn.style.transform = `translate(${fiW}px, ${yTop}px)`;
        if(handleOut) handleOut.style.transform = `translate(-${foW}px, ${yTop}px)`;

        // Se a soma dos fades for maior que o clipe, eles colidem.
        // Reduzimos proporcionalmente VISUALMENTE para que se encontrem num vértice,
        // eliminando o "platô" falso que escondia o Fade Out.
        const totalFadeWidth = fiW + foW;
        if (totalFadeWidth > w) {
            const scale = w / totalFadeWidth;
            fiW *= scale;
            foW *= scale;
        }

        const fadeOverlay = el.querySelector('.clip-fade-overlay');

        const fiPct = (fiW / w) * 100;
        const foPct = 100 - (foW / w) * 100;

        if (fadeOverlay) {            
            const gradient = `linear-gradient(
                to right,
                rgba(0,0,0,1) 0%, 
                rgba(0,0,0,1) ${fiPct}%, 
                rgba(0,0,0,0) ${fiPct}%, 
                rgba(0,0,0,0) ${foPct}%, 
                rgba(0,0,0,1) ${foPct}%, 
                rgba(0,0,0,1) 100%
            )`;
            
            fadeOverlay.style.maskImage = gradient;
            fadeOverlay.style.webkitMaskImage = gradient;
            
            fadeOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.4)'; 
        }

        // SVG Drawing
        let d = `M 0,${h}`; 
        
        // Curva de Entrada
        if (fiW > 0) {
            d += ` C ${fiW/2},${h} ${fiW/2},${yTop} ${fiW},${yTop}`;
        } else {
            d += ` L 0,${yTop}`;
        }
        
        // Linha do Topo (Platô)
        // Agora, se houver sobreposição, fiW será exatamente onde foW começa (w - foW),
        // resultando em uma linha de comprimento zero (vértice perfeito).
        const plateauEnd = w - foW; 
        // Garante que não desenhe linha para trás
        if (plateauEnd > fiW) {
             d += ` L ${plateauEnd},${yTop}`;
        }
        
        // Curva de Saída
        if (foW > 0) {
            d += ` C ${w - foW/2},${yTop} ${w - foW/2},${h} ${w},${h}`;
        } else {
            d += ` L ${w},${h}`;
        }

        const fillD = d + ` L 0,${h} Z`; 
        
        const pathFill = el.querySelector('.fade-path-fill');
        const pathStroke = el.querySelector('.fade-path-stroke');
        if(pathFill) pathFill.setAttribute('d', fillD);
        if(pathStroke) pathStroke.setAttribute('d', d);
    }

    // =========================================================================
    // INTERAÇÃO DO USUÁRIO (Drag, Drop, Resize, Fader)
    // =========================================================================

    _bindTrackReorderEvents(header, index) {
        header.ondragstart = (e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", index.toString());
            header.classList.add('dragging');
            requestAnimationFrame(() => header.style.opacity = '0.5');
        };
        header.ondragend = () => { header.classList.remove('dragging'); header.style.opacity = '1'; };
        header.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; header.style.background = "#444"; };
        header.ondragleave = () => header.style.background = "";
        header.ondrop = (e) => {
            e.preventDefault(); e.stopPropagation(); header.style.background = "";
            const fromIndex = parseInt(e.dataTransfer.getData("text/plain"));
            
            this.studio.markUnsavedChanges();
            this.studio.historyManager.recordState();
            
            if (!isNaN(fromIndex) && fromIndex !== index) this.studio.reorderTracks(fromIndex, index);
        };
    }

    _bindLaneEvents(lane, track) {
        // Drag Over (Drop de Assets)
        lane.ondragover = (e) => { e.preventDefault(); lane.style.background = "rgba(255,255,255,0.1)"; };
        lane.ondragleave = () => { lane.style.background = ""; };
        lane.ondrop = (e) => {
            e.preventDefault(); lane.style.background = "";
            if (this.studio.draggedAsset) {
                const rect = lane.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const absoluteX = x + document.getElementById('studio-scroll-area').scrollLeft;
                const time = this._snapToFrame(Math.max(0, x / this.studio.project.zoom)); 
                
                this.studio.addAssetToTimeline(this.studio.draggedAsset, time);
                this.studio.draggedAsset = null;
            }
        };

        // Seek clicando no vazio da track
        lane.onmousedown = (e) => {
            if (e.target === lane) {
                this._clearSelection();
                this._startScrubbingInteraction(e); 
            }
        };
    }

    _startFader(e, clip, el, track) {
        const startY = e.clientY;
        const startLevel = clip.level;
        const height = el.clientHeight;
        const line = el.querySelector('.fader-line');
        const overlay = el.querySelector('.clip-opacity-overlay');
        const handle = el.querySelector('.fader-handle');
        const syncPreview = this.studio.playbackManager.syncPreview.bind(this.studio.playbackManager);

        const preFaderState = this.studio.historyManager._createSnapshot();
        let didChange = false;

        const onMove = (ev) => {
            const deltaY = ev.clientY - startY;
            const change = deltaY / Math.max(1, height);

            let newLevel = Math.max(0, Math.min(1, startLevel - change));

            // Atualiza somente se houve mudança significativa
            if (Math.abs((clip.level || 0) - newLevel) > 0.01) {
                clip.level = newLevel;
                didChange = true;

                const topPercent = (1 - newLevel) * 100;
                if (line) line.style.top = topPercent + "%";
                if (handle) handle.style.top = topPercent + "%";
                if (overlay) overlay.style.opacity = 1 - newLevel;
                if (handle) handle.title = `Nível: ${Math.round(newLevel*100)}%`;

                // atualiza fades visuais do próprio clipe
                this._updateFadeVisuals(clip, el);

                // redesenha a waveform em tempo-real (fast path)
                this._rerenderWaveformOfClip(clip, track);

                // sincroniza o player/preview
                if (syncPreview) syncPreview();
            }
        };

        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);

            if (didChange) {
                this.studio.historyManager.pushManualState(preFaderState);
            }
            this.studio.markUnsavedChanges();
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }

    _startMove(e, clickedClip, el) {
        const startX = e.clientX;
        const tracksContainer = document.getElementById('studio-tracks');
        const containerRect = tracksContainer.getBoundingClientRect();
        
        const preMoveState = this.studio.historyManager._createSnapshot();
        let didActuallyChange = false;

        if(el) {
            el.style.pointerEvents = 'none';
            el.style.zIndex = '100'; 
            el.style.opacity = '0.5'; 
        }

        // Prepara dados 
        const draggingItems = this.selectedClips.map(item => {
            const domEl = item.clip.id === clickedClip.id ? el : this._findDomElement(item.clip.id);
            let top = 0;
            if (domEl) {
                const r = domEl.getBoundingClientRect();
                top = (r.top - containerRect.top) + tracksContainer.scrollTop;
            }
            
            const originalState = { 
                fadeIn: item.clip.fadeIn || 0, 
                fadeOut: item.clip.fadeOut || 0 
            };

            // --- DETECÇÃO HEURÍSTICA DE CROSSFADE ---
            // Se o fade atual for igual à sobreposição com o vizinho, 
            // assumimos que foi gerado automaticamente e deve zerar ao separar.
            
            const track = this.studio.project.tracks.find(t => t.id === item.trackId);
            const myStart = item.clip.start;
            const myEnd = item.clip.start + item.clip.duration;
            const EPSILON = 0.05; // Tolerância de 50ms

            if (track) {
                // Checa Esquerda (Fade In vindo de um vizinho anterior)
                const leftNeighbor = track.clips.find(c => c.id !== item.clip.id && (c.start + c.duration) > (myStart + 0.01));
                if (leftNeighbor) {
                    const overlap = (leftNeighbor.start + leftNeighbor.duration) - myStart;
                    // Se existe overlap E o meu FadeIn é igual ao overlap...
                    if (overlap > 0 && Math.abs(item.clip.fadeIn - overlap) < EPSILON) {
                        originalState.fadeIn = 0; // O "verdadeiro" original é zero (hard cut)
                    }
                }

                // Checa Direita (Fade Out indo para um vizinho posterior)
                const rightNeighbor = track.clips.find(c => c.id !== item.clip.id && c.start < (myEnd - 0.01) && c.start > myStart);
                if (rightNeighbor) {
                    const overlap = myEnd - rightNeighbor.start;
                    // Se existe overlap E o meu FadeOut é igual ao overlap...
                    if (overlap > 0 && Math.abs(item.clip.fadeOut - overlap) < EPSILON) {
                        originalState.fadeOut = 0; // O "verdadeiro" original é zero
                    }
                }
            }

            return {
                clip: item.clip, 
                trackId: item.trackId, 
                startStart: item.clip.start, 
                originalFades: originalState, // Usa o estado corrigido
                el: domEl,
                top: top,
                height: domEl ? domEl.offsetHeight : 80
            };
        });

        // Mapa de vizinhos que também precisam ser resetados se a gente se afastar
        const neighborsOriginalFades = new Map();
        
        // Popula o mapa de vizinhos afetados
        draggingItems.forEach(item => {
            const track = this.studio.project.tracks.find(t => t.id === item.trackId);
            if(!track) return;
            
            const myStart = item.startStart;
            const myEnd = item.startStart + item.clip.duration;
            const EPSILON = 0.05;

            // Vizinho Esquerdo (que está fazendo FadeOut sobre mim)
            const leftNeighbor = track.clips.find(c => c.id !== item.clip.id && (c.start + c.duration) > (myStart + 0.01));
            if (leftNeighbor) {
                const overlap = (leftNeighbor.start + leftNeighbor.duration) - myStart;
                if (overlap > 0 && Math.abs(leftNeighbor.fadeOut - overlap) < EPSILON) {
                    neighborsOriginalFades.set(leftNeighbor.id, { 
                        fadeIn: leftNeighbor.fadeIn || 0, // Mantém o que tinha
                        fadeOut: 0, // Reseta o fadeOut se separar
                        trackId: item.trackId
                    });
                }
            }

            // Vizinho Direito (que está fazendo FadeIn sobre mim)
            const rightNeighbor = track.clips.find(c => c.id !== item.clip.id && c.start < (myEnd - 0.01) && c.start > myStart);
            if (rightNeighbor) {
                const overlap = myEnd - rightNeighbor.start;
                if (overlap > 0 && Math.abs(rightNeighbor.fadeIn - overlap) < EPSILON) {
                    neighborsOriginalFades.set(rightNeighbor.id, { 
                        fadeIn: 0, // Reseta o fadeIn se separar
                        fadeOut: rightNeighbor.fadeOut || 0,
                        trackId: item.trackId
                    });
                }
            }
        });

        const onMove = (ev) => {
            const deltaPx = ev.clientX - startX;
            if (Math.abs(deltaPx) < 2 && !didActuallyChange) return;
            didActuallyChange = true;
            
            const deltaTime = deltaPx / this.studio.project.zoom;
            const elementBelow = document.elementFromPoint(ev.clientX, ev.clientY);
            const trackEl = elementBelow ? elementBelow.closest('.track') : null;
            let targetTrackId = null;
            if (trackEl && trackEl.dataset.trackId) targetTrackId = trackEl.dataset.trackId;

            // --- PREPARAÇÃO DOS PONTOS DE SNAP ---
            const snapPoints = [];
            const tracksHeight = tracksContainer.scrollHeight;

            // A. Pontos das Tracks (Clipes existentes)
            this.studio.project.tracks.forEach(track => {
                track.clips.forEach(c => {
                    // Não dar snap em mim mesmo
                    if (draggingItems.some(t => t.clip.id === c.id)) return; 
                    
                    const cEl = this._findDomElement(c.id);
                    let top = 0, bottom = 0;
                    if (cEl) {
                        const r = cEl.getBoundingClientRect();
                        top = (r.top - containerRect.top) + tracksContainer.scrollTop;
                        bottom = (r.bottom - containerRect.top) + tracksContainer.scrollTop;
                    } else {
                        top = 0; bottom = tracksHeight; 
                    }

                    snapPoints.push({ time: c.start, top, bottom });
                    snapPoints.push({ time: c.start + c.duration, top, bottom });
                });
            });
            
            // Agulha
            snapPoints.push({ time: this.studio.project.currentTime, top: 0, bottom: tracksHeight });

            // Marcadores (Magnetismo Global)
            if (this.studio.project.markers) {
                this.studio.project.markers.forEach(m => {
                    snapPoints.push({ 
                        time: m.time, 
                        top: 0, 
                        bottom: tracksHeight, // Linha de snap cobre toda altura
                        isMarker: true // Flag opcional se quiser estilizar diferente
                    });
                });
            }

            const SNAP_THRESHOLD_PX = 15;
            const snapThresholdSec = SNAP_THRESHOLD_PX / this.studio.project.zoom;

            // --- CÁLCULO DE MOVIMENTO COM SNAP ---
            // (Calcula o delta efetivo baseado no snap do CLIPE PRINCIPAL que está sendo arrastado)
            
            // Item principal (o que foi clicado) guia o snap do grupo
            const mainItem = draggingItems.find(i => i.clip.id === clickedClip.id) || draggingItems[0];
            let rawMainStart = Math.max(0, mainItem.startStart + deltaTime);
            let rawMainEnd = rawMainStart + mainItem.clip.duration;

            let bestSnap = null;
            let minDist = Infinity;

            // Verifica Snap para o Início do Clipe
            for (const pt of snapPoints) {
                const dist = Math.abs(pt.time - rawMainStart);
                if (dist < snapThresholdSec && dist < minDist) {
                    minDist = dist;
                    bestSnap = { target: pt.time, type: 'start', ptObj: pt };
                }
            }
            // Verifica Snap para o Fim do Clipe
            for (const pt of snapPoints) {
                const dist = Math.abs(pt.time - rawMainEnd);
                if (dist < snapThresholdSec && dist < minDist) {
                    minDist = dist;
                    bestSnap = { target: pt.time - mainItem.clip.duration, type: 'end', ptObj: pt };
                }
            }

            let effectiveDelta = deltaTime; // Default sem snap

            if (bestSnap) {
                // Recalcula o delta exato para grudar no snap
                const snappedStart = bestSnap.target;
                effectiveDelta = snappedStart - mainItem.startStart;
                
                // Feedback Visual
                const lineTop = Math.min(mainItem.top, bestSnap.ptObj.top);
                const lineH = Math.max(mainItem.top + mainItem.height, bestSnap.ptObj.bottom) - lineTop;
                // Se for marcador ou agulha, desenha tela cheia
                const finalTop = (bestSnap.ptObj.bottom >= tracksHeight) ? 0 : lineTop;
                const finalH = (bestSnap.ptObj.bottom >= tracksHeight) ? tracksHeight : lineH;

                this._updateSnapLine(
                    (bestSnap.type === 'start' ? snappedStart : snappedStart + mainItem.clip.duration), 
                    true, finalTop, finalH
                );
            } else {
                this._updateSnapLine(0, false);
                // Se não tem snap magnético, aplica snap de frame no delta
                const desiredStart = mainItem.startStart + deltaTime;
                const snappedFrameStart = this._snapToFrame(desiredStart);
                effectiveDelta = snappedFrameStart - mainItem.startStart;
            }

            // --- APLICAÇÃO ---
            draggingItems.forEach(item => {
                const currentTrackId = targetTrackId && targetTrackId !== item.trackId ? targetTrackId : item.trackId;
                const trackRef = this.studio.project.tracks.find(t => t.id === currentTrackId);
                
                let newStart = Math.max(0, item.startStart + effectiveDelta);
                
                newStart = this._snapToFrame(newStart);

                // Troca de Trilha
                if (targetTrackId && targetTrackId !== item.trackId) {
                     const currentTrack = this.studio.project.tracks.find(t => t.id === item.trackId);
                     const targetTrack = this.studio.project.tracks.find(t => t.id === targetTrackId);
                     if (currentTrack && targetTrack && currentTrack.type === targetTrack.type) {
                         currentTrack.clips = currentTrack.clips.filter(c => c.id !== item.clip.id);
                         targetTrack.clips.push(item.clip);
                         const newLane = trackEl.querySelector('.track-lane');
                         if (newLane && item.el) newLane.appendChild(item.el);
                         item.trackId = targetTrackId;
                     }
                }
                
                item.clip.start = newStart;
                if (item.el) item.el.style.left = (newStart * this.studio.project.zoom) + "px";

                item.clip.fadeIn = item.originalFades.fadeIn;
                item.clip.fadeOut = item.originalFades.fadeOut;

                neighborsOriginalFades.forEach((fades, id) => {
                    const t = this.studio.project.tracks.find(tr => tr.id === fades.trackId);
                    const c = t ? t.clips.find(o => o.id === id) : null;
                    if(c) { c.fadeIn = fades.fadeIn; c.fadeOut = fades.fadeOut; }
                });

                // --- 3. RE-CÁLCULO: Se ainda houver colisão (overlap), reaplica o crossfade ---
                const activeTrack = this.studio.project.tracks.find(t => t.id === item.trackId);
                const otherClips = activeTrack ? activeTrack.clips.filter(c => c.id !== item.clip.id) : [];

                // Colisão Esquerda
                const leftNeighbor = otherClips.find(c => c.start < item.clip.start && (c.start + c.duration) > item.clip.start);
                if (leftNeighbor) {
                    const overlap = (leftNeighbor.start + leftNeighbor.duration) - item.clip.start;
                    if (overlap > 0.05) {
                        const safeOverlap = Math.min(overlap, leftNeighbor.duration, item.clip.duration);
                        leftNeighbor.fadeOut = safeOverlap; // Reaplica no vizinho
                        item.clip.fadeIn = safeOverlap;     // Reaplica em mim
                    }
                }

                // Colisão Direita
                const rightNeighbor = otherClips.find(c => c.start > item.clip.start && c.start < (item.clip.start + item.clip.duration));
                if (rightNeighbor) {
                     const overlap = (item.clip.start + item.clip.duration) - rightNeighbor.start;
                     if (overlap > 0.05) {
                        const safeOverlap = Math.min(overlap, rightNeighbor.duration, item.clip.duration);
                        item.clip.fadeOut = safeOverlap;    // Reaplica em mim
                        rightNeighbor.fadeIn = safeOverlap; // Reaplica no vizinho
                     }
                }

                // Atualiza Visuais (Meu e dos Vizinhos)
                if (item.el) this._updateFadeVisuals(item.clip, item.el);
                
                // Atualiza visual de quem está no mapa de reset
                neighborsOriginalFades.forEach((_, id) => {
                    const nEl = this._findDomElement(id);
                    const t = this.studio.project.tracks.find(tr => tr.id === _.trackId); // Usa trackId salvo
                    const c = t ? t.clips.find(o => o.id === id) : null;
                    if (nEl && c) this._updateFadeVisuals(c, nEl);
                });
                
                // Atualiza visual de novos vizinhos (caso tenha colidido com gente nova)
                if (leftNeighbor) { const el = this._findDomElement(leftNeighbor.id); if(el) this._updateFadeVisuals(leftNeighbor, el); }
                if (rightNeighbor) { const el = this._findDomElement(rightNeighbor.id); if(el) this._updateFadeVisuals(rightNeighbor, el); }
            });
            
            if(this.studio.playbackManager) this.studio.playbackManager.syncPreview();
            this._renderCrossfadeGuides();
        };

        const onUp = () => { 
            if(el) { el.style.pointerEvents = 'auto'; el.style.zIndex = ''; el.style.opacity = ''; }
            this._renderCrossfadeGuides(); 
            window.removeEventListener("mousemove", onMove); 
            window.removeEventListener("mouseup", onUp); 
            this._updateSnapLine(0, false);
            if (didActuallyChange) this.studio.historyManager.pushManualState(preMoveState);
            this.studio.markUnsavedChanges();
        };

        window.addEventListener("mousemove", onMove); 
        window.addEventListener("mouseup", onUp);
    }

    /**
     * Desenha linhas verticais nas extremidades da área de Crossfade (Interseção).
     */
    _updateCrossfadeGuides(start, end, visible, top = 0, height = 0) {
        let container = document.getElementById('timeline-crossfade-guides');
        const tracksContainer = document.getElementById('studio-tracks');
        
        if (!visible) {
            if (container) container.style.display = 'none';
            return;
        }

        if (!container) {
            container = document.createElement('div');
            container.id = 'timeline-crossfade-guides';
            container.style.cssText = `
                position: absolute; pointer-events: none; z-index: 9998; display: none;
            `;
            // Cria as duas linhas verticais internas
            const lineStyle = `
                position: absolute; top: 0; bottom: 0; width: 1px; 
                background: rgba(255, 255, 255, 0.8); 
                box-shadow: 0 0 4px rgba(0,0,0,0.5);
                border-left: 1px dashed rgba(255,255,255,0.5);
            `;
            container.innerHTML = `<div class="guide-left" style="${lineStyle}"></div><div class="guide-right" style="${lineStyle}"></div>`;
            if (tracksContainer) tracksContainer.appendChild(container);
        }

        if (tracksContainer && !tracksContainer.contains(container)) {
            tracksContainer.appendChild(container);
        }

        const headerOffset = 120; // Largura do header
        const x1 = (start * this.studio.project.zoom) + headerOffset;
        const x2 = (end * this.studio.project.zoom) + headerOffset;
        
        container.style.left = '0px';
        container.style.top = top + 'px';
        container.style.height = height + 'px';
        container.style.width = '100%'; // Ocupa largura para posicionar filhos absolutos

        const l1 = container.querySelector('.guide-left');
        const l2 = container.querySelector('.guide-right');
        
        if(l1) l1.style.left = x1 + "px";
        if(l2) l2.style.left = x2 + "px";
        
        container.style.display = 'block';
    }

    /**
     * Atualiza a linha guia magnética com offset corrigido e altura dinâmica.
     */
    _updateSnapLine(time, visible, top = 0, height = 0) {
        let line = document.getElementById('timeline-snap-guide');
        const tracksContainer = document.getElementById('studio-tracks');
        
        if (!visible) {
            if (line) line.style.display = 'none';
            return;
        }

        if (!line) {
            line = document.createElement('div');
            line.id = 'timeline-snap-guide';
            // Usa translateX(-50%) para centralizar o traço exato no pixel do tempo
            line.style.cssText = `
                position: absolute;
                width: 2px;
                background-color: #4fc3f7; 
                box-shadow: 0 0 8px #ff9800, 0 0 3px orange;
                z-index: 9999;
                pointer-events: none;
                display: none;
                transform: translateX(-50%);
            `;
            if (tracksContainer) tracksContainer.appendChild(line);
        }

        // Garante que esteja no container correto
        if (tracksContainer && !tracksContainer.contains(line)) {
            tracksContainer.appendChild(line);
        }

        const pos = time * this.studio.project.zoom;
        
        line.style.left = `${pos}px`;
        line.style.top = `${top}px`;
        line.style.height = `${height}px`;
        line.style.display = 'block';
    }

    _startResize(e, clip, el, baseDuration, actionStr = 'resize-right') {
        const startX = e.clientX; 
        
        // Estado Inicial
        const initialStart = clip.start;
        const initialDuration = clip.duration;
        const initialEnd = initialStart + initialDuration;
        const initialOffset = clip.offset || 0;
        const isLeft = (actionStr === 'resize-left');

        const tracksContainer = document.getElementById('studio-tracks');
        const containerRect = tracksContainer.getBoundingClientRect();
        const zoom = this.studio.project.zoom; 

        const activeRect = el.getBoundingClientRect();
        const activeTop = (activeRect.top - containerRect.top) + tracksContainer.scrollTop;
        const activeBottom = (activeRect.bottom - containerRect.top) + tracksContainer.scrollTop;

        // 1. Identificação de Alvos (Targets)
        const targets = [];
        
        const addTarget = (c, element, t) => {
            if (!targets.some(existing => existing.clip.id === c.id)) {
                targets.push({ 
                    clip: c, 
                    el: element, 
                    track: t,
                    // Guarda o estado inicial individual de cada clipe do grupo
                    initStart: c.start,
                    initDur: c.duration,
                    initOffset: c.offset || 0
                });
            }
        };

        // Lógica de Grupo Inteligente
        if (clip.groupId) {
            this.studio.project.tracks.forEach(track => {
                track.clips.forEach(c => {
                    if (c.groupId === clip.groupId) {
                        const EPSILON = 0.05; // Tolerância de 50ms
                        
                        // Verifica alinhamento das bordas
                        const sameStart = Math.abs(c.start - initialStart) < EPSILON;
                        const cEnd = c.start + c.duration;
                        const sameEnd = Math.abs(cEnd - initialEnd) < EPSILON;

                        let shouldResize = false;

                        if (isLeft) {
                            // Se estou mexendo na Esquerda, puxa quem começa junto
                            if (sameStart) shouldResize = true;
                        } else {
                            // Se estou mexendo na Direita, puxa quem termina junto
                            if (sameEnd) shouldResize = true;
                        }

                        if (shouldResize) {
                            const domEl = c.id === clip.id ? el : this._findDomElement(c.id);
                            addTarget(c, domEl, track);
                        }
                    }
                });
            });
        }
        
        // Se não achou ninguém (ou não tem grupo), adiciona a si mesmo
        if (!targets.some(t => t.clip.id === clip.id)) {
            const track = this.studio.project.tracks.find(t => t.clips.some(c => c.id === clip.id));
            addTarget(clip, el, track);
        }

        // Mapeamento de Pontos Magnéticos (SNAP POINTS)
        const snapPoints = [];
        const tracksHeight = tracksContainer.scrollHeight;
        
        // Outros Clips
        this.studio.project.tracks.forEach(track => {
            track.clips.forEach(c => {
                // Não dar snap nos clipes que estão sendo redimensionados
                if (targets.some(t => t.clip.id === c.id)) return; 
                
                const cEl = this._findDomElement(c.id);
                let top = 0, bottom = 0;
                if (cEl) {
                    const r = cEl.getBoundingClientRect();
                    top = (r.top - containerRect.top) + tracksContainer.scrollTop;
                    bottom = (r.bottom - containerRect.top) + tracksContainer.scrollTop;
                } else {
                    top = 0; bottom = tracksHeight; 
                }

                snapPoints.push({ time: c.start, top, bottom });
                snapPoints.push({ time: c.start + c.duration, top, bottom });
            });
        });
        
        // Agulha
        snapPoints.push({ time: this.studio.project.currentTime, top: 0, bottom: tracksHeight });

        // Marcadores
        if (this.studio.project.markers) {
            this.studio.project.markers.forEach(m => {
                snapPoints.push({ 
                    time: m.time, 
                    top: 0, 
                    bottom: tracksHeight 
                });
            });
        }
        
        const preResizeState = this.studio.historyManager._createSnapshot();
        let didResize = false;
        const SNAP_THRESHOLD_PX = 15; 

        const onMove = (ev) => {
            const deltaPx = ev.clientX - startX;
            if (Math.abs(deltaPx) < 2 && !didResize) return;
            didResize = true;
            
            const deltaSec = deltaPx / zoom;
            
            // Variáveis de controle mestre
            let masterNewStart = initialStart;
            let masterNewDur = initialDuration;

            // Função helper para achar melhor snap
            const findBestSnap = (targetTime) => {
                let best = null;
                let minDist = Infinity;
                for (const pt of snapPoints) {
                    const distPx = Math.abs(pt.time - targetTime) * zoom;
                    if (distPx < SNAP_THRESHOLD_PX && distPx < minDist) {
                        minDist = distPx;
                        best = pt;
                    }
                }
                return best;
            };

            if (isLeft) {
                // --- RESIZE ESQUERDA (Start) ---
                let rawNewStart = initialStart + deltaSec;
                let bestSnap = findBestSnap(rawNewStart);
                
                if (bestSnap) {
                    rawNewStart = bestSnap.time;
                    const guideTop = (bestSnap.bottom > tracksHeight - 10) ? 0 : Math.min(activeTop, bestSnap.top);
                    const guideH = (bestSnap.bottom > tracksHeight - 10) ? tracksHeight : Math.max(activeBottom, bestSnap.bottom) - guideTop;
                    this._updateSnapLine(bestSnap.time, true, guideTop, guideH);
                } else {
                    rawNewStart = this._snapToFrame(rawNewStart);
                    this._updateSnapLine(0, false);
                }

                // Cálculo do Delta Efetivo (quanto mudou em relação ao inicio original)
                const effectiveDelta = rawNewStart - initialStart;
                
                // Aplica limite mínimo de duração no mestre para não inverter
                if ((initialDuration - effectiveDelta) < (1/30)) {
                    rawNewStart = initialStart + initialDuration - (1/30);
                } else {
                    masterNewStart = rawNewStart;
                }

                // Aplica a TODOS os targets baseado no delta efetivo
                targets.forEach(target => {
                    let newS = target.initStart + effectiveDelta;
                    let newD = target.initDur - effectiveDelta;
                    let newO = target.initOffset + effectiveDelta;

                    if (newO < 0) { // Proteção de offset negativo
                        newS = target.initStart - target.initOffset;
                        newD = target.initDur + target.initOffset; // Compensa
                        newO = 0;
                    }
                    
                    if (newD < (1/30)) return; // Proteção mínima

                    target.clip.start = newS;
                    target.clip.duration = newD;
                    target.clip.offset = newO;
                });

            } else {
                // --- RESIZE DIREITA (Duration) ---
                let rawWidth = Math.max(10, (initialDuration * zoom) + deltaPx);
                let rawDur = rawWidth / zoom;
                const projectedEnd = initialStart + rawDur;
                
                let bestSnap = findBestSnap(projectedEnd);
                
                if (bestSnap) {
                    // Recalcula duração baseada no snap point final
                    masterNewDur = bestSnap.time - initialStart;
                    const guideTop = (bestSnap.bottom > tracksHeight - 10) ? 0 : Math.min(activeTop, bestSnap.top);
                    const guideH = (bestSnap.bottom > tracksHeight - 10) ? tracksHeight : Math.max(activeBottom, bestSnap.bottom) - guideTop;
                    this._updateSnapLine(bestSnap.time, true, guideTop, guideH);
                } else {
                    masterNewDur = this._snapToFrame(rawDur);
                    this._updateSnapLine(0, false);
                }
                
                if (masterNewDur < (1/30)) masterNewDur = (1/30);

                // Delta de duração em relação ao original
                const durationDelta = masterNewDur - initialDuration;

                // Aplica a TODOS os targets
                targets.forEach(target => {
                    const newD = Math.max(1/30, target.initDur + durationDelta);
                    target.clip.duration = newD;
                });
            }

            // --- ATUALIZAÇÃO VISUAL EM LOTE ---
            targets.forEach(target => {
                const tClip = target.clip;
                const tEl = target.el;
                const tTrack = target.track;

                if ((tClip.fadeIn + tClip.fadeOut) > tClip.duration) {
                     if (tClip.fadeIn > tClip.duration) tClip.fadeIn = tClip.duration;
                     tClip.fadeOut = Math.max(0, tClip.duration - tClip.fadeIn);
                }

                if (tClip.type === 'subtitle' && tClip.transcriptionData && tClip.transcriptionData.length > 0) {
                    const lastWord = tClip.transcriptionData[tClip.transcriptionData.length - 1];
                    const contentEndTime = lastWord.end; 
                    const clipEndTime = tClip.offset + tClip.duration; 
                    tClip.needsTranscription = (clipEndTime > (contentEndTime + 0.5));
                }

                if (tEl) {
                    tEl.style.left = (tClip.start * zoom) + "px";
                    tEl.style.width = (tClip.duration * zoom) + "px";
                    this._updateFadeVisuals(tClip, tEl);

                    // Redesenha conteúdo (Thumbnails/Waveform/LoopMarkers)
                    let tAsset = this.studio.project.assets.find(a => a.id === tClip.assetId);
                    
                    if (!tAsset && tClip.type === 'subtitle') {
                        tAsset = { id: 'virtual_subtitle', type: 'subtitle', baseDuration: tClip.duration + tClip.offset };
                    }

                    if (tAsset) {
                        const isAudioTrack = tTrack && tTrack.type === 'audio';

                        // 1. Loop Markers
                        if (tAsset.baseDuration > 0) {
                            const baseDur = tAsset.baseDuration;
                            const oldMarkers = tEl.querySelectorAll('.loop-marker');
                            for(let m of oldMarkers) m.remove();
                            
                            if (baseDur < (tClip.duration + tClip.offset - 0.01)) {
                                const totalTime = tClip.duration + tClip.offset;
                                const loops = Math.floor(totalTime / baseDur);
                                for(let i=1; i<=loops; i++) {
                                    const timePoint = i * baseDur;
                                    const relativePixel = (timePoint - tClip.offset) * zoom;
                                    if (relativePixel > 0 && relativePixel < (tClip.duration * zoom)) {
                                        const m = document.createElement("div");
                                        m.className = "loop-marker loop-vinco";
                                        m.style.left = relativePixel + "px";
                                        m.style.cssText = `position: absolute; top: 0; bottom: 0; width: 1px; background-color: rgba(255, 255, 255, 0.5); border-left: 2px dashed rgba(0, 0, 0, 0.5); z-index: 10; pointer-events: none;`;
                                        tEl.appendChild(m);
                                    }
                                }
                            }
                        }

                        // 2. Waveform vs Thumbnails
                        if (tAsset.type === 'audio' || isAudioTrack) {
                             const repeater = tEl.querySelector('.waveform-repeater');
                             if (repeater) {
                                 const offsetX = tClip.offset * zoom;
                                 repeater.style.transform = `translateX(-${offsetX}px)`;
                                 
                                 const baseDur = tAsset.baseDuration;
                                 const totalRequiredTime = tClip.offset + tClip.duration;
                                 const requiredLoops = Math.ceil(totalRequiredTime / baseDur);
                                 const currentLoops = repeater.children.length;
                                 const baseWaveWidth = baseDur * zoom;
                                 
                                 if (requiredLoops > currentLoops && tAsset._waveformBaseCanvas) {
                                     for(let k=currentLoops; k<requiredLoops; k++) {
                                         const clone = document.createElement("canvas");
                                         clone.width = tAsset._waveformBaseCanvas.width;
                                         clone.height = tAsset._waveformBaseCanvas.height;
                                         clone.getContext('2d').drawImage(tAsset._waveformBaseCanvas, 0, 0);
                                         clone.style.width = `${baseWaveWidth}px`;
                                         clone.style.height = "100%";
                                         repeater.appendChild(clone);
                                     }
                                     repeater.style.width = `${baseWaveWidth * requiredLoops}px`;
                                 }
                             }
                        } 
                        else if (tAsset.type === 'video' || tAsset.type === 'image') {
                             const visuals = tEl.querySelector('.clip-visuals');
                             if(visuals) this._renderThumbnails(tAsset, visuals, tClip.duration, zoom);
                        }
                    }
                }
            });

            if(this.studio.playbackManager) this.studio.playbackManager.syncPreview();
            this._renderCrossfadeGuides();
        };

        const onUp = () => { 
            window.removeEventListener("mousemove", onMove); 
            window.removeEventListener("mouseup", onUp); 
            this._updateSnapLine(0, false); 
            if (didResize) this.studio.historyManager.pushManualState(preResizeState);
            this.renderTracks();
            this.studio.markUnsavedChanges();
        };

        window.addEventListener("mousemove", onMove); 
        window.addEventListener("mouseup", onUp);
    }

    // =========================================================================
    // COMANDOS DE EDIÇÃO (Add, Delete, Split)
    // =========================================================================

    addClipToTrack(trackId, asset, startTime, providedGroupId = null) {
        const track = this.studio.project.tracks.find(t => t.id === trackId);
        if (!track) return;
        if (track.type === 'video' && asset.type === 'audio') return alert("Não pode por áudio em track de vídeo");
        
        const clip = {
            id: "clip_" + Date.now() + Math.random().toString(36).substr(2, 5),
            assetId: asset.id, 
            start: startTime, 
            offset: 0, 
            duration: asset.baseDuration, 
            type: asset.type, 
            name: asset.name, 
            level: 1.0, 
            groupId: providedGroupId
        };
        
        this.studio.markUnsavedChanges();
        track.clips.push(clip);
        this.renderTracks();
        this.studio.historyManager.recordState();
    }

    deleteClips() {
        if (this.selectedClips.length === 0) return;
        
        this.selectedClips.forEach(sel => {
            const track = this.studio.project.tracks.find(t => t.id === sel.trackId);
            if (track) track.clips = track.clips.filter(c => c.id !== sel.clip.id);
        });
        
        this.selectedClips = [];
        this.studio.markUnsavedChanges();
        this.renderTracks();
        this.studio.historyManager.recordState();
    }

    splitClip() {
        // Validação Inicial
        if (this.selectedClips.length === 0) return;
        
        // Usa o primeiro clipe selecionado como referência para o tempo (cursor)
        const primarySelection = this.selectedClips[0];
        const cursorTime = this.studio.project.currentTime;
        
        // Identificação do Escopo (Grupo ou Individual)
        let clipsToSplit = [];
        const groupId = primarySelection.clip.groupId;

        if (groupId) {
            this.studio.project.tracks.forEach(track => {
                track.clips.forEach(clip => {
                    if (clip.groupId === groupId) {
                        clipsToSplit.push({ clip, track });
                    }
                });
            });
        } else {
            const track = this.studio.project.tracks.find(t => t.id === primarySelection.trackId);
            if (track) {
                clipsToSplit.push({ clip: primarySelection.clip, track });
            }
        }

        const newRightGroupId = groupId ? "group_" + Date.now() + "_R" : null;
        
        let didSplit = false;
        const newlyCreatedClips = [];

        // Processamento do Corte
        clipsToSplit.forEach(({ clip, track }) => {
            // Verifica se o cursor está DENTRO do clipe (margem 10ms)
            if (cursorTime > (clip.start + 0.01) && cursorTime < (clip.start + clip.duration - 0.01)) {
                
                const relativeSplitPoint = cursorTime - clip.start;
                const oldDuration = clip.duration;
                
                // --- Ajusta o Clipe Original (Lado Esquerdo) ---
                clip.duration = relativeSplitPoint;
                
                // --- Cria o Novo Clipe (Lado Direito) ---
                // Deep clone para preservar configs (Style, Transform, etc)
                const newClip = JSON.parse(JSON.stringify(clip));
                
                newClip.id = "clip_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
                newClip.start = cursorTime;
                newClip.duration = oldDuration - relativeSplitPoint;
                newClip.offset = clip.offset + relativeSplitPoint;
                newClip.groupId = newRightGroupId;

                // --- Lógica Especial para Legendas (Word-Level Split) ---
                if (clip.type === 'subtitle' && Array.isArray(clip.transcriptionData)) {
                    const absoluteSplitPointAsset = clip.offset + relativeSplitPoint;
                    const allWords = clip.transcriptionData;
                    
                    let leftWords, rightWords;

                    // Isso evita que um lado fique "zumbi" (sem dados) se o usuário cortar no silêncio.
                    if (allWords.length === 1) {
                        leftWords = [...allWords];
                        rightWords = [...allWords];
                    } else {
                        // Lógica de Interseção para frases longas:
                        // Esquerda: Palavras que começam antes do corte
                        leftWords = allWords.filter(w => w.start < absoluteSplitPointAsset);
                        
                        // Direita: Palavras que terminam DEPOIS do corte
                        // (Garante que palavras cortadas no meio apareçam também na direita para continuidade)
                        rightWords = allWords.filter(w => w.end > absoluteSplitPointAsset);
                    }

                    // Atualiza os dados nos objetos
                    clip.transcriptionData = leftWords;
                    newClip.transcriptionData = rightWords;
                }

                track.clips.push(newClip);
                newlyCreatedClips.push({ clip: newClip, trackId: track.id });
                
                didSplit = true;
            }
        });

        // 4. Finalização
        if (didSplit) {
            this._clearSelection();
            this.studio.markUnsavedChanges();
            this.renderTracks(); 
            
            // Seleciona o lado direito para facilitar fluxo de edição
            newlyCreatedClips.forEach(item => {
                this._addToSelection(item.clip, item.trackId);
            });
            
            this.studio.historyManager.recordState();
        }
    }
}
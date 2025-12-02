import { getHeaderWidth } from '../utils.js'; // fmtTime removido, usaremos formatação interna SMPTE

const FPS = 30;
const FRAME_DURATION = 1 / FPS;

export class TimelineManager {
    constructor(studio) {
        this.studio = studio;
        this.selectedClips = [];
        this.isScrubbing = false;
        this.lastFocusedClipId = null;

        // Cache para virtualização da régua
        this.rulerTicksData = []; 
        this.lastRenderedRange = { start: -1, end: -1 };
    }

    init() {
        this._bindEvents();
        // Inicializa com zoom ajustado
        this.setZoom(this.studio.project.zoom - 1);
    }

    _bindEvents() {
        const scrollArea = document.getElementById('studio-scroll-area');
        if (scrollArea) {
            scrollArea.addEventListener('scroll', () => {
                this._syncRuler(scrollArea.scrollLeft);
            });
            
            scrollArea.addEventListener('wheel', (e) => {
                if (e.ctrlKey) {
                    // Zoom logic placeholder
                }

                e.preventDefault();
                    
                const project = this.studio.project;
                const oldZoom = project.zoom;
                
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                let newZoom = oldZoom * delta;

                newZoom = Math.max(10, Math.min(newZoom, 600));

                if (newZoom === oldZoom) return;

                const currentTime = project.currentTime;
                const oldPlayheadPixelPos = currentTime * oldZoom;
                const offsetFromLeftEdge = oldPlayheadPixelPos - scrollArea.scrollLeft;

                this.setZoom(newZoom);

                const newPlayheadPixelPos = currentTime * newZoom;
                scrollArea.scrollLeft = newPlayheadPixelPos - offsetFromLeftEdge;
            });
        }

        // Seek na Régua
        const ruler = document.getElementById('timeline-ruler-container');
        if(ruler) {
            ruler.onmousedown = (e) => {
                const ticks = document.querySelector('.ruler-ticks');
                const rect = ticks.getBoundingClientRect();
                
                this.isScrubbing = true;
                let didMove = false;
                
                const onMove = (mv) => {
                    didMove = true; 
                    const mx = mv.clientX - rect.left;
                    // Conversão Frame-Perfect
                    const rawTime = Math.max(0, mx / this.studio.project.zoom);
                    this._seekToTime(this._snapToFrame(rawTime));
                };
                
                const onUp = (upEvent) => {
                    this.isScrubbing = false;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    
                    if (!didMove) {
                        const x = upEvent.clientX - rect.left;
                        if (x >= 0) {
                            const rawTime = Math.max(0, x / this.studio.project.zoom);
                            this._seekToTime(this._snapToFrame(rawTime));
                        }
                    }
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            };
        }

        // Atalhos de Teclado
        document.addEventListener('keydown', (e) => {
            if (!this.studio.isActive) return;

            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
            
            if (e.code === 'Space') { 
                e.preventDefault(); 
                this.studio.playbackManager.togglePlayback(); 
            }

            // Navegação Frame a Frame
            if (e.code === 'ArrowLeft') {
                e.preventDefault();
                this._stepPlayhead(-1); 
            }
            if (e.code === 'ArrowRight') {
                e.preventDefault();
                this._stepPlayhead(1); 
            }

            if (e.code === 'KeyS') this.splitClip();
            if (e.code === 'Delete') this.deleteClips();
            
            if (e.code === 'KeyG') this.groupClips();
            if (e.code === 'KeyU') this.ungroupClips();
        });
    }

    // =========================================
    // LÓGICA DE TEMPO E FRAMES (Novo Core)
    // =========================================

    /**
     * Arredonda um tempo flutuante para o frame exato mais próximo.
     * Ex: 1.03333 -> 1.0333333 (Frame 31)
     */
    _snapToFrame(time) {
        const frameIndex = Math.round(time * FPS);
        return frameIndex / FPS;
    }

    /**
     * Formata o tempo em HH:MM:SS;FF (SMPTE style)
     */
    _fmtSMPTE(time) {
        const totalFrames = Math.round(time * FPS);
        
        const frames = totalFrames % FPS;
        const totalSeconds = Math.floor(totalFrames / FPS);
        const seconds = totalSeconds % 60;
        const minutes = Math.floor(totalSeconds / 60) % 60;
        const hours = Math.floor(totalSeconds / 3600);

        const pad = (n) => n.toString().padStart(2, '0');

        // Se houver horas, mostra, senão simplifica para MM:SS;FF
        if (hours > 0) {
            return `${pad(hours)}:${pad(minutes)}:${pad(seconds)};${pad(frames)}`;
        }
        return `${pad(minutes)}:${pad(seconds)};${pad(frames)}`;
    }

    _stepPlayhead(direction) {
        // Avança ou retrocede exatamente 1 frame
        const currentFrame = Math.round(this.studio.project.currentTime * FPS);
        const newFrame = currentFrame + direction;
        const newTime = Math.max(0, newFrame / FPS);
        
        this._seekToTime(newTime);
        this._ensurePlayheadVisible();
    }

    _ensurePlayheadVisible() {
        const scrollArea = document.getElementById('studio-scroll-area');
        if (!scrollArea) return;

        const playheadPos = this.studio.project.currentTime * this.studio.project.zoom;
        const startVisible = scrollArea.scrollLeft;
        const endVisible = startVisible + scrollArea.clientWidth;

        if (playheadPos < startVisible) {
            scrollArea.scrollLeft = playheadPos - 50;
        } else if (playheadPos > endVisible) {
            scrollArea.scrollLeft = playheadPos - scrollArea.clientWidth + 50;
        }
    }

    /**
     * Define os intervalos da régua baseados em FRAMES.
     * Retorna o intervalo em frames (major e minor).
     */
    _getFrameIntervals(zoom) {
        // Zoom = pixels por segundo
        // 1 frame = 1/30s.
        // Se zoom = 300px/s, 1 frame = 10px (visível)
        // Se zoom = 30px/s, 1 frame = 1px (muito denso)
        
        let majorFrames, minorFrames, showMinor;

        if (zoom >= 200) { 
            // Super Zoom: Mostra cada frame
            majorFrames = 5;  // Marca forte a cada 5 frames
            minorFrames = 1;  // Marca fraca a cada 1 frame
            showMinor = true;
        } else if (zoom >= 100) {
            majorFrames = 15; // Meio segundo
            minorFrames = 5;  // 5 frames
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

    // =========================================
    // SELEÇÃO E GRUPOS (Mantido)
    // =========================================

    groupClips() {
        if (this.selectedClips.length < 2) return;
        const newGroupId = "group_" + Date.now();
        this.selectedClips.forEach(selection => selection.clip.groupId = newGroupId);
        console.log("Clips vinculados:", newGroupId);
    }
    ungroupClips() {
        if (this.selectedClips.length === 0) return;
        this.selectedClips.forEach(selection => selection.clip.groupId = null);
        if (this.lastFocusedClipId) {
            const toDeselect = this.selectedClips.filter(s => s.clip.id !== this.lastFocusedClipId);
            toDeselect.forEach(item => {
                const domEl = this._findDomElement(item.clip.id);
                if(domEl) domEl.classList.remove('selected');
            });
            this.selectedClips = this.selectedClips.filter(s => s.clip.id === this.lastFocusedClipId);
        }
    }
    _handleSelection(e, clip, trackId, el) {
        this.lastFocusedClipId = clip.id;
        const alreadySelected = this.selectedClips.some(s => s.clip.id === clip.id);
        if (e.ctrlKey) {
            if (alreadySelected) {
                this._removeFromSelection(clip.id);
                if (clip.groupId) this._deselectGroup(clip.groupId);
            } else {
                this._addToSelection(clip, trackId, el);
                if (clip.groupId) this._selectGroup(clip.groupId);
            }
        } else {
            if (!alreadySelected) {
                this._clearSelection();
                this._addToSelection(clip, trackId, el);
                if (clip.groupId) this._selectGroup(clip.groupId);
            }
        }
    }
    _addToSelection(clip, trackId, domElement = null) {
        if (!this.selectedClips.some(s => s.clip.id === clip.id)) {
            this.selectedClips.push({ clip, trackId });
            const el = domElement || this._findDomElement(clip.id);
            if (el) el.classList.add('selected');
        }
    }
    _removeFromSelection(clipId) {
        const domEl = this._findDomElement(clipId);
        if (domEl) domEl.classList.remove('selected');
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
            if(domEl) domEl.classList.remove('selected');
        });
        this.selectedClips = [];
    }
    _findDomElement(clipId) {
        return document.querySelector(`.clip[data-clip-id="${clipId}"]`);
    }

    // =========================================
    // RENDERIZAÇÃO E ZOOM
    // =========================================

    setZoom(newZoom) {
        this.studio.project.zoom = Math.max(1, Math.min(newZoom, 600));
        const slider = document.getElementById('studio-zoom-slider');
        if (slider) slider.value = this.studio.project.zoom;
        
        this.renderRuler();
        this.renderTracks();
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
        }
    }

    renderRuler() {
        const container = document.querySelector('.ruler-ticks');
        if(!container) return;
        
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
        
        // Intervalos em segundos para o loop
        const majorSec = majorFrames / FPS;
        const minorSec = minorFrames / FPS;

        this.rulerTicksData = [];
        let t = 0;
        
        // Renderiza baseado em FRAMES para evitar erro de float point acumulado
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
                    label: null // Minors não têm label para limpar a UI
                });
            }

            // Otimização: Avança pelo menor intervalo visível
            // Se showMinor for false, avança direto pelo major
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

    renderTracks() {
        const container = document.getElementById("studio-tracks");
        if(!container) return;
        container.innerHTML = "";
        this._renderAddTrackButton();
        const maxTime = this._getMaxTimelineTime();
        const totalWidth = (maxTime * this.studio.project.zoom) + getHeaderWidth() + 500;
        const wrapper = document.getElementById('timeline-content-wrapper');
        if(wrapper) wrapper.style.width = totalWidth + "px";

        this.studio.project.tracks.forEach((track, index) => {
            const el = document.createElement("div");
            el.className = `track ${track.type}`;
            el.dataset.trackId = track.id;
            el.dataset.index = index;
            el.innerHTML = `
                <div class="track-header" draggable="true">
                    <div class="drag-handle"><i class="fa-solid fa-bars"></i></div>
                    <input type="text" class="track-name-input" value="${track.name}" />
                    <div class="track-type-icon"><i class="fa-solid ${track.type==='video'?'fa-video':'fa-volume-high'}"></i></div>
                </div>
                <div class="track-lane"></div>
            `;
            const lane = el.querySelector(".track-lane");
            const header = el.querySelector(".track-header");
            const nameInput = el.querySelector(".track-name-input");
            nameInput.onchange = (e) => { track.name = e.target.value; };
            nameInput.onmousedown = (e) => e.stopPropagation();
            this._bindTrackReorderEvents(header, index);
            this._bindLaneEvents(lane, track);
            track.clips.forEach(clip => {
                const clipEl = this._createClipElement(clip, track.id);
                lane.appendChild(clipEl);
            });
            container.appendChild(el);
        });
        this.renderRuler();
        this.studio.playbackManager.updatePlayhead();
    }
    
    _renderAddTrackButton() {
        const spacer = document.querySelector('.ruler-header-spacer');
        if (!spacer) return;
        spacer.innerHTML = "";
        const container = document.createElement('div');
        container.className = "track-add-dropdown-container";
        container.innerHTML = `
            <button class="btn-add-track-header" title="Adicionar Track"><i class="fa-solid fa-plus"></i> Track</button>
            <div class="dropdown-content-header">
                <a href="#" data-type="video"><i class="fa-solid fa-video"></i> Video Track</a>
                <a href="#" data-type="audio"><i class="fa-solid fa-volume-high"></i> Audio Track</a>
            </div>
        `;
        const btn = container.querySelector('.btn-add-track-header');
        const content = container.querySelector('.dropdown-content-header');
        btn.onclick = (e) => { e.stopPropagation(); content.classList.toggle('show'); };
        if (!window.hasGlobalDropdownListener) {
            window.addEventListener('click', () => {
                document.querySelectorAll('.dropdown-content-header.show').forEach(el => el.classList.remove('show'));
            });
            window.hasGlobalDropdownListener = true;
        }
        container.querySelectorAll('a').forEach(link => {
            link.onclick = (e) => {
                e.preventDefault();
                this.studio.addTrack(e.currentTarget.dataset.type);
                content.classList.remove('show');
            };
        });
        spacer.appendChild(container);
    }
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
            if (!isNaN(fromIndex) && fromIndex !== index) this.studio.reorderTracks(fromIndex, index);
        };
    }

    _bindLaneEvents(lane, track) {
        lane.ondragover = (e) => { e.preventDefault(); lane.style.background = "rgba(255,255,255,0.1)"; };
        lane.ondragleave = () => { lane.style.background = ""; };
        lane.ondrop = (e) => {
            e.preventDefault(); lane.style.background = "";
            if (this.studio.draggedAsset) {
                const rect = lane.getBoundingClientRect();
                const x = e.clientX - rect.left;
                // Snap no Drop também
                const time = this._snapToFrame(Math.max(0, x / this.studio.project.zoom));
                this.studio.addAssetToTimeline(this.studio.draggedAsset, time);
                this.studio.draggedAsset = null;
            }
        };

        lane.onmousedown = (e) => {
            if(e.target === lane) {
                this.isScrubbing = true;
                const rect = lane.getBoundingClientRect();
                let didMove = false;

                const handle = (ev) => {
                    didMove = true; 
                    const x = ev.clientX - rect.left;
                    // Snap no arrasto
                    const rawTime = Math.max(0, x / this.studio.project.zoom);
                    this._seekToTime(this._snapToFrame(rawTime));
                };
                
                const onMove = (ev) => { if(this.isScrubbing) handle(ev); };
                const onUp = (ev) => {
                    this.isScrubbing = false;
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    
                    this._clearSelection();

                    if(!didMove) {
                        const x = ev.clientX - rect.left;
                        // Snap no click
                        const rawTime = Math.max(0, x / this.studio.project.zoom);
                        this._seekToTime(this._snapToFrame(rawTime));
                    }
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            }
        };
    }

    _createClipElement(clip, trackId) {
        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if(!asset) return document.createElement('div');

        const el = document.createElement("div");
        el.className = `clip type-${clip.type}`;
        el.dataset.clipId = clip.id;
        
        const isSelected = this.selectedClips.some(s => s.clip.id === clip.id);
        if (isSelected) el.classList.add('selected');
        
        el.style.left = (clip.start * this.studio.project.zoom) + "px";
        el.style.width = (clip.duration * this.studio.project.zoom) + "px";
        
        const faderTop = (1 - clip.level) * 100;
        const isVideo = clip.type === 'video';

        el.innerHTML = `
            <div class="fader-handle" data-action="fader" style="top: ${faderTop}%" title="Nível: ${Math.round(clip.level*100)}%"></div>
            <div class="fader-line" style="top: ${faderTop}%"></div>
            ${isVideo ? `<div class="clip-opacity-overlay" style="opacity: ${1 - clip.level}"></div>` : ''}
            
            <div class="clip-name">${clip.name}</div>
            <div class="resize-handle right" data-action="resize"></div>
        `;

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
            
            const startX = e.clientX;
            const startY = e.clientY;

            this._handleSelection(e, clip, trackId, el);
            
            const action = e.target.dataset.action;
            if (action === 'resize') {
                this._startResize(e, clip, el, asset.baseDuration);
            } else if (action === 'fader') {
                this._startFader(e, clip, el);
            } else {
                this._startMove(e, clip, el);
            }

            const onMouseUpCheck = (ev) => {
                const dist = Math.sqrt(Math.pow(ev.clientX - startX, 2) + Math.pow(ev.clientY - startY, 2));
                if (dist < 5) {
                    const lane = el.closest('.track-lane');
                    if (lane) {
                        const rect = lane.getBoundingClientRect();
                        const x = ev.clientX - rect.left;
                        // Snap no click do clipe
                        const rawTime = Math.max(0, x / this.studio.project.zoom);
                        this._seekToTime(this._snapToFrame(rawTime));
                    }
                }
                window.removeEventListener('mouseup', onMouseUpCheck);
            };
            window.addEventListener('mouseup', onMouseUpCheck);
        };
        return el;
    }

    _seekToTime(time) {
        this.studio.project.currentTime = time;
        this.studio.playbackManager.updatePlayhead();
        this.studio.playbackManager.syncPreview();
        this.lastSeekTime = time; 
        this.playedSinceLastSeek = false; 
    }

    _seekToPixel(x) {
        const trackX = x; 
        const rawTime = Math.max(0, (trackX - 120) / this.studio.project.zoom);
        // Garante snap ao mover a agulha via clique externo (se houver)
        this._seekToTime(this._snapToFrame(rawTime));
    }
    
    _startFader(e, clip, el) {
        const startY = e.clientY;
        const startLevel = clip.level;
        const height = el.clientHeight;
        const line = el.querySelector('.fader-line');
        const overlay = el.querySelector('.clip-opacity-overlay');
        const handle = el.querySelector('.fader-handle');
        const syncPreview = this.studio.playbackManager.syncPreview.bind(this.studio.playbackManager);

        const onMove = (ev) => {
            const deltaY = ev.clientY - startY;
            const change = deltaY / height;
            let newLevel = Math.max(0, Math.min(1, startLevel - change));
            clip.level = newLevel;
            const topPercent = (1 - newLevel) * 100;
            if(line) line.style.top = topPercent + "%";
            if(handle) handle.style.top = topPercent + "%";
            if(overlay) overlay.style.opacity = 1 - newLevel;
            if(handle) handle.title = `Nível: ${Math.round(newLevel*100)}%`;
            syncPreview();
        };
        const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    }

    _startMove(e, clickedClip, el) {
        const startX = e.clientX;
        el.style.pointerEvents = 'none';
        const draggingItems = this.selectedClips.map(item => {
            const domEl = item.clip.id === clickedClip.id ? el : this._findDomElement(item.clip.id);
            return {
                clip: item.clip, trackId: item.trackId, startStart: item.clip.start, el: domEl
            };
        });
        const onMove = (ev) => {
            const deltaPx = ev.clientX - startX;
            const deltaTime = deltaPx / this.studio.project.zoom;
            
            const elementBelow = document.elementFromPoint(ev.clientX, ev.clientY);
            const trackEl = elementBelow ? elementBelow.closest('.track') : null;
            let targetTrackId = null;
            if (trackEl && trackEl.dataset.trackId) targetTrackId = trackEl.dataset.trackId; 
            
            draggingItems.forEach(item => {
                let rawNewStart = Math.max(0, item.startStart + deltaTime);
                let newStart = this._snapToFrame(rawNewStart); // Snap do Clipe!
                
                item.clip.start = newStart;
                if (item.el) item.el.style.left = (newStart * this.studio.project.zoom) + "px";
                
                if (targetTrackId && targetTrackId !== item.trackId) { 
                    const currentTrack = this.studio.project.tracks.find(t => t.id === item.trackId);
                    const targetTrack = this.studio.project.tracks.find(t => t.id === targetTrackId);
                    if (currentTrack && targetTrack && currentTrack.type === targetTrack.type) {
                        currentTrack.clips = currentTrack.clips.filter(c => c.id !== item.clip.id);
                        targetTrack.clips.push(item.clip);
                        const newLane = trackEl.querySelector('.track-lane');
                        if (newLane && item.el) newLane.appendChild(item.el);
                        item.trackId = targetTrackId;
                        const selRef = this.selectedClips.find(s => s.clip.id === item.clip.id);
                        if (selRef) selRef.trackId = targetTrackId;
                    }
                }
            });
        };
        const onUp = () => { 
            if(el) el.style.pointerEvents = 'auto'; 
            window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); 
            this.renderTracks(); 
        };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    }

    _startResize(e, clip, el, baseDuration) {
        const startX = e.clientX; 
        const startW = clip.duration * this.studio.project.zoom;
        const onMove = (ev) => {
            let newW = Math.max(10, startW + (ev.clientX - startX));
            const rawDur = newW / this.studio.project.zoom;
            const newDur = this._snapToFrame(rawDur); // Snap no redimensionamento
            
            clip.duration = newDur;
            el.style.width = (newDur * this.studio.project.zoom) + "px"; // Atualiza com a largura snappada
        };
        const onUp = () => { 
            window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); 
            this.renderTracks();
        };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    }

    addClipToTrack(trackId, asset, startTime, providedGroupId = null) {
        const track = this.studio.project.tracks.find(t => t.id === trackId);
        if (!track) return;
        if (track.type === 'video' && asset.type === 'audio') return alert("Não pode por áudio em track de vídeo");
        const clip = {
            id: "clip_" + Date.now() + Math.random().toString(36).substr(2, 5),
            assetId: asset.id, start: startTime, offset: 0, duration: asset.baseDuration, 
            type: asset.type, name: asset.name, level: 1.0, groupId: providedGroupId
        };
        track.clips.push(clip);
        this.renderTracks();
    }
    deleteClips() {
        if (this.selectedClips.length === 0) return;
        this.selectedClips.forEach(sel => {
            const track = this.studio.project.tracks.find(t => t.id === sel.trackId);
            if (track) track.clips = track.clips.filter(c => c.id !== sel.clip.id);
        });
        this.selectedClips = [];
        this.renderTracks();
    }
    splitClip() {
        const targetClip = this.selectedClips.length > 0 ? this.selectedClips[0].clip : null;
        const targetTrackId = this.selectedClips.length > 0 ? this.selectedClips[0].trackId : null;
        if (!targetClip) return;
        const time = this.studio.project.currentTime;
        if (time <= targetClip.start || time >= (targetClip.start + targetClip.duration)) return;
        const relativeSplit = time - targetClip.start;
        const oldDuration = targetClip.duration;
        targetClip.duration = relativeSplit;
        const track = this.studio.project.tracks.find(t => t.id === targetTrackId);
        const newClip = {
            ...targetClip, id: "clip_" + Date.now(),
            start: time, duration: oldDuration - relativeSplit, offset: targetClip.offset + relativeSplit
        };
        track.clips.push(newClip);
        this._clearSelection(); 
        this.renderTracks();
    }
}
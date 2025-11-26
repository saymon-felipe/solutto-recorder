import { getHeaderWidth, fmtTime } from '../utils.js';

export class TimelineManager {
    constructor(studio) {
        this.studio = studio;
        this.selectedClips = []; // Array para suportar multi-seleção
        this.isScrubbing = false;
        this.lastFocusedClipId = null; // Para lógica de desvincular/isolamento
    }

    init() {
        this._bindEvents();
    }

    _bindEvents() {
        // Zoom com Scroll + Ctrl
        const scrollArea = document.getElementById('studio-scroll-area');
        if (scrollArea) {
            scrollArea.addEventListener('wheel', (e) => {
                if (e.ctrlKey) {
                    e.preventDefault();
                    const delta = e.deltaY > 0 ? 0.9 : 1.1;
                    this.setZoom(this.studio.project.zoom * delta);
                }
            });
        }

        // Seek na Régua
        const ruler = document.getElementById('timeline-ruler-container');
        if(ruler) {
            ruler.onmousedown = (e) => {
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

        // Atalhos de Teclado
        document.addEventListener('keydown', (e) => {
            if (!this.studio.isActive) return;
            
            if (e.code === 'Space') { 
                e.preventDefault(); 
                this.studio.playbackManager.togglePlayback(); 
            }
            if (e.code === 'KeyS') this.splitClip();
            if (e.code === 'Delete') this.deleteClips();
            
            if (e.code === 'KeyG') this.groupClips();
            if (e.code === 'KeyU') this.ungroupClips();
        });
    }

    // =========================================
    // GRUPOS E SELEÇÃO
    // =========================================

    groupClips() {
        if (this.selectedClips.length < 2) return;
        const newGroupId = "group_" + Date.now();
        this.selectedClips.forEach(selection => {
            selection.clip.groupId = newGroupId;
        });
        console.log("Clips vinculados:", newGroupId);
    }

    ungroupClips() {
        if (this.selectedClips.length === 0) return;
        
        this.selectedClips.forEach(selection => {
            selection.clip.groupId = null;
        });

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
        groupItems.forEach(item => {
            this._removeFromSelection(item.clip.id);
        });
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
    // RENDERIZAÇÃO
    // =========================================

    setZoom(newZoom) {
        this.studio.project.zoom = Math.max(1, Math.min(newZoom, 600));
        const slider = document.getElementById('studio-zoom-slider');
        if (slider) slider.value = this.studio.project.zoom;
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
        
        this._renderAddTrackButton();

        const totalWidth = (this.studio.project.duration * this.studio.project.zoom) + getHeaderWidth() + 500;
        const wrapper = document.getElementById('timeline-content-wrapper');
        if(wrapper) wrapper.style.width = totalWidth + "px";

        this.studio.project.tracks.forEach((track, index) => {
            const el = document.createElement("div");
            el.className = `track ${track.type}`;
            el.dataset.trackId = track.id; // CRÍTICO: ID numérico
            el.dataset.index = index; // Importante para reorder

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
        
        this.studio.playbackManager.updatePlayhead();
    }

    _renderAddTrackButton() {
        const spacer = document.querySelector('.ruler-header-spacer');
        if (!spacer) return;
        spacer.innerHTML = "";
        
        const container = document.createElement('div');
        container.className = "track-add-dropdown-container";
        container.innerHTML = `
            <button class="btn-add-track-header" title="Adicionar Track">
                <i class="fa-solid fa-plus"></i> Track
            </button>
            <div class="dropdown-content-header">
                <a href="#" data-type="video"><i class="fa-solid fa-video"></i> Video Track</a>
                <a href="#" data-type="audio"><i class="fa-solid fa-volume-high"></i> Audio Track</a>
            </div>
        `;

        const btn = container.querySelector('.btn-add-track-header');
        const content = container.querySelector('.dropdown-content-header');

        btn.onclick = (e) => {
            e.stopPropagation();
            content.classList.toggle('show');
        };

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
        header.ondragend = () => {
            header.classList.remove('dragging');
            header.style.opacity = '1';
        };
        header.ondragover = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            header.style.background = "#444";
        };
        header.ondragleave = () => header.style.background = "";
        header.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            header.style.background = "";
            const fromIndex = parseInt(e.dataTransfer.getData("text/plain"));
            if (!isNaN(fromIndex) && fromIndex !== index) {
                this.studio.reorderTracks(fromIndex, index);
            }
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
                const time = Math.max(0, x / this.studio.project.zoom);
                this.studio.addAssetToTimeline(this.studio.draggedAsset, time);
                this.studio.draggedAsset = null;
            }
        };

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
                
                this._clearSelection();
            }
        };
    }

    // =========================================
    // CRIAÇÃO DE CLIPES E EVENTOS
    // =========================================

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
            
            const rect = el.getBoundingClientRect();
            const x = e.clientX - rect.left + (clip.start * this.studio.project.zoom); 
            
            this._seekToPixel(x);

            this._handleSelection(e, clip, trackId, el);
            
            const action = e.target.dataset.action;
            if (action === 'resize') {
                this._startResize(e, clip, el, asset.baseDuration);

                const endTime = clip.start + clip.duration;
                this._seekToTime(endTime);
            } else if (action === 'fader') {
                this._startFader(e, clip, el);
            } else {
                this._startMove(e, clip, el);
            }
        };
        return el;
    }

    _seekToTime(time) {
        this.studio.project.currentTime = time;
        this.studio.playbackManager.updatePlayhead();
        this.studio.playbackManager.syncPreview();
        this.lastSeekTime = time; 
        this.playedSinceLastSeek = false; // Resetar para o play/pause inteligente
    }

    _seekToPixel(x) {
        const trackX = x; 
        const time = Math.max(0, trackX / this.studio.project.zoom);
        this._seekToTime(time);
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
        
        const onUp = () => { 
            window.removeEventListener("mousemove", onMove); 
            window.removeEventListener("mouseup", onUp); 
        };
        window.addEventListener("mousemove", onMove); 
        window.addEventListener("mouseup", onUp);
    }

    _startMove(e, clickedClip, el) {
        const startX = e.clientX;
        
        el.style.pointerEvents = 'none';

        const draggingItems = this.selectedClips.map(item => {
            const domEl = item.clip.id === clickedClip.id ? el : this._findDomElement(item.clip.id);
            return {
                clip: item.clip,
                trackId: item.trackId,
                startStart: item.clip.start,
                el: domEl
            };
        });

        const onMove = (ev) => {
            const deltaPx = ev.clientX - startX;
            const deltaTime = deltaPx / this.studio.project.zoom;

            // 1. Detecta Track sob o mouse
            const elementBelow = document.elementFromPoint(ev.clientX, ev.clientY);
            const trackEl = elementBelow ? elementBelow.closest('.track') : null;

            let targetTrackId = null;

            if (trackEl && trackEl.dataset.trackId) {
                targetTrackId = trackEl.dataset.trackId; 
            }

            draggingItems.forEach(item => {
                // A. Movimento Horizontal
                let newStart = Math.max(0, item.startStart + deltaTime);
                item.clip.start = newStart;
                
                if (item.el) {
                    item.el.style.left = (newStart * this.studio.project.zoom) + "px";
                }

                // B. Movimento Vertical (Troca de Track)
                if (targetTrackId && targetTrackId !== item.trackId) { 
                    const currentTrack = this.studio.project.tracks.find(t => t.id === item.trackId);
                    const targetTrack = this.studio.project.tracks.find(t => t.id === targetTrackId);
                    
                    // Valida tipo compatível (Video->Video ou Audio->Audio)
                    if (currentTrack && targetTrack && currentTrack.type === targetTrack.type) {
                        // Move DOM e Modelo (como no código completo)
                        currentTrack.clips = currentTrack.clips.filter(c => c.id !== item.clip.id);
                        targetTrack.clips.push(item.clip);
                        
                        const newLane = trackEl.querySelector('.track-lane');
                        if (newLane && item.el) {
                            newLane.appendChild(item.el);
                        }
                        
                        // Atualiza referências
                        item.trackId = targetTrackId;
                        const selRef = this.selectedClips.find(s => s.clip.id === item.clip.id);
                        if (selRef) selRef.trackId = targetTrackId;
                    }
                }
            });
        };
        
        const onUp = () => { 
            if(el) el.style.pointerEvents = 'auto'; // Restaura eventos
            window.removeEventListener("mousemove", onMove); 
            window.removeEventListener("mouseup", onUp); 
            this.renderTracks(); // Renderiza final para garantir consistência
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }

    _startResize(e, clip, el, baseDuration) {
        const startX = e.clientX; 
        const startW = clip.duration * this.studio.project.zoom;
        
        const onMove = (ev) => {
            let newW = Math.max(10, startW + (ev.clientX - startX));
            const newDur = newW / this.studio.project.zoom;
            
            clip.duration = newDur;
            el.style.width = newW + "px";
        };
        
        const onUp = () => { 
            window.removeEventListener("mousemove", onMove); 
            window.removeEventListener("mouseup", onUp); 
            this.renderTracks();
        };
        window.addEventListener("mousemove", onMove); 
        window.addEventListener("mouseup", onUp);
    }

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
            start: time, duration: oldDuration - relativeSplit,
            offset: targetClip.offset + relativeSplit
        };
        track.clips.push(newClip);
        this._clearSelection(); 
        this.renderTracks();
    }
}
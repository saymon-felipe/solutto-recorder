import { getHeaderWidth, fmtTime } from '../utils.js';

/**
 * Gerencia a interação, renderização e manipulação lógica da Timeline do Studio.
 * Responsável por lidar com eventos de mouse, zoom, seleção, agrupamento e
 * operações CRUD (Create, Read, Update, Delete) nos clipes.
 */
export class TimelineManager {
    /**
     * @param {Object} studio - Instância principal do StudioManager.
     */
    constructor(studio) {
        this.studio = studio;
        this.selectedClips = []; 
        this.isScrubbing = false;
        
        // Rastreia o último clipe clicado para gerenciar o foco em operações de grupo
        this.lastFocusedClipId = null;
    }

    init() {
        this._bindEvents();
    }

    /**
     * Configura os ouvintes de eventos globais da timeline (Zoom, Ruler, Teclado).
     */
    _bindEvents() {
        // Controle de Zoom com Scroll + Ctrl
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

        // Navegação pela Régua (Scrubbing)
        const ruler = document.getElementById('timeline-ruler-container');
        if (ruler) {
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

            // Espaço: Play/Pause
            if (e.code === 'Space') {
                e.preventDefault();
                this.studio.playbackManager.togglePlayback();
            }
            // S: Split (Cortar)
            if (e.code === 'KeyS') this.splitClip();
            
            // Delete: Remover
            if (e.code === 'Delete') this.deleteClips();

            // G: Group (Vincular)
            if (e.code === 'KeyG') this.groupClips();

            // U: Ungroup (Desvincular)
            if (e.code === 'KeyU') this.ungroupClips();
        });
    }

    // =========================================
    // LÓGICA DE GRUPO
    // =========================================

    /**
     * Vincula os clipes selecionados atribuindo-lhes um groupId único.
     */
    groupClips() {
        if (this.selectedClips.length < 2) return;
        
        const newGroupId = "group_" + Date.now();
        
        this.selectedClips.forEach(selection => {
            selection.clip.groupId = newGroupId;
        });
        
        console.log("Clips vinculados:", newGroupId);
    }

    /**
     * Desvincula os clipes selecionados e isola a seleção no último item focado.
     */
    ungroupClips() {
        if (this.selectedClips.length === 0) return;
        
        // 1. Remove o groupId de TODOS os selecionados
        this.selectedClips.forEach(selection => {
            selection.clip.groupId = null;
        });

        // 2. Mantém selecionado apenas o último clipe clicado (Foco)
        if (this.lastFocusedClipId) {
            const toDeselect = this.selectedClips.filter(s => s.clip.id !== this.lastFocusedClipId);
            
            // Atualiza o DOM removendo a classe visual
            toDeselect.forEach(item => {
                const domEl = this._findDomElement(item.clip.id);
                if(domEl) domEl.classList.remove('selected');
            });

            // Atualiza o estado da seleção
            this.selectedClips = this.selectedClips.filter(s => s.clip.id === this.lastFocusedClipId);
        }

        console.log("Clips desvinculados e seleção isolada.");
    }

    // =========================================
    // RENDERIZAÇÃO
    // =========================================

    /**
     * Define o nível de zoom e atualiza a interface.
     * @param {number} newZoom - Pixels por segundo.
     */
    setZoom(newZoom) {
        this.studio.project.zoom = Math.max(1, Math.min(newZoom, 600));
        const zoomSlider = document.getElementById('studio-zoom-slider');
        if (zoomSlider) zoomSlider.value = this.studio.project.zoom;
        
        this.renderRuler();
        this.renderTracks();
        this.studio.playbackManager.updatePlayhead();
    }

    /**
     * Renderiza a régua de tempo baseada no zoom atual.
     */
    renderRuler() {
        const container = document.querySelector('.ruler-ticks');
        if (!container) return;
        
        container.innerHTML = '';
        container.style.width = (this.studio.project.duration * this.studio.project.zoom) + "px";

        let interval = 1;
        if (this.studio.project.zoom < 10) interval = 10;
        if (this.studio.project.zoom > 50) interval = 0.5;

        for (let t = 0; t <= this.studio.project.duration; t += interval) {
            const pos = t * this.studio.project.zoom;
            const tick = document.createElement('div');
            const isMajor = Math.abs(t % 1) < 0.001;
            
            tick.className = `tick ${isMajor ? 'major' : 'minor'}`;
            tick.style.left = pos + "px";
            if (isMajor) tick.innerText = fmtTime(t);
            
            container.appendChild(tick);
        }
    }

    /**
     * Renderiza todas as trilhas e seus respectivos clipes.
     */
    renderTracks() {
        const container = document.getElementById("studio-tracks");
        if (!container) return;
        container.innerHTML = "";

        const totalWidth = (this.studio.project.duration * this.studio.project.zoom) + getHeaderWidth() + 500;
        const wrapper = document.getElementById('timeline-content-wrapper');
        if (wrapper) wrapper.style.width = totalWidth + "px";

        this.studio.project.tracks.forEach(track => {
            const el = document.createElement("div");
            el.className = `track ${track.type}`;
            el.innerHTML = `<div class="track-header"><div class="track-name">${track.name}</div></div><div class="track-lane"></div>`;
            const lane = el.querySelector(".track-lane");

            this._bindLaneEvents(lane, track);

            track.clips.forEach(clip => {
                const clipEl = this._createClipElement(clip, track.id);
                lane.appendChild(clipEl);
            });
            container.appendChild(el);
        });

        this.studio.playbackManager.updatePlayhead();
    }

    /**
     * Configura eventos de Drag & Drop e Scrubbing na área vazia da trilha.
     */
    _bindLaneEvents(lane, track) {
        // Efeitos visuais de Drag
        lane.ondragover = (e) => { e.preventDefault(); lane.style.background = "rgba(255,255,255,0.1)"; };
        lane.ondragleave = () => { lane.style.background = ""; };
        
        // Drop de Assets na Timeline
        lane.ondrop = (e) => {
            e.preventDefault(); lane.style.background = "";
            if (this.studio.draggedAsset) {
                const rect = lane.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const time = Math.max(0, x / this.studio.project.zoom);

                // Adiciona o asset usando a lógica inteligente (separa áudio/vídeo se necessário)
                this.studio.addAssetToTimeline(this.studio.draggedAsset, time);

                this.studio.draggedAsset = null;
            }
        };

        // Scrubbing ao clicar na área vazia e limpeza de seleção
        lane.onmousedown = (e) => {
            if (e.target === lane) {
                this.isScrubbing = true;
                const handle = (ev) => {
                    const rect = lane.getBoundingClientRect();
                    const x = ev.clientX - rect.left;
                    this.studio.project.currentTime = Math.max(0, x / this.studio.project.zoom);
                    this.studio.playbackManager.updatePlayhead();
                    this.studio.playbackManager.syncPreview();
                };
                
                handle(e);
                
                const onMove = (ev) => { if (this.isScrubbing) handle(ev); };
                const onUp = () => {
                    this.isScrubbing = false;
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                };
                
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);

                // Limpa seleção global ao clicar no vazio
                this.selectedClips = [];
                document.querySelectorAll('.clip.selected').forEach(c => c.classList.remove('selected'));
            }
        };
    }

    // =========================================
    // GESTÃO DE CLIPES (DOM & EVENTOS)
    // =========================================

    /**
     * Cria o elemento DOM para um clipe e anexa seus eventos.
     */
    _createClipElement(clip, trackId) {
        const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
        if(!asset) return document.createElement('div');

        const el = document.createElement("div");
        el.className = `clip type-${clip.type}`;
        el.dataset.clipId = clip.id; // Identificador para busca no DOM
        
        // Aplica estado visual de seleção
        const isSelected = this.selectedClips.some(s => s.clip.id === clip.id);
        if (isSelected) el.classList.add('selected');
        
        // Posicionamento e Dimensão
        el.style.left = (clip.start * this.studio.project.zoom) + "px";
        el.style.width = (clip.duration * this.studio.project.zoom) + "px";
        
        // Cálculo visual do Fader
        const faderTopPercent = (1 - clip.level) * 100;

        el.innerHTML = `
            <div class="fader-handle" data-action="fader" style="top: ${faderTopPercent}%" title="Nível: ${Math.round(clip.level*100)}%"></div>
            <div class="fader-line" style="top: ${faderTopPercent}%"></div>
            <div class="clip-opacity-overlay" style="opacity: ${1 - clip.level}"></div>
            <div class="clip-name">${clip.name}</div>
            <div class="resize-handle right" data-action="resize"></div>
        `;

        // Renderiza marcadores de Loop se necessário
        if (clip.duration > asset.baseDuration) {
            const loops = Math.floor(clip.duration / asset.baseDuration);
            for(let i=1; i<=loops; i++) {
                const m = document.createElement("div");
                m.className = "loop-marker";
                m.style.left = (i * asset.baseDuration * this.studio.project.zoom) + "px";
                el.appendChild(m);
            }
        }

        // Eventos de Mouse do Clipe
        el.onmousedown = (e) => {
            e.stopPropagation(); 
            
            // Gerencia seleção (Simples, Ctrl, Grupo)
            this._handleSelection(e, clip, trackId, el);

            const action = e.target.dataset.action;
            if (action === 'resize') {
                 this._startResize(e, clip, el, asset.baseDuration);
            } 
            else if (action === 'fader') {
                 this._startFader(e, clip, el);
            } 
            else {
                 this._startMove(e, clip, trackId); 
            }
        };
        return el;
    }

    /**
     * Gerencia a lógica de seleção de clipes (Único, Múltiplo, Toggle).
     */
    _handleSelection(e, clip, trackId, el) {
        this.lastFocusedClipId = clip.id;

        const alreadySelected = this.selectedClips.some(s => s.clip.id === clip.id);
        
        if (e.ctrlKey) {
            // Modo Toggle (Adicionar/Remover)
            if (alreadySelected) {
                this._removeFromSelection(clip.id);
                if (clip.groupId) this._deselectGroup(clip.groupId);
            } else {
                this._addToSelection(clip, trackId, el);
                if (clip.groupId) this._selectGroup(clip.groupId);
            }
        } else {
            // Modo Simples (Substituir Seleção)
            if (!alreadySelected) {
                this._clearSelection();
                this._addToSelection(clip, trackId, el);
                
                // Seleciona automaticamente o grupo vinculado
                if (clip.groupId) {
                    this._selectGroup(clip.groupId);
                }
            }
            // Se já selecionado, não faz nada aqui para permitir arraste em grupo
        }
    }

    _removeFromSelection(clipId) {
        const domEl = this._findDomElement(clipId);
        if (domEl) domEl.classList.remove('selected');
        this.selectedClips = this.selectedClips.filter(s => s.clip.id !== clipId);
    }

    _addToSelection(clip, trackId, domElement = null) {
        if (!this.selectedClips.some(s => s.clip.id === clip.id)) {
            this.selectedClips.push({ clip, trackId });
            
            if (domElement) {
                domElement.classList.add('selected');
            } else {
                const el = this._findDomElement(clip.id);
                if (el) el.classList.add('selected');
            }
        }
    }

    /**
     * Seleciona todos os clipes que compartilham o mesmo groupId.
     */
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

    /**
     * Remove da seleção todos os clipes de um grupo específico.
     */
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
    // FERRAMENTAS (FADER, MOVE, RESIZE)
    // =========================================

    _startFader(e, clip, el) {
        const startY = e.clientY;
        const startLevel = clip.level;
        
        const height = el.clientHeight; 
        const handleHeight = 4;
        const travelDistance = height - handleHeight;

        const onMove = (ev) => {
            const deltaY = ev.clientY - startY;
            const change = deltaY / travelDistance; 
            
            let newLevel = Math.max(0, Math.min(1, startLevel - change));
            clip.level = newLevel;
            
            // Atualização visual
            const handle = el.querySelector('.fader-handle');
            const line = el.querySelector('.fader-line');
            const overlay = el.querySelector('.clip-opacity-overlay');
            
            // Calcula posição em pixels para precisão
            const newPosPx = (1 - newLevel) * travelDistance;
            
            if(handle) {
                handle.style.top = `${newPosPx}px`;
                handle.title = `Nível: ${Math.round(newLevel*100)}%`;
            }
            if(line) line.style.top = ((1 - newLevel) * 100) + "%";
            if(overlay) overlay.style.opacity = 1 - newLevel;

            this._updatePreviewLevels(clip);
        };
        
        const onUp = () => { 
            window.removeEventListener("mousemove", onMove); 
            window.removeEventListener("mouseup", onUp); 
        };
        window.addEventListener("mousemove", onMove); 
        window.addEventListener("mouseup", onUp);
    }

    _updatePreviewLevels(clip) {
        const pVideo = this.studio.playbackManager.previewVideo;
        const pAudio = this.studio.playbackManager.previewAudio;
        if (pVideo && pVideo.dataset.currentClipId === clip.id) pVideo.style.opacity = clip.level;
        if (pAudio && pAudio.dataset.currentClipId === clip.id) pAudio.volume = clip.level;
    }

    _startMove(e, clickedClip = null, clickedTrackId = null) {
        const startX = e.clientX;
        let hasMoved = false;
        
        // Mapeia posições iniciais de todos os selecionados
        const initialPositions = this.selectedClips.map(item => ({
            clip: item.clip,
            start: item.clip.start
        }));

        const onMove = (ev) => {
            const deltaPx = ev.clientX - startX;
            
            // Threshold para considerar movimento (evita tremores no clique)
            if (Math.abs(deltaPx) > 2) hasMoved = true;

            if (hasMoved) {
                const deltaTime = deltaPx / this.studio.project.zoom;
                initialPositions.forEach(item => {
                    let newStart = Math.max(0, item.start + deltaTime);
                    item.clip.start = newStart;
                });
                this.renderTracks();
            }
        };
        
        const onUp = () => { 
            window.removeEventListener("mousemove", onMove); 
            window.removeEventListener("mouseup", onUp); 
            
            // Se foi apenas um clique (sem arraste) e sem Ctrl, isola a seleção neste item
            if (!hasMoved && !e.ctrlKey && clickedClip) {
                this._clearSelection();
                this._addToSelection(clickedClip, clickedTrackId);
                if (clickedClip.groupId) this._selectGroup(clickedClip.groupId);
            }
        };
        
        window.addEventListener("mousemove", onMove); 
        window.addEventListener("mouseup", onUp);
    }

    _startResize(e, clip, el, base) {
        const startX = e.clientX; 
        const startW = clip.duration * this.studio.project.zoom;
        
        const onMove = (ev) => {
            let newW = Math.max(10, startW + (ev.clientX - startX));
            clip.duration = newW / this.studio.project.zoom;
            this.renderTracks();
        };
        
        const onUp = () => { 
            window.removeEventListener("mousemove", onMove); 
            window.removeEventListener("mouseup", onUp); 
        };
        window.addEventListener("mousemove", onMove); 
        window.addEventListener("mouseup", onUp);
    }

    // =========================================
    // CRUD DE CLIPES
    // =========================================

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
            if (track) {
                track.clips = track.clips.filter(c => c.id !== sel.clip.id);
            }
        });

        this.selectedClips = [];
        this.renderTracks();
    }

    splitClip() {
        if (this.selectedClips.length === 0) return;

        // Cria cópia do array para iterar com segurança
        const targets = [...this.selectedClips];
        let didSplit = false;
        const time = this.studio.project.currentTime;

        targets.forEach(sel => {
            const { clip, trackId } = sel;
            // Só corta se a agulha estiver dentro do tempo do clipe
            if (time > clip.start && time < (clip.start + clip.duration)) {
                const relativeSplit = time - clip.start;
                const oldDuration = clip.duration;
                
                // Ajusta clipe original (Esquerda)
                clip.duration = relativeSplit;

                // Cria novo clipe (Direita)
                const track = this.studio.project.tracks.find(t => t.id === trackId);
                const newClip = {
                    ...clip,
                    id: "clip_" + Date.now() + Math.random(),
                    start: time,
                    duration: oldDuration - relativeSplit,
                    offset: clip.offset + relativeSplit
                };
                track.clips.push(newClip);
                didSplit = true;
            }
        });

        if (didSplit) {
            this.selectedClips = []; 
            this.renderTracks();
        }
    }
}
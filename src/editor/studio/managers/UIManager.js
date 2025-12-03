export class UIManager {
    constructor(studio) {
        this.studio = studio;
    }

    buildUI() {
        const div = document.createElement("div");
        div.id = "studio-app";

        const styles = `
            <style>
                .vegas-modal {
                    background-color: #2d2d30;
                    color: #e0e0e0;
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    border: 1px solid #3e3e42;
                    box-shadow: 0 0 20px rgba(0,0,0,0.5);
                    width: 500px;
                    max-width: 95%;
                    border-radius: 4px;
                }
                .vegas-header {
                    background-color: #3e3e42;
                    padding: 8px 15px;
                    font-size: 13px;
                    font-weight: 600;
                    border-bottom: 1px solid #1e1e1e;
                    display: flex; justify-content: space-between; align-items: center;
                }
                .vegas-body { padding: 20px; }
                .vegas-stats-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 15px;
                    margin-bottom: 15px;
                    background: #1e1e1e;
                    padding: 10px;
                    border: 1px solid #3f3f46;
                }
                .vegas-stat-item { display: flex; flex-direction: column; font-size: 11px; color: #aaa; }
                .vegas-stat-value { font-size: 14px; color: #fff; font-family: 'Consolas', 'Monaco', monospace; margin-top: 2px; }
                
                .vegas-progress-track {
                    height: 18px;
                    background-color: #1e1e1e;
                    border: 1px solid #3f3f46;
                    position: relative;
                    margin-bottom: 8px;
                }
                .vegas-progress-fill {
                    height: 100%;
                    background: linear-gradient(to bottom, #00b7eb, #007acc); /* Azul Profissional */
                    width: 0%;
                    transition: width 0.2s;
                }
                .vegas-log-box {
                    font-family: 'Consolas', monospace;
                    font-size: 10px;
                    color: #888;
                    margin-top: 5px;
                    height: 16px;
                    overflow: hidden;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                }
                .vegas-btn-abort {
                    width: 100%;
                    background: #3e3e42;
                    border: 1px solid #555;
                    color: #e0e0e0;
                    padding: 6px;
                    font-size: 12px;
                    cursor: pointer;
                    margin-top: 15px;
                }
                .vegas-btn-abort:hover { background: #c42b1c; border-color: #c42b1c; color: white; }
            </style>
        `;
        
        div.innerHTML = styles + `
            <div class="studio-toolbar">
                <div style="font-weight:bold;">Solutto Studio</div>
                
                <button class="studio-btn" id="btn-studio-save" title="Salvar Projeto">
                    <i class="fa-solid fa-floppy-disk"></i> Salvar
                </button>

                <div class="zoom-control">
                    <i class="fa-solid fa-minus"></i>
                    <input type="range" id="studio-zoom-slider" min="5" max="600" value="100">
                    <i class="fa-solid fa-plus"></i>
                </div>
                <div style="flex:1"></div>
                <button class="studio-btn" id="btn-studio-add"><i class="fa-solid fa-plus"></i> Adicionar Mídia</button>
                <button class="studio-btn primary" id="btn-studio-render"><i class="fa-solid fa-file-export"></i> Renderizar</button>
                <button class="studio-btn" id="btn-studio-close"><i class="fa-solid fa-times"></i></button>
            </div>
            
            <div class="studio-workspace">
                <div class="studio-bin">
                    <div class="bin-tabs">
                        <button class="bin-tab active" data-target="bin-media">Mídia</button>
                        <button class="bin-tab" data-target="bin-projects">Projetos</button>
                    </div>
                    
                    <div class="bin-content" id="studio-bin-list"></div>
                    
                    <div class="bin-content hidden" id="studio-projects-list">
                        <div style="padding:10px; color:#888; font-size:11px; text-align:center">Nenhum projeto recente</div>
                    </div>
                </div>
                
                <div class="preview-container">
                    <div class="studio-preview">
                        <div id="studio-preview-container"></div>
                    </div>
                    <div class="preview-controls">
                        <button class="control-btn" id="btn-stop"><i class="fa-solid fa-stop"></i></button>
                        <button class="control-btn" id="btn-play-pause"><i class="fa-solid fa-play"></i></button>
                        <span id="studio-time-display" class="time-display">00:00.0</span>
                    </div>
                </div>
            </div>

            <div class="studio-timeline">
                <div class="timeline-ruler-container" id="timeline-ruler-container">
                    <div class="ruler-header-spacer"></div>
                    <div class="ruler-ticks"></div>
                </div>
                
                <div class="timeline-scroll-area" id="studio-scroll-area">
                    <div class="timeline-content-wrapper" id="timeline-content-wrapper">
                        <div class="timeline-playhead-overlay" id="timeline-playhead-overlay">
                            <div class="playhead-line"></div>
                            <div class="playhead-knob"></div>
                        </div>

                        <div id="studio-tracks"></div>
                    </div>
                </div>
            </div>
            
            <input type="file" id="studio-upload" multiple style="display:none" accept="video/*,audio/*,image/*">
            
            <div id="studio-status-bar" class="status-bar hidden">
                <div class="status-spinner"></div>
                <span id="studio-status-text">Processando...</span>
            </div>

            <div id="render-modal" class="modal-overlay hidden">
                <div class="modal-content">
                    <h3>Opções de Renderização</h3>
                    <div class="modal-body">
                        <div class="input-group">
                            <label for="render-resolution">Resolução:</label>
                            <select id="render-resolution">
                                <option value="low">480p</option>
                                <option value="medium">720p (HD)</option>
                                <option value="high">1080p (Full HD)</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="render-quality">Qualidade (Preset):</label>
                            <select id="render-quality">
                                <option value="veryfast">Baixa (Mais Rápido)</option>
                                <option value="medium" selected>Média (Equilíbrio)</option>
                                <option value="veryslow">Alta (Melhor Qualidade)</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="render-format">Formato de Saída:</label>
                            <select id="render-format">
                                <option value="webm" selected>WebM (Rápido)</option>
                                <option value="mp4">MP4 (Lento)</option>
                            </select>
                        </div>
                    </div>
                    <div class="modal-actions">
                        <button class="studio-btn" id="btn-render-cancel">Cancelar</button>
                        <button class="studio-btn primary" id="btn-render-confirm">Renderizar</button>
                    </div>
                </div>
            </div>

            <div id="render-progress-overlay" class="modal-overlay hidden" style="z-index: 2000;">
                <div class="vegas-modal">
                    <div class="vegas-header">
                        <span>Renderizando...</span>
                        <span id="render-percentage-text">0%</span>
                    </div>
                    <div class="vegas-body">
                        
                        <div class="vegas-stats-grid">
                            <div class="vegas-stat-item">
                                <span>Tempo Decorrido</span>
                                <span class="vegas-stat-value" id="render-timer-elapsed">00:00:00</span>
                            </div>
                            <div class="vegas-stat-item">
                                <span>Tempo Restante (Est.)</span>
                                <span class="vegas-stat-value" id="render-timer-left">Calculando...</span>
                            </div>
                            <div class="vegas-stat-item">
                                <span>Velocidade Render</span>
                                <span class="vegas-stat-value" id="render-speed-text">--</span>
                            </div>
                            <div class="vegas-stat-item">
                                <span>Status</span>
                                <span class="vegas-stat-value" style="font-size:12px; color:#00b7eb;">Processando</span>
                            </div>
                        </div>

                        <div class="vegas-progress-track">
                            <div class="vegas-progress-fill" style="width: 0%"></div>
                        </div>
                        
                        <div class="vegas-log-box" id="render-log-text">Inicializando motor de renderização...</div>

                        <button id="btn-render-abort" class="vegas-btn-abort">
                            Cancelar
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(div);
        this._bindEvents();
        this._bindTabEvents();
    }

    _bindEvents() {
        const fileInput = document.getElementById("studio-upload");

        // Formatos que o FFmpeg WASM suporta de forma estável
        const ALLOWED_EXTENSIONS = [
            'mp4', 'webm', 'mov', 'mkv', 'ogg', 'avi', // Vídeo
            'mp3', 'wav', 'ogg', 'aac', 'm4a', // Áudio
            'png', 'jpg', 'jpeg', 'gif' // Imagem
        ];

        document.getElementById("btn-studio-add").onclick = () => fileInput.click();

        document.getElementById("studio-upload").onchange = async (e) => {
            const files = Array.from(e.target.files);
            const validFiles = [];

            for (const file of files) {
                const parts = file.name.split('.');
                const ext = parts.length > 1 ? parts.pop().toLowerCase() : '';

                if (ALLOWED_EXTENSIONS.includes(ext)) {
                    validFiles.push(file);
                } else {
                    alert(`O formato de arquivo *.${ext} não é suportado pelo Studio. Formatos aceitos incluem: ${ALLOWED_EXTENSIONS.slice(0, 8).join(', ')}...`);
                }
            }

            for (const f of validFiles) {
                await this.studio.assetManager.importAsset(f, f.name);
            }
            // Limpa o input para permitir o upload do mesmo arquivo novamente
            e.target.value = '';
        };

        document.getElementById("btn-studio-close").onclick = () => this.studio.toggleMode();
        document.getElementById('studio-zoom-slider').oninput = (e) => {
            this.studio.timelineManager.setZoom(parseInt(e.target.value));
        };
        document.getElementById("btn-studio-save").onclick = () => this.studio.saveCurrentProject();
    }

    _bindTabEvents() {
        const tabs = document.querySelectorAll('.bin-tab');
        tabs.forEach(tab => {
            tab.onclick = () => {
                document.querySelectorAll('.bin-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.bin-content').forEach(c => c.classList.add('hidden'));

                tab.classList.add('active');
                const targetId = tab.dataset.target;

                const targetContent = document.getElementById(targetId === 'bin-media' ? 'studio-bin-list' : 'studio-projects-list');
                if (targetContent) targetContent.classList.remove('hidden');
            };
        });
    }

    updateStatusBar(tasks) {
        const bar = document.getElementById('studio-status-bar');
        const text = document.getElementById('studio-status-text');
        const btn = document.getElementById('btn-studio-render');

        if (tasks.length > 0) {
            bar.classList.remove('hidden');
            const current = tasks[tasks.length - 1];
            text.innerText = `${current.label} (${tasks.length}...)`;
            if (btn) btn.disabled = true;
        } else {
            bar.classList.add('hidden');
            if (btn) btn.disabled = false;
        }
    }

    async updateRecentProjectsList() {
        const container = document.getElementById('studio-projects-list');
        if (!container) return;

        try {
            const projects = await this.studio.projectStorage.getAllProjects();

            if (projects.length === 0) {
                container.innerHTML = `<div style="padding:10px; color:#888; font-size:11px; text-align:center">Nenhum projeto salvo.</div>`;
                return;
            }

            projects.sort((a, b) => b.lastSaved - a.lastSaved);
            container.innerHTML = "";

            projects.forEach(p => {
                const item = document.createElement('div');
                item.className = "project-item";
                item.innerHTML = `
                    <div class="project-info">
                        <div class="project-name">${p.name}</div>
                        <div class="project-date">${new Date(p.lastSaved).toLocaleString()}</div>
                    </div>
                    <div class="project-actions">
                        <button class="btn-load" title="Carregar"><i class="fa-solid fa-folder-open"></i></button>
                        <button class="btn-delete" title="Excluir"><i class="fa-solid fa-trash"></i></button>
                    </div>
                `;

                item.querySelector('.btn-load').onclick = () => this.studio.loadProject(p.id);
                item.querySelector('.btn-delete').onclick = () => this.studio.deleteSavedProject(p.id);

                container.appendChild(item);
            });

        } catch (e) {
            console.error("Erro ao listar projetos:", e);
        }
    }
}
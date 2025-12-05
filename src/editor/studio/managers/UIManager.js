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

                .ps-orientation-selector {
                    display: flex;
                    gap: 15px;
                    margin-bottom: 20px;
                }
                .ps-orientation-btn {
                    flex: 1;
                    background: #333;
                    border: 2px solid transparent;
                    padding: 20px;
                    border-radius: 8px;
                    cursor: pointer;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 10px;
                    color: #aaa;
                    transition: all 0.2s;
                    text-align: center;
                }
                .ps-orientation-btn:hover { background: #3e3e3e; }
                .ps-orientation-btn.selected {
                    border-color: #0078d7; /* Azul Sony Vegas */
                    background: #252526;
                    color: white;
                    box-shadow: 0 0 10px rgba(0, 120, 215, 0.2);
                }
                .ps-orientation-btn i { font-size: 28px; margin-bottom: 5px; }
                .ps-orientation-btn span { font-size: 13px; font-weight: 600; }
                .ps-orientation-btn small { font-size: 10px; color: #777; font-weight: normal; }

                /* Toggle Avançado */
                .ps-advanced-toggle {
                    color: #00b7eb;
                    cursor: pointer;
                    font-size: 12px;
                    margin-bottom: 10px;
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    user-select: none;
                }
                .ps-advanced-toggle:hover { text-decoration: underline; }
                .ps-advanced-toggle i { transition: transform 0.2s; }
                .ps-advanced-toggle.open i { transform: rotate(90deg); }

                /* Container Avançado (Inputs) */
                .ps-advanced-options {
                    display: none;
                    background: #1e1e1e;
                    padding: 15px;
                    border: 1px solid #3e3e3e;
                    border-radius: 4px;
                    margin-bottom: 5px;
                }
                .ps-advanced-options.show { display: block; animation: fadeIn 0.3s; }

                /* Correção do Rodapé (Botão grudado) */
                .ps-footer {
                    padding: 15px 20px;
                    background: #252526;
                    border-top: 1px solid #3e3e3e;
                    display: flex;
                    justify-content: flex-end; /* Alinha à direita */
                    gap: 10px;
                }

                @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
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
                        <video id="studio-preview-video" style="position: relative; width: 100%; height: 100%; overflow: hidden; background: #000;"></video>
                        <audio id="studio-audio-preview"></audio>
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
                                <option value="medium" selected>720p (HD)</option>
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
                                <option value="webm" selected>WebM</option>
                                <option value="mp4">MP4</option>
                            </select>
                        </div>
                        <div class="input-group"><small>Em caso de composições que incluem imagens com transparência, o formato recomendado é MP4 pela qualidade e rapidez de renderização.</small></div>
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

            <div id="project-settings-modal" class="modal-overlay hidden">
                <div class="vegas-modal project-settings-modal">
                    <div class="vegas-header">
                        <span><i class="fa-solid fa-clapperboard"></i> &nbsp; Novo Projeto</span>
                    </div>
                    
                    <div class="vegas-body">
                        <div style="margin-bottom:15px; font-size:13px; color:#ddd">Selecione o formato do vídeo:</div>
                        
                        <div class="ps-orientation-selector">
                            <div class="ps-orientation-btn selected" data-mode="landscape">
                                <i class="fa-solid fa-tv"></i>
                                <span>Paisagem</span>
                                <small>16:9 (Youtube, Monitor)</small>
                            </div>
                            <div class="ps-orientation-btn" data-mode="portrait">
                                <i class="fa-solid fa-mobile-screen"></i>
                                <span>Retrato</span>
                                <small>9:16 (Shorts, TikTok)</small>
                            </div>
                        </div>

                        <div class="ps-advanced-toggle" id="btn-toggle-advanced">
                            <i class="fa-solid fa-chevron-right" id="icon-advanced-toggle"></i> 
                            Personalizar Resolução (Avançado)
                        </div>

                        <div class="ps-advanced-options" id="ps-advanced-container">
                            <div class="vegas-stats-grid" style="margin-bottom:0; grid-template-columns: 1fr 1fr;">
                                <div class="input-group" style="margin-bottom:0; display:block;">
                                    <label style="display:block; margin-bottom:5px; color:#aaa;">Largura (px)</label>
                                    <input type="number" id="ps-width" value="1920" max="2560" style="width:100%; background:#252525; color:white; border:1px solid #444; padding:5px;">
                                </div>
                                <div class="input-group" style="margin-bottom:0; display:block;">
                                    <label style="display:block; margin-bottom:5px; color:#aaa;">Altura (px)</label>
                                    <input type="number" id="ps-height" value="1080" max="2560" style="width:100%; background:#252525; color:white; border:1px solid #444; padding:5px;">
                                </div>
                            </div>
                            <div style="font-size: 10px; color: #666; margin-top: 8px; text-align: right;">
                                Máximo suportado: 2560px (2K)
                            </div>
                        </div>
                    </div>

                    <div class="ps-footer">
                        <button class="studio-btn primary" id="btn-ps-confirm" style="padding: 6px 20px; height: 32px;">
                            Criar Projeto <i class="fa-solid fa-arrow-right" style="margin-left:5px"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(div);
        this._bindEvents();
        this._bindTabEvents();

        this._bindProjectSettingsEvents();
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

    _bindProjectSettingsEvents() {
        const modal = document.getElementById('project-settings-modal');
        const btnConfirm = document.getElementById('btn-ps-confirm');
        const inpW = document.getElementById('ps-width');
        const inpH = document.getElementById('ps-height');
        
        // 1. Lógica dos Botões Seletores (Cards)
        const buttons = document.querySelectorAll('.ps-orientation-btn');
        buttons.forEach(btn => {
            btn.onclick = () => {
                // Remove seleção anterior
                buttons.forEach(b => b.classList.remove('selected'));
                // Adiciona na atual
                btn.classList.add('selected');

                // Define valores baseados no modo
                const mode = btn.dataset.mode;
                if (mode === 'landscape') {
                    inpW.value = 1920;
                    inpH.value = 1080;
                } else if (mode === 'portrait') {
                    inpW.value = 1080;
                    inpH.value = 1920;
                }
            };
        });

        // 2. Lógica do Toggle Avançado
        const toggleBtn = document.getElementById('btn-toggle-advanced');
        const advContainer = document.getElementById('ps-advanced-container');
        
        toggleBtn.onclick = () => {
            const isHidden = !advContainer.classList.contains('show');
            if (isHidden) {
                advContainer.classList.add('show');
                toggleBtn.classList.add('open');
            } else {
                advContainer.classList.remove('show');
                toggleBtn.classList.remove('open');
            }
        };

        // 3. Botão Confirmar
        btnConfirm.onclick = async () => {
            const w = parseInt(inpW.value);
            const h = parseInt(inpH.value);

            if (w > 2560 || h > 2560) return alert("A resolução máxima é 2K (2560px) para garantir performance.");

            // Salva no Projeto
            this.studio.project.settings = { width: w, height: h };
            
            // Atualiza o Preview e Fecha
            this.updatePreviewViewport();
            modal.classList.add('hidden');

            // Carrega gravação pendente se for inicialização
            if (this.studio.isFreshInit) {
                this.studio.isFreshInit = false;
                await this.studio.checkForPendingRecording();
            }
        };
    }

    promptProjectSettings() {
        const modal = document.getElementById('project-settings-modal');
        
        // Recupera valores atuais do projeto se existirem
        if (this.studio.project.settings) {
            document.getElementById('ps-width').value = this.studio.project.settings.width;
            document.getElementById('ps-height').value = this.studio.project.settings.height;
        }
        
        modal.classList.remove('hidden');
    }

    // Atualiza o CSS do preview para refletir a proporção (Letterboxing)
    updatePreviewViewport() {
        const vid = document.getElementById('studio-preview-video');
        const settings = this.studio.project.settings || { width: 1920, height: 1080 };
        
        // Aplica aspect-ratio via CSS
        vid.style.aspectRatio = `${settings.width} / ${settings.height}`;
        
        // Garante que o vídeo se comporte como "contain" dentro dessa caixa
        vid.style.width = 'auto';
        vid.style.height = 'auto';
        vid.style.maxWidth = '100%';
        vid.style.maxHeight = '100%';
        
        // Fundo preto para letterboxing (já está no CSS, mas reforçando)
        vid.parentElement.style.background = '#000';
    }
}
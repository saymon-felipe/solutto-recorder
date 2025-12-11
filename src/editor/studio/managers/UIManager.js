import { HistoryManager } from './HistoryManager.js';

/**
 * UIManager
 * Responsável por construir a interface DOM, gerenciar modais (Settings, Pan/Crop),
 * atualizar feedbacks visuais (Status Bar, Header) e manipular eventos de upload.
 */
export class UIManager {
    
    constructor(studio) {
        this.studio = studio;
        this.studio.historyManager = new HistoryManager(studio);

        // Estado do editor Pan/Crop
        this.activeClip = null;
        this.pancropZoom = 1;
    }

    // =========================================================================
    // CONSTRUÇÃO DA INTERFACE (DOM & CSS)
    // =========================================================================

    buildUI() {
        const div = document.createElement("div");
        div.id = "studio-app";

        // CSS Injetado diretamente para garantir encapsulamento
        const styles = `
            <style>
                /* --- MODAIS E PAINEIS --- */
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
                    user-select: none;
                }
                .vegas-body { padding: 20px; overflow-y: auto; flex: 1; }
                
                /* --- ESTILOS COMPARTILHADOS DE JANELAS FLUTUANTES --- */
                .studio-floating-window {
                    position: fixed;
                    background-color: #1e1e1e;
                    border: 1px solid #333;
                    box-shadow: 0 20px 50px rgba(0,0,0,0.8);
                    display: flex;
                    flex-direction: column;
                    resize: both;
                    overflow: hidden;
                    z-index: 2000;
                }

                /* PAN/CROP MODAL ESPECÍFICO */
                #modal-pan-crop {
                    min-width: 600px;
                    min-height: 400px;
                }

                /* SUBTITLE MODAL ESPECÍFICO */
                #modal-subtitle-settings {
                    min-width: 400px;
                    min-height: 500px;
                    width: 450px;
                    height: 600px;
                }
                
                /* --- STATS GRID (RENDER) --- */
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
                
                /* --- PROGRESS BAR --- */
                .vegas-progress-track {
                    height: 18px;
                    background-color: #1e1e1e;
                    border: 1px solid #3f3f46;
                    position: relative;
                    margin-bottom: 8px;
                }
                .vegas-progress-fill {
                    height: 100%;
                    background: linear-gradient(to bottom, #00b7eb, #007acc);
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

                /* --- PROJECT SETTINGS SELECTOR --- */
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
                    border-color: #0078d7;
                    background: #252526;
                    color: white;
                    box-shadow: 0 0 10px rgba(0, 120, 215, 0.2);
                }
                .ps-orientation-btn i { font-size: 28px; margin-bottom: 5px; }
                .ps-orientation-btn span { font-size: 13px; font-weight: 600; }
                .ps-orientation-btn small { font-size: 10px; color: #777; font-weight: normal; }

                /* --- ADVANCED OPTIONS TOGGLE --- */
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

                .ps-advanced-options {
                    display: none;
                    background: #1e1e1e;
                    padding: 15px;
                    border: 1px solid #3e3e3e;
                    border-radius: 4px;
                    margin-bottom: 5px;
                }
                .ps-advanced-options.show { display: block; animation: fadeIn 0.3s; }

                .ps-footer {
                    padding: 15px 20px;
                    background: #252526;
                    border-top: 1px solid #3e3e3e;
                    display: flex;
                    justify-content: flex-end;
                    gap: 10px;
                }

                @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }

                /* --- PAN/CROP MODAL --- */
                #modal-pan-crop {
                    min-width: 600px;
                    min-height: 400px;
                    resize: both;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    background-color: #1e1e1e;
                    border: 1px solid #333;
                    box-shadow: 0 20px 50px rgba(0,0,0,0.8);
                }

                .pc-layout {
                    display: flex;
                    flex: 1;
                    overflow: hidden;
                    height: 100%;
                }

                .pc-workspace {
                    flex: 1;
                    background: #111;
                    position: relative;
                    overflow: hidden;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background-image: radial-gradient(#333 1px, transparent 1px);
                    background-size: 20px 20px;
                }

                .pc-sidebar {
                    width: 280px;
                    min-width: 250px;
                    background: #252526;
                    border-left: 1px solid #333;
                    padding: 15px;
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                    overflow-y: auto;
                    z-index: 10;
                }

                /* --- INPUTS MODERNOS --- */
                .pc-input-group {
                    background: #2d2d30;
                    padding: 10px;
                    border-radius: 6px;
                    border: 1px solid #3e3e42;
                }
                .pc-label {
                    display: block;
                    font-size: 11px;
                    color: #aaa;
                    margin-bottom: 8px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    font-weight: 600;
                }
                .pc-row { display: flex; gap: 8px; align-items: center; }
                
                .pc-input {
                    background: #181818;
                    border: 1px solid #444;
                    color: #fff;
                    padding: 6px 8px;
                    border-radius: 4px;
                    font-family: 'Consolas', monospace;
                    font-size: 12px;
                    width: 100%;
                    transition: border-color 0.2s;
                }
                .pc-input:focus { border-color: #0078d7; outline: none; }
                
                .pc-checkbox-label {
                    font-size: 12px;
                    color: #ddd;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    user-select: none;
                }

                .vegas-btn {
                    background: #3a3a3d;
                    border: 1px solid #555;
                    color: white;
                    padding: 8px 15px;
                    cursor: pointer;
                    border-radius: 4px;
                    font-size: 12px;
                    transition: background 0.2s;
                }
                .vegas-btn:hover { background: #505055; }
                
                ::-webkit-resizer { background-color: transparent; }
            </style>
        `;
        
        // Estrutura HTML Principal
        div.innerHTML = styles + `
            <div class="studio-toolbar">
                <div class="header-group">
                    <span class="studio-app-logo">
                        <i class="fa-solid fa-video"></i> Solutto Studio
                    </span>
                    
                    <div class="project-toolbox">
                        <button id="btn-toolbox-save" class="toolbox-btn" title="Salvar (Ctrl+S)">
                            <i class="fa-solid fa-floppy-disk"></i>
                        </button>
                        <button id="btn-toolbox-save-as" class="toolbox-btn" title="Salvar Como...">
                            <i class="fa-solid fa-file-export"></i>
                        </button>
                        <button id="btn-toolbox-settings" class="toolbox-btn" title="Configurações do Projeto">
                            <i class="fa-solid fa-gear"></i>
                        </button>
                    </div>

                    <div class="project-info-container">
                        <span id="header-project-name" class="header-p-name">Carregando...</span>
                        <span id="header-project-status" class="header-p-status"></span>
                    </div>
                </div>

                <div class="studio-controls">
                    <button id="btn-studio-render" class="studio-btn primary">
                        <i class="fa-solid fa-file-video"></i> Renderizar
                    </button>
                    <button id="btn-studio-close" class="studio-btn danger">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
            </div>
            
            <div class="studio-workspace" id="studio-workspace-el">
                <div class="studio-bin" id="studio-bin-el">
                    <div class="bin-tabs">
                        <button class="bin-tab active" data-target="bin-media">Mídia</button>
                        <button class="bin-tab" data-target="bin-projects">Projetos</button>
                        <button class="bin-tab" data-target="bin-generator">Gerador</button>
                    </div>
                    
                    <div class="bin-content" id="studio-bin-list"></div>
                    
                    <div class="bin-content hidden" id="studio-projects-list">
                        <div style="padding:10px; color:#888; font-size:11px; text-align:center">Nenhum projeto recente</div>
                    </div>
                    <div class="bin-content hidden" id="studio-generator-list"> <div class="generator-item" id="btn-gen-subtitles">
                            <i class="fa-solid fa-closed-captioning"></i>
                            <span>Legendas Automáticas</span>
                        </div>
                    </div>
                </div>
                
                <div id="resizer-v" class="layout-resizer-v"></div>
                
                <div class="preview-container" id="preview-container-el">
                    <div class="studio-preview">
                        <div id="studio-preview-canvas" class="preview-canvas" style="position: relative; overflow: hidden;"></div>
                    </div>
                    <div class="preview-controls">
                        <button class="control-btn" id="btn-stop"><i class="fa-solid fa-stop"></i></button>
                        <button class="control-btn" id="btn-play-pause"><i class="fa-solid fa-play"></i></button>
                        <span id="studio-time-display" class="time-display">00:00:00;00</span>
                    </div>
                </div>
            </div>

            <div id="resizer-h" class="layout-resizer-h"></div>

            <div class="studio-timeline" id="studio-timeline-el">
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
                        <div class="input-group" style="opacity: 0; position: absolute; left: -99999px; top: -99999px;">
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
                                <option value="webm" selected>WebM (Original)</option>
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

                        <button id="btn-render-abort" class="vegas-btn-abort">Cancelar</button>
                    </div>
                </div>
            </div>

            <div id="project-settings-modal" class="modal-overlay hidden">
                <div class="vegas-modal project-settings-modal">
                    <div class="vegas-header">
                        <span><i class="fa-solid fa-clapperboard"></i> &nbsp; Novo Projeto</span>
                        <button id="btn-ps-close" style="background: transparent; border: none; color: #aaa; cursor: pointer; padding: 0 5px;">
                            <i class="fa-solid fa-times"></i>
                        </button>
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

            <div id="modal-pan-crop" class="hidden" style="position: fixed; top: 50%; left: 50%; width: 900px; height: 600px; z-index: 2000;">
                <div class="vegas-header" id="pc-header" style="cursor: move; padding: 10px 15px; background: #333; border-bottom: 1px solid #111; flex-shrink: 0;">
                    <span style="font-weight:600; color:#eee;"><i class="fa-solid fa-crop-simple"></i> &nbsp;Pan/Crop Event FX</span>
                    <button id="btn-pc-close" style="background:transparent; border:none; color:#aaa; cursor:pointer; font-size:14px;"><i class="fa-solid fa-times"></i></button>
                </div>
                
                <div class="pc-layout">
                    <div class="pc-workspace" id="pancrop-workspace">
                        <canvas id="pancrop-canvas"></canvas>
                        <div style="position: absolute; bottom: 10px; left: 10px; color: #555; font-size: 10px; pointer-events: none;">
                            Mouse Wheel: Zoom Workspace | Drag: Move/Resize
                        </div>
                    </div>

                    <div class="pc-sidebar">
                        
                        <div class="pc-input-group">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                <label class="pc-label" style="margin:0;"><i class="fa-solid fa-arrows-up-down-left-right"></i> Posição</label>
                                <button id="pc-btn-axis-lock" class="vegas-btn" style="padding: 2px 8px; font-size: 10px; width: auto; background: #444;" title="Travar Eixo de Movimento">
                                    <i class="fa-solid fa-lock-open"></i> Livre
                                </button>
                            </div>
                            <div class="pc-row">
                                <input type="number" id="pc-pos-x" class="pc-input" placeholder="X">
                                <input type="number" id="pc-pos-y" class="pc-input" placeholder="Y">
                            </div>
                        </div>

                        <div class="pc-input-group">
                            <label class="pc-label"><i class="fa-solid fa-expand"></i> Dimensão (Zoom %)</label>
                            <div class="pc-row">
                                <input type="number" id="pc-width" class="pc-input" step="1" placeholder="W">
                                <input type="number" id="pc-height" class="pc-input" step="1" placeholder="H">
                            </div>
                            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #3e3e42;">
                                <label class="pc-checkbox-label">
                                    <input type="checkbox" id="pc-lock-aspect"> 
                                    <i class="fa-solid fa-link"></i> Bloquear Proporção
                                </label>
                            </div>
                        </div>

                        <div class="pc-input-group">
                            <label class="pc-label"><i class="fa-solid fa-rotate"></i> Rotação (Graus)</label>
                            <div class="pc-row">
                                <input type="range" id="pc-rot-slider" min="-180" max="180" step="1" style="flex:1; cursor:pointer;">
                                <input type="number" id="pc-rotation" class="pc-input" style="width: 60px; text-align:center;">
                            </div>
                        </div>

                        <div style="margin-top: auto;">
                            <button id="pc-btn-reset" class="vegas-btn" style="width: 100%;">
                                <i class="fa-solid fa-rotate-left"></i> Resetar Transformação
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div id="modal-subtitle-settings" class="studio-floating-window hidden" style="top: 50%; left: 50%;">
                <div class="vegas-header" id="sub-header" style="cursor: move; padding: 10px 15px; background: #333; border-bottom: 1px solid #111; flex-shrink: 0;">
                    <span style="font-weight:600; color:#eee;"><i class="fa-solid fa-closed-captioning"></i> &nbsp;Configurar Legendas</span>
                    <button id="btn-sub-close" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:14px;"><i class="fa-solid fa-times"></i></button>
                </div>
                <div class="vegas-body">
                    <div class="subtitle-preview-box">
                        <span id="sub-preview-target" class="subtitle-preview-text">Exemplo de Texto</span>
                    </div>
                    
                    <div class="vegas-stats-grid" style="grid-template-columns: 1fr 1fr;">
                        <div class="input-group" style="display:block; margin-bottom:0;">
                            <label style="display:block;margin-bottom:5px;">Fonte</label>
                            <select id="sub-font-family" style="width:100%; padding:5px; background:#222; border:1px solid #444; color:white;">
                                <option value="Arial">Arial</option>
                                <option value="'Segoe UI'">Segoe UI</option>
                                <option value="'Courier New'">Courier New</option>
                                <option value="Impact">Impact</option>
                            </select>
                        </div>
                        <div class="input-group" style="display:block; margin-bottom:0;">
                            <label style="display:block;margin-bottom:5px;">Tamanho (px)</label>
                            <input type="number" id="sub-font-size" value="30" style="width:100%; padding:5px; background:#222; border:1px solid #444; color:white;">
                        </div>
                    </div>

                    <div class="vegas-stats-grid" style="grid-template-columns: 1fr 1fr; margin-top:10px;">
                        <div class="input-group" style="display:block; margin-bottom:0;">
                            <label style="display:block;margin-bottom:5px;">Cor do Texto</label>
                            <input type="color" id="sub-color" value="#ffffff" style="width:100%; height:30px; border:none;">
                        </div>
                        <div class="input-group" style="display:block; margin-bottom:0;">
                            <label style="display:block;margin-bottom:5px;">Cor do Fundo</label>
                            <input type="color" id="sub-bg-color" value="#000000" style="width:100%; height:30px; border:none;">
                        </div>
                    </div>

                    <div style="margin-top:10px; display:flex; gap:10px;">
                        <label style="display:flex; align-items:center; gap:5px; font-size:12px; cursor:pointer;">
                            <input type="checkbox" id="sub-bold"> Negrito
                        </label>
                        <label style="display:flex; align-items:center; gap:5px; font-size:12px; cursor:pointer;">
                            <input type="checkbox" id="sub-italic"> Itálico
                        </label>
                    </div>

                    <div style="background: #252526; padding: 10px; border-radius: 4px; margin-top: 15px; border: 1px solid #3e3e42;">
                        <div style="font-size: 11px; color: #aaa; margin-bottom: 10px;">
                            <i class="fa-solid fa-microphone-lines"></i>&nbsp; A transcrição utiliza a reprodução do vídeo.
                        </div>
                        <button id="btn-sub-transcribe" class="studio-btn" style="width: 100%; justify-content: center; background: #2e7d32; border-color: #1b5e20;">
                            <i class="fa-solid fa-play"></i>&nbsp; Iniciar Transcrição Automática
                        </button>
                        <div id="sub-transcribe-progress" style="display:none; margin-top:5px;">
                            <div style="height:4px; background:#333; border-radius:2px; overflow:hidden;">
                                <div id="sub-transcribe-bar" style="width:0%; height:100%; background:#4caf50; transition: width 0.2s;"></div>
                            </div>
                            <div style="text-align:center; font-size:10px; color:#888; margin-top:3px;">Processando áudio...</div>
                        </div>
                    </div>

                    <div class="modal-actions" style="margin-top:15px; padding-top:10px; border-top:1px solid #333;">
                        <button class="studio-btn" id="btn-sub-cancel">Fechar</button>
                        <button class="studio-btn primary" id="btn-sub-confirm">Salvar Estilo</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(div);

        // Binding inicial assíncrono para garantir que elementos existam
        setTimeout(() => {
            // Botões Header
            document.getElementById('btn-toolbox-save').onclick = () => this.studio.saveProject();
            document.getElementById('btn-toolbox-save-as').onclick = () => this.studio.saveProjectAs();
            document.getElementById('btn-toolbox-settings').onclick = () => this.studio.openProjectSettings();
            
            // Botões Originais
            document.getElementById('btn-studio-close').onclick = () => this.studio.toggleMode();
            
            // Atalho de Teclado (Ctrl+S)
            document.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    if (this.studio.isActive) {
                        e.preventDefault();
                        this.studio.saveProject();
                    }
                }
            });
        }, 0);

        this._bindEvents();
        this._bindTabEvents();
        this._bindProjectSettingsEvents();
        this._bindLayoutResizers();
    }

    // =========================================================================
    // GERENCIAMENTO DO HEADER E STATUS DO PROJETO
    // =========================================================================

    updateProjectHeader(project, hasUnsavedChanges) {
        const nameEl = document.getElementById('header-project-name');
        const statusEl = document.getElementById('header-project-status');
        if (!nameEl || !statusEl) return;

        const isNewProject = !project.id; 
        
        if (isNewProject) {
            const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            nameEl.innerText = "Não Salvo";
            statusEl.innerHTML = `&mdash; Iniciado às ${timeStr}`;
            statusEl.style.color = "#aaa";
        } else {
            nameEl.innerText = project.name;
            
            if (hasUnsavedChanges) {
                statusEl.innerHTML = `&bull; <span style="color: #ffb74d;">Alterações não salvas</span>`;
            } else {
                const lastSaved = project.lastSaved ? new Date(project.lastSaved) : new Date();
                const dateStr = lastSaved.toLocaleString('pt-BR', { 
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute:'2-digit' 
                });
                statusEl.innerHTML = `&bull; Salvo em ${dateStr}`;
                statusEl.style.color = "#4caf50"; 
            }
        }
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

    showToast(message) {
        const container = document.getElementById('studio-toast-container') || document.getElementById('studio-app');
        const toast = document.createElement('div');
        toast.className = 'studio-toast';
        toast.innerText = message;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    _bindLayoutResizers() {
        const workspace = document.getElementById('studio-workspace-el');
        const bin = document.getElementById('studio-bin-el');
        const resizerH = document.getElementById('resizer-h');
        const resizerV = document.getElementById('resizer-v');
        const app = document.getElementById('studio-app');

        let startY, startHeight;

        const onMouseMoveH = (e) => {
            const newHeight = startHeight + (e.clientY - startY);
            
            if (newHeight > 150 && newHeight < window.innerHeight - 150) {
                workspace.style.height = `${newHeight}px`;
                workspace.style.flex = "none"; 
                
                if(this.studio.playbackManager) this.studio.playbackManager.syncPreview();
            }
        };

        const onMouseUpH = () => {
            document.removeEventListener('mousemove', onMouseMoveH);
            document.removeEventListener('mouseup', onMouseUpH);
            document.body.classList.remove('resizing');
            resizerH.classList.remove('active');
            
            window.dispatchEvent(new Event('resize'));
        };

        if (resizerH) {
            resizerH.onmousedown = (e) => {
                e.preventDefault();
                startY = e.clientY;
                startHeight = workspace.getBoundingClientRect().height;
                
                document.body.classList.add('resizing');
                resizerH.classList.add('active');
                
                document.addEventListener('mousemove', onMouseMoveH);
                document.addEventListener('mouseup', onMouseUpH);
            };
        }

        let startX, startWidth;

        const onMouseMoveV = (e) => {
            const newWidth = startWidth + (e.clientX - startX);
            
            if (newWidth > 150 && newWidth < 600) {
                bin.style.width = `${newWidth}px`;
            }
        };

        const onMouseUpV = () => {
            document.removeEventListener('mousemove', onMouseMoveV);
            document.removeEventListener('mouseup', onMouseUpV);
            document.body.classList.remove('resizing');
            resizerV.classList.remove('active');
            
            if(this.studio.playbackManager) this.studio.playbackManager.syncPreview();
        };

        if (resizerV) {
            resizerV.onmousedown = (e) => {
                e.preventDefault();
                startX = e.clientX;
                startWidth = bin.getBoundingClientRect().width;
                
                document.body.classList.add('resizing');
                resizerV.classList.add('active');
                
                document.addEventListener('mousemove', onMouseMoveV);
                document.addEventListener('mouseup', onMouseUpV);
            };
        }
    }

    // =========================================================================
    // MODAL: CONFIGURAÇÕES DO PROJETO
    // =========================================================================

    promptProjectSettings() {
        const modal = document.getElementById('project-settings-modal');
        const inpW = document.getElementById('ps-width');
        const inpH = document.getElementById('ps-height');
        const btnConfirm = document.getElementById('btn-ps-confirm'); 
        const buttons = document.querySelectorAll('.ps-orientation-btn');
        
        // Popula valores atuais
        if (this.studio.project.settings) {
            const { width, height } = this.studio.project.settings;
            inpW.value = width;
            inpH.value = height;

            buttons.forEach(btn => btn.classList.remove('selected'));
            const mode = width >= height ? 'landscape' : 'portrait';
            const targetBtn = document.querySelector(`.ps-orientation-btn[data-mode="${mode}"]`);
            if (targetBtn) targetBtn.classList.add('selected');
        } else {
             document.querySelector('.ps-orientation-btn[data-mode="landscape"]')?.classList.add('selected');
        }

        // Texto do Botão (Criar vs Salvar)
        if (this.studio.project.id) {
            btnConfirm.innerHTML = `Salvar Alterações <i class="fa-solid fa-check" style="margin-left:5px"></i>`;
        } else {
            btnConfirm.innerHTML = `Criar Projeto <i class="fa-solid fa-arrow-right" style="margin-left:5px"></i>`;
        }
        
        modal.classList.remove('hidden');
    }

    _bindProjectSettingsEvents() {
        const modal = document.getElementById('project-settings-modal');
        const btnConfirm = document.getElementById('btn-ps-confirm');
        const btnClose = document.getElementById('btn-ps-close');
        const inpW = document.getElementById('ps-width');
        const inpH = document.getElementById('ps-height');
        
        if (btnClose) {
            btnClose.onclick = () => modal.classList.add('hidden');
        }
        
        // Lógica dos Botões Seletores (Cards)
        const buttons = document.querySelectorAll('.ps-orientation-btn');
        buttons.forEach(btn => {
            btn.onclick = () => {
                buttons.forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');

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

        // Toggle Avançado
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

        // Confirmação
        btnConfirm.onclick = async () => {
            const w = parseInt(inpW.value);
            const h = parseInt(inpH.value);

            if (w > 2560 || h > 2560) return alert("A resolução máxima é 2K (2560px) para garantir performance.");

            const oldSettings = this.studio.project.settings || {};
            const hasChanged = oldSettings.width !== w || oldSettings.height !== h;

            this.studio.project.settings = { width: w, height: h };
            
            if (!this.studio.isFreshInit && hasChanged) {
                this.studio.markUnsavedChanges();
            }

            this.updatePreviewViewport();
            modal.classList.add('hidden');

            if (this.studio.isFreshInit) {
                this.studio.isFreshInit = false;
                await this.studio.checkForPendingRecording();
            }
        };
    }

    updatePreviewViewport() {
        const canvas = document.getElementById('studio-preview-canvas');
        const settings = this.studio.project.settings || { width: 1920, height: 1080 };
        
        if (!canvas) return;

        canvas.style.aspectRatio = `${settings.width} / ${settings.height}`;
        console.log(`[UIManager] Viewport atualizada para ${settings.width}x${settings.height}`);
    }

    // =========================================================================
    // SISTEMA PAN/CROP (EVENT FX)
    // =========================================================================

    openPanCropModal(clip) {
        this.activeClip = clip;
        this.pancropZoom = 1;
        const modal = document.getElementById('modal-pan-crop');
        const btnClose = document.getElementById('btn-pc-close');
        
        if (!modal) return;

        // Centraliza se for a primeira abertura
        if (!modal.style.top || modal.style.top === "50%") {
            const rect = modal.getBoundingClientRect();
            modal.style.top = `${(window.innerHeight - 600)/2}px`;
            modal.style.left = `${(window.innerWidth - 900)/2}px`;
            modal.style.transform = "none";
        }

        // Inicializa dados se não existirem
        if (!clip.transform) {
            clip.transform = {
                x: 0, y: 0,
                width: 100, // %
                height: 100, // %
                rotation: 0,
                maintainAspect: true
            };
        }

        modal.classList.remove('hidden');

        if (btnClose) btnClose.onclick = () => this.closePanCropModal();
        
        this._bindPanCropControls();     
        this._makeDraggable(modal, "pc-header"); 
        this._initCanvasInteractions();  
        this._renderPanCropCanvas();     
    }

    closePanCropModal() {
        const modal = document.getElementById('modal-pan-crop');
        if(modal) modal.classList.add('hidden');
        this.activeClip = null;
    }

    _refreshActiveModalState() {
        const modal = document.getElementById('modal-pan-crop');
        
        // Se o modal estiver aberto durante um Undo/Redo, precisamos reconectar a referência do clipe
        if (this.activeClip && modal && !modal.classList.contains('hidden')) {
            const currentId = this.activeClip.id;
            let foundClip = null;
            
            if (this.studio.project && this.studio.project.tracks) {
                for (const track of this.studio.project.tracks) {
                    const c = track.clips.find(clip => clip.id === currentId);
                    if (c) {
                        foundClip = c;
                        break;
                    }
                }
            }

            if (foundClip) {
                console.log("Recuperando referência do clip após Undo:", foundClip.name);
                this.activeClip = foundClip; 
                if (this._updatePanCropInputs) this._updatePanCropInputs(); 
                this._renderPanCropCanvas(); 
            } else {
                this.closePanCropModal();
            }
        }
    }

    _makeDraggable(elmnt, handleId) {
        const header = document.getElementById(handleId);
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        
        if (!header) return;

        header.onmousedown = (e) => {
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        };

        function elementDrag(e) {
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
            elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    _bindPanCropControls() {
        if (!this.activeClip) return;
        
        const ids = ['pc-pos-x', 'pc-pos-y', 'pc-width', 'pc-height', 'pc-rotation', 'pc-rot-slider', 'pc-lock-aspect', 'pc-btn-reset', 'pc-btn-axis-lock'];
        const els = {};
        ids.forEach(id => els[id] = document.getElementById(id));

        if (!els['pc-pos-x']) return;

        this.axisLockState = 'free';

        const updateLockBtn = () => {
            const btn = els['pc-btn-axis-lock'];
            if (!btn) return;
            
            if (this.axisLockState === 'free') {
                btn.innerHTML = '<i class="fa-solid fa-lock-open"></i> Livre';
                btn.style.color = '#fff';
            } else if (this.axisLockState === 'x') {
                btn.innerHTML = '<i class="fa-solid fa-arrows-left-right"></i> Só X';
                btn.style.color = '#4fc3f7'; 
            } else if (this.axisLockState === 'y') {
                btn.innerHTML = '<i class="fa-solid fa-arrows-up-down"></i> Só Y';
                btn.style.color = '#ffb74d'; 
            }
        };
        
        // Garante estado inicial visual
        updateLockBtn();

        // Função para atualizar UI baseada nos dados do clip
        const updateUIFromData = () => {
            els['pc-pos-x'].value = Math.round(this.activeClip.transform.x);
            els['pc-pos-y'].value = Math.round(this.activeClip.transform.y);
            els['pc-width'].value = Math.round(this.activeClip.transform.width);
            els['pc-height'].value = Math.round(this.activeClip.transform.height);
            els['pc-rotation'].value = Math.round(this.activeClip.transform.rotation);
            els['pc-rot-slider'].value = Math.round(this.activeClip.transform.rotation);
            els['pc-lock-aspect'].checked = this.activeClip.transform.maintainAspect;
        };

        updateUIFromData();

        // Função para commitar alterações
        const commitChange = (recordHistory = false) => {
            const t = this.activeClip.transform;
            const lock = els['pc-lock-aspect'].checked;
            
            let newW = parseFloat(els['pc-width'].value) || 100;
            let newH = parseFloat(els['pc-height'].value) || 100;

            // Mantém Aspect Ratio se travado
            if (lock && document.activeElement === els['pc-width']) {
                if(t.width !== 0) newH = newW * (t.height / t.width);
            } else if (lock && document.activeElement === els['pc-height']) {
                if(t.height !== 0) newW = newH * (t.width / t.height);
            }

            this.activeClip.transform = {
                x: parseFloat(els['pc-pos-x'].value) || 0,
                y: parseFloat(els['pc-pos-y'].value) || 0,
                width: newW,
                height: newH,
                rotation: parseFloat(els['pc-rotation'].value) || 0,
                maintainAspect: lock
            };

            if (lock) updateUIFromData();

            this.studio.markUnsavedChanges();
            this._renderPanCropCanvas();
            if(this.studio.playbackManager) this.studio.playbackManager.syncPreview();
            
            if (recordHistory) this.studio.historyManager.recordState();
        };

        // Binda Listeners nos inputs
        ['pc-pos-x', 'pc-pos-y', 'pc-width', 'pc-height', 'pc-rotation'].forEach(k => {
            els[k].oninput = () => commitChange(false);
            els[k].onchange = () => commitChange(true);
        });

        els['pc-rot-slider'].oninput = (e) => {
            els['pc-rotation'].value = e.target.value;
            commitChange(false);
        };
        els['pc-rot-slider'].onchange = () => commitChange(true);

        els['pc-lock-aspect'].onchange = () => commitChange(true);

        els['pc-btn-reset'].onclick = () => {
            this.activeClip.transform = { x: 0, y: 0, width: 100, height: 100, rotation: 0, maintainAspect: true };
            updateUIFromData();
            commitChange(true);
        };

        els['pc-btn-axis-lock'].onclick = () => {
            if (this.axisLockState === 'free') this.axisLockState = 'x';
            else if (this.axisLockState === 'x') this.axisLockState = 'y';
            else this.axisLockState = 'free';
            
            updateLockBtn();
        };
        
        this._updatePanCropInputs = updateUIFromData;
    }

    _initCanvasInteractions() {
        const canvas = document.getElementById('pancrop-canvas');
        if (!canvas) return;

        // Clone para remover listeners antigos
        const newCanvas = canvas.cloneNode(true);
        canvas.parentNode.replaceChild(newCanvas, canvas);
        
        let isDragging = false;
        let dragMode = null; 
        let startX = 0, startY = 0;
        let initialTransform = null;
        
        // Zoom na Workspace (Wheel)
        newCanvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = Math.sign(e.deltaY) * -1;
            const factor = 1.1;

            if (delta > 0) this.pancropZoom *= factor;
            else this.pancropZoom /= factor;

            this.pancropZoom = Math.max(0.1, Math.min(5, this.pancropZoom));
            this._renderPanCropCanvas();
        }, { passive: false });

        // Helpers Matemáticos
        const getMousePos = (evt) => {
            const rect = newCanvas.getBoundingClientRect();
            return {
                x: evt.clientX - rect.left - newCanvas.width / 2,
                y: evt.clientY - rect.top - newCanvas.height / 2
            };
        };

        const rotatePoint = (x, y, angleDeg) => {
            const rad = -angleDeg * Math.PI / 180;
            return {
                x: x * Math.cos(rad) - y * Math.sin(rad),
                y: x * Math.sin(rad) + y * Math.cos(rad)
            };
        };

        // --- Mouse Down (Hit Test & Drag Start) ---
        newCanvas.onmousedown = (e) => {
            if (!this.activeClip) return;
            // Apenas inicia se o modo foi detectado no mousemove anterior (otimização)
            if (!dragMode) return;

            const mouse = getMousePos(e);
            const t = this.activeClip.transform;
            const projectW = (this.studio.project.settings || {width:1920}).width;
            const projectH = (this.studio.project.settings || {height:1080}).height;
            const scaleFit = Math.min(newCanvas.width / projectW, newCanvas.height / projectH) * 0.7 * this.pancropZoom;

            isDragging = true;
            startX = mouse.x;
            startY = mouse.y;
            initialTransform = { ...t };
            newCanvas.dataset.scaleFit = scaleFit;
        };

        // --- Mouse Move (Cursor Update & Dragging) ---
        window.addEventListener('mousemove', (e) => {
            // Se o modal estiver fechado ou sem clip, ignora
            if (!this.activeClip || document.getElementById('modal-pan-crop').classList.contains('hidden')) return;

            // 1. Lógica de Dragging (Mover o objeto)
            if (isDragging) {
                e.preventDefault();
                const rect = newCanvas.getBoundingClientRect();
                const currentX = e.clientX - rect.left - newCanvas.width / 2;
                const currentY = e.clientY - rect.top - newCanvas.height / 2;
                
                const deltaX = currentX - startX;
                const deltaY = currentY - startY;
                const scaleFit = parseFloat(newCanvas.dataset.scaleFit || 1);
                
                const projectW = (this.studio.project.settings || {width:1920}).width;
                const projectH = (this.studio.project.settings || {height:1080}).height;

                const t = this.activeClip.transform;
                const initT = initialTransform;

                if (dragMode === 'move') {
                    // --- APLICA TRAVAMENTO DE EIXO ---
                    if (this.axisLockState === 'free' || this.axisLockState === 'x') {
                        t.x = initT.x + (deltaX / scaleFit);
                    }
                    if (this.axisLockState === 'free' || this.axisLockState === 'y') {
                        t.y = initT.y + (deltaY / scaleFit);
                    }
                } 
                else {
                    // Lógica de Redimensionamento (Handles)
                    const d = rotatePoint(deltaX, deltaY, initT.rotation);
                    const dPercentW = ((d.x / scaleFit) / projectW) * 100;
                    const dPercentH = ((d.y / scaleFit) / projectH) * 100;

                    let newW = initT.width;
                    let newH = initT.height;

                    if (dragMode === 'br') { newW += dPercentW; newH += dPercentH; }
                    else if (dragMode === 'bl') { newW -= dPercentW; newH += dPercentH; }
                    else if (dragMode === 'tr') { newW += dPercentW; newH -= dPercentH; }
                    else if (dragMode === 'tl') { newW -= dPercentW; newH -= dPercentH; }

                    if (initT.maintainAspect) {
                        const ratio = initT.width / initT.height;
                        if (Math.abs(newW - initT.width) > Math.abs(newH - initT.height)) {
                            newH = newW / ratio;
                        } else {
                            newW = newH * ratio;
                        }
                    }
                    t.width = Math.max(1, newW);
                    t.height = Math.max(1, newH);
                }

                this.studio.markUnsavedChanges();
                this._renderPanCropCanvas();
                if(this._updatePanCropInputs) this._updatePanCropInputs();
                if(this.studio.playbackManager) this.studio.playbackManager.syncPreview();
                return; // Se está arrastando, não precisa recalcular hit test nem cursor
            }

            // 2. Lógica de Hover (Hit Test & Cursor) - Quando NÃO está arrastando
            const mouse = getMousePos(e);
            const t = this.activeClip.transform;
            const projectW = (this.studio.project.settings || {width:1920}).width;
            const projectH = (this.studio.project.settings || {height:1080}).height;
            const scaleFit = Math.min(newCanvas.width / projectW, newCanvas.height / projectH) * 0.7 * this.pancropZoom;

            // Transforma coordenadas para espaço local
            const visualOffsetX = t.x * scaleFit; 
            const visualOffsetY = t.y * scaleFit;
            const relX = mouse.x - visualOffsetX;
            const relY = mouse.y - visualOffsetY;
            const unrotated = rotatePoint(relX, relY, t.rotation);
            
            const objW = (projectW * (t.width / 100)) * scaleFit;
            const objH = (projectH * (t.height / 100)) * scaleFit;
            const halfW = objW / 2;
            const halfH = objH / 2;
            const handleSize = 8; 

            // Detecta modo
            let newCursor = 'default';
            dragMode = null;

            if (Math.abs(unrotated.x - (-halfW)) < handleSize && Math.abs(unrotated.y - (-halfH)) < handleSize) {
                dragMode = 'tl'; newCursor = 'nwse-resize';
            }
            else if (Math.abs(unrotated.x - (halfW)) < handleSize && Math.abs(unrotated.y - (-halfH)) < handleSize) {
                dragMode = 'tr'; newCursor = 'nesw-resize';
            }
            else if (Math.abs(unrotated.x - (-halfW)) < handleSize && Math.abs(unrotated.y - (halfH)) < handleSize) {
                dragMode = 'bl'; newCursor = 'nesw-resize';
            }
            else if (Math.abs(unrotated.x - (halfW)) < handleSize && Math.abs(unrotated.y - (halfH)) < handleSize) {
                dragMode = 'br'; newCursor = 'nwse-resize';
            }
            else if (unrotated.x >= -halfW && unrotated.x <= halfW && unrotated.y >= -halfH && unrotated.y <= halfH) {
                dragMode = 'move';
                
                // --- ATUALIZAÇÃO DO CURSOR BASEADO NO LOCK ---
                if (this.axisLockState === 'x') newCursor = 'ew-resize';      // Seta horizontal
                else if (this.axisLockState === 'y') newCursor = 'ns-resize'; // Seta vertical
                else newCursor = 'move';                                      // Cruz de movimento
            }

            // Aplica cursor
            newCanvas.style.cursor = newCursor;
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                // dragMode não é zerado aqui para permitir clicks rápidos sem mover o mouse
                this.studio.historyManager.recordState();
            }
        });
    }

    _renderPanCropCanvas() {
        const canvas = document.getElementById('pancrop-canvas');
        if (!canvas || !this.activeClip) return;
        
        const parent = canvas.parentElement;
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
        
        const ctx = canvas.getContext('2d');
        const { width: projectW, height: projectH } = this.studio.project.settings || { width: 1920, height: 1080 };
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Calcula escala para caber na tela mantendo proporção
        const scaleFit = Math.min(canvas.width / projectW, canvas.height / projectH) * 0.7 * this.pancropZoom;
        
        ctx.save();
        ctx.translate(canvas.width/2, canvas.height/2);
        
        // Desenha Viewport (Tracejado)
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        const viewW = projectW * scaleFit;
        const viewH = projectH * scaleFit;
        ctx.strokeRect(-viewW/2, -viewH/2, viewW, viewH);
        ctx.setLineDash([]);

        // Label do Zoom
        ctx.fillStyle = "#555";
        ctx.font = "10px monospace";
        const zoomPct = Math.round(this.pancropZoom * 100);
        ctx.fillText(`${projectW}x${projectH} (${zoomPct}%)`, -viewW/2, -viewH/2 - 5);

        // Desenha Objeto
        const t = this.activeClip.transform;
        
        ctx.translate(t.x * scaleFit, t.y * scaleFit);
        ctx.rotate(t.rotation * Math.PI / 180);
        
        const objW = (projectW * (t.width / 100)) * scaleFit;
        const objH = (projectH * (t.height / 100)) * scaleFit;
        
        ctx.fillStyle = 'rgba(0, 120, 215, 0.2)';
        ctx.strokeStyle = '#0078d7';
        ctx.lineWidth = 2;
        ctx.fillRect(-objW/2, -objH/2, objW, objH);
        ctx.strokeRect(-objW/2, -objH/2, objW, objH);
        
        // Centro
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fill();

        // Handles (Cantos)
        const handleSize = 8;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#0078d7';
        
        const handles = [
            { x: -objW/2, y: -objH/2 },
            { x: objW/2, y: -objH/2 },
            { x: -objW/2, y: objH/2 },
            { x: objW/2, y: objH/2 }
        ];

        handles.forEach(h => {
            ctx.fillRect(h.x - handleSize/2, h.y - handleSize/2, handleSize, handleSize);
            ctx.strokeRect(h.x - handleSize/2, h.y - handleSize/2, handleSize, handleSize);
        });

        ctx.restore();
    }

    // =========================================================================
    // EVENTOS GERAIS E SISTEMA DE ARQUIVOS
    // =========================================================================

    _bindEvents() {
        const ALLOWED_EXTENSIONS = [
            'mp4', 'webm', 'mov', 'mkv', 'ogg', 'avi', // Vídeo
            'mp3', 'wav', 'ogg', 'aac', 'm4a',         // Áudio
            'png', 'jpg', 'jpeg', 'gif'                // Imagem
        ];

        document.getElementById("studio-upload").onchange = async (e) => {
            const files = Array.from(e.target.files);
            const validFiles = [];

            for (const file of files) {
                const parts = file.name.split('.');
                const ext = parts.length > 1 ? parts.pop().toLowerCase() : '';

                if (ALLOWED_EXTENSIONS.includes(ext)) {
                    validFiles.push(file);
                } else {
                    alert(`O formato de arquivo *.${ext} não é suportado pelo Studio.`);
                }
            }

            for (const f of validFiles) {
                await this.studio.assetManager.importAsset(f, f.name);
            }
            e.target.value = '';
        };

        document.getElementById("btn-studio-close").onclick = () => this.studio.toggleMode();

        document.addEventListener('keydown', (e) => {
            if (!this.studio.isActive) return;
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

            // Undo (Ctrl+Z)
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
                e.preventDefault();
                this.studio.historyManager.undo();
                this._refreshActiveModalState();
            }

            // Redo (Ctrl+Shift+Z ou Ctrl+Y)
            if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && e.code === 'KeyZ') || e.code === 'KeyY')) {
                e.preventDefault();
                this.studio.historyManager.redo();
                this._refreshActiveModalState();
            }
        });

        const btnGenSub = document.getElementById('btn-gen-subtitles');

        if (btnGenSub) {
            btnGenSub.onclick = () => this.openSubtitleModal();
        }
    }

    openSubtitleModal(existingClip = null) {
        const modal = document.getElementById('modal-subtitle-settings');
        const preview = document.getElementById('sub-preview-target');
        
        // Centraliza se for a primeira abertura (ou se estiver resetado)
        if (modal && (!modal.style.top || modal.style.top === "50%")) {
            const rect = modal.getBoundingClientRect();
            // Centraliza matematicamente baseado no tamanho inicial (450x600)
            modal.style.top = `${(window.innerHeight - 600)/2}px`;
            modal.style.left = `${(window.innerWidth - 450)/2}px`;
            modal.style.transform = "none";
        }

        // Ativa Dragging pelo novo ID do header
        this._makeDraggable(modal, "sub-header");

        const iFont = document.getElementById('sub-font-family');
        const iSize = document.getElementById('sub-font-size');
        const iColor = document.getElementById('sub-color');
        const iBg = document.getElementById('sub-bg-color');
        const iBold = document.getElementById('sub-bold');
        const iItalic = document.getElementById('sub-italic');

        const config = existingClip ? existingClip.subtitleConfig : {
            font: 'Arial', size: 30, color: '#ffffff', bgColor: '#000000', bold: false, italic: false
        };

        iFont.value = config.font;
        iSize.value = config.size;
        iColor.value = config.color;
        iBg.value = config.bgColor;
        iBold.checked = config.bold;
        iItalic.checked = config.italic;

        const updatePreview = () => {
            preview.style.fontFamily = iFont.value;
            preview.style.fontSize = iSize.value + "px";
            preview.style.color = iColor.value;
            preview.style.backgroundColor = iBg.value;
            preview.style.fontWeight = iBold.checked ? 'bold' : 'normal';
            preview.style.fontStyle = iItalic.checked ? 'italic' : 'normal';
        };
        
        [iFont, iSize, iColor, iBg, iBold, iItalic].forEach(el => el.oninput = updatePreview);
        updatePreview();

        modal.classList.remove('hidden');

        // LÓGICA DO BOTÃO DE TRANSCRIÇÃO
        const btnTranscribe = document.getElementById('btn-sub-transcribe');
        const progressBox = document.getElementById('sub-transcribe-progress');
        const progressBar = document.getElementById('sub-transcribe-bar');

        btnTranscribe.disabled = false;
        btnTranscribe.innerHTML = '<i class="fa-solid fa-play"></i>&nbsp; Iniciar Transcrição Automática';
        progressBox.style.display = 'none';

        btnTranscribe.onclick = async () => {
            if (!existingClip) {
                alert("Erro: O clipe precisa ser criado antes de transcrever.");
                return;
            }

            btnTranscribe.disabled = true;
            btnTranscribe.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>&nbsp; Ouvindo...';
            progressBox.style.display = 'block';

            try {
                await this.studio.runSubtitleTranscription(existingClip, (progress) => {
                    progressBar.style.width = `${progress}%`;
                });
                modal.classList.add('hidden'); 
            } catch (error) {
                console.error(error);
                alert("Erro na transcrição: " + error.message);
                btnTranscribe.disabled = false;
                btnTranscribe.innerHTML = '<i class="fa-solid fa-play"></i>&nbsp; Tentar Novamente';
            }
        };

        // Botão Salvar Estilo
        document.getElementById('btn-sub-confirm').onclick = () => {
            const newConfig = {
                font: iFont.value,
                size: parseInt(iSize.value),
                color: iColor.value,
                bgColor: iBg.value,
                bold: iBold.checked,
                italic: iItalic.checked
            };
            
            if (existingClip) {
                existingClip.subtitleConfig = newConfig;
                this.studio.timelineManager.renderTracks();
            }
            modal.classList.add('hidden');
        };

        document.getElementById('btn-sub-close').onclick = () => modal.classList.add('hidden');
        document.getElementById('btn-sub-cancel').onclick = () => modal.classList.add('hidden');
    }

    _bindTabEvents() {
        const tabs = document.querySelectorAll('.bin-tab');
        tabs.forEach(tab => {
            tab.onclick = () => {
                document.querySelectorAll('.bin-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                document.querySelectorAll('.bin-content').forEach(c => c.classList.add('hidden'));
                
                const targetId = tab.dataset.target;
                let contentElementId = null;

                switch (targetId) {
                    case 'bin-media': contentElementId = 'studio-bin-list'; break;
                    case 'bin-projects': contentElementId = 'studio-projects-list'; break;
                    case 'bin-generator': contentElementId = 'studio-generator-list'; break;
                }

                if (contentElementId) {
                    const targetContent = document.getElementById(contentElementId);
                    if (targetContent) targetContent.classList.remove('hidden');
                }
            };
        });
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
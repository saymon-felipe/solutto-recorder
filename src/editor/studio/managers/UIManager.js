export class UIManager {
    constructor(studio) {
        this.studio = studio;
    }

    buildUI() {
        const div = document.createElement("div");
        div.id = "studio-app";
        div.innerHTML = `
            <div class="studio-toolbar">
                <div style="font-weight:bold;">Solutto Studio</div>
                <div class="zoom-control">
                    <i class="fa-solid fa-minus"></i>
                    <input type="range" id="studio-zoom-slider" min="5" max="600" value="20">
                    <i class="fa-solid fa-plus"></i>
                </div>
                <div style="flex:1"></div>
                <button class="studio-btn" id="btn-studio-add"><i class="fa-solid fa-plus"></i> Add</button>
                <button class="studio-btn primary" id="btn-studio-render"><i class="fa-solid fa-file-export"></i> Renderizar</button>
                <button class="studio-btn" id="btn-studio-close"><i class="fa-solid fa-times"></i></button>
            </div>
            
            <div class="studio-workspace">
                <div class="studio-bin">
                    <div class="bin-header">Mídia</div>
                    <div class="bin-content" id="studio-bin-list"></div>
                </div>
                <div class="preview-container">
                    <div class="studio-preview">
                        <video id="studio-preview-video"></video>
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
                <div class="timeline-scroll-area" id="studio-scroll-area">
                    <div class="timeline-content-wrapper" id="timeline-content-wrapper">
                        <div class="timeline-ruler-container" id="timeline-ruler-container">
                            <div class="ruler-header-spacer"></div>
                            <div class="ruler-ticks"></div>
                        </div>
                        <div class="timeline-playhead-overlay" id="timeline-playhead">
                            <div class="playhead-knob"></div><div class="playhead-line"></div>
                        </div>
                        <div class="timeline-tracks" id="studio-tracks"></div>
                    </div>
                </div>
            </div>
            
            <div class="status-bar hidden" id="studio-status-bar">
                <div class="status-spinner"></div><span id="studio-status-text">Processando...</span>
            </div>

            <input type="file" id="studio-upload" multiple style="display:none" accept="video/*,audio/*,image/*">
        `;
        document.body.appendChild(div);
        this._bindEvents();
    }

    _bindEvents() {
        document.getElementById("btn-studio-add").onclick = () => document.getElementById("studio-upload").click();
        
        document.getElementById("btn-studio-close").onclick = () => this.studio.toggleMode();
        
        document.getElementById("studio-upload").onchange = async (e) => { 
            for(const f of e.target.files) await this.studio.assetManager.importAsset(f, f.name); 
        };

        document.getElementById('studio-zoom-slider').oninput = (e) => {
            this.studio.timelineManager.setZoom(parseInt(e.target.value));
        };
    }

    updateStatusBar(tasks) {
        const bar = document.getElementById('studio-status-bar');
        const text = document.getElementById('studio-status-text');
        const btn = document.getElementById('btn-studio-render');
        
        if (tasks.length > 0) {
            bar.classList.remove('hidden');
            const current = tasks[tasks.length - 1];
            text.innerText = `${current.label} (${tasks.length}...)`;
            if(btn) btn.disabled = true;
        } else {
            bar.classList.add('hidden');
            if(btn) btn.disabled = false;
        }
    }
}
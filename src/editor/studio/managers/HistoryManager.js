export class HistoryManager {
    constructor(studio) {
        this.studio = studio;
        this.undoStack = [];
        this.redoStack = [];
        this.maxHistory = 50; 
        this.isLocked = false; 
    }

    _createSnapshot() {
        return JSON.stringify({
            tracks: this.studio.project.tracks,
            duration: this.studio.project.duration,
            zoom: this.studio.project.zoom,
            selection: this.studio.timelineManager.selectedClips
        });
    }

    recordState() {
        if (this.isLocked) return;
        
        const currentState = this._createSnapshot();
        
        if (this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1] === currentState) {
            return;
        }

        this.undoStack.push(currentState);
        
        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }

        this.redoStack = [];
        console.log(`[History] Estado salvo. Undo: ${this.undoStack.length}`);
    }

    undo() {
        if (this.undoStack.length === 0) return;

        this.isLocked = true;
        
        const currentState = this._createSnapshot();
        this.redoStack.push(currentState);

        const previousStateJson = this.undoStack.pop();
        this._applyState(previousStateJson);
        
        this.isLocked = false;
        console.log(`[History] Undo aplicado. Restantes: ${this.undoStack.length}`);
    }

    redo() {
        if (this.redoStack.length === 0) return;

        this.isLocked = true;

        const currentState = this._createSnapshot();
        this.undoStack.push(currentState);

        const nextStateJson = this.redoStack.pop();
        this._applyState(nextStateJson);

        this.isLocked = false;
        console.log(`[History] Redo aplicado. Restantes: ${this.redoStack.length}`);
    }

    pushManualState(stateStr) {
        if (this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1] === stateStr) {
            return;
        }

        this.undoStack.push(stateStr);
        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }
        
        this.redoStack = []; 
        
        console.log(`[History] Estado manual salvo. Undo Stack: ${this.undoStack.length}`);
    }

    _applyState(jsonState) {
        try {
            const selectedIds = this.studio.timelineManager.selectedClips.map(s => s.clip.id);

            const state = JSON.parse(jsonState);
            this.studio.project.tracks = state.tracks;
            this.studio.project.duration = state.duration;

            this.studio.timelineManager.renderTracks();
            this.studio.timelineManager.renderRuler();
            this.studio.playbackManager.syncPreview();
            this.studio.timelineManager.selectedClips = state.selection;
            
            if (selectedIds.length > 0) {
                this.studio.project.tracks.forEach(track => {
                    track.clips.forEach(clip => {
                        if (selectedIds.includes(clip.id)) {
                            this.studio.timelineManager._addToSelection(clip, track.id, null);
                        }
                    });
                });
            }
            
        } catch (e) {
            console.error("[History] Erro crítico ao restaurar estado:", e);
            this.studio.timelineManager._clearSelection();
        }
    }
}
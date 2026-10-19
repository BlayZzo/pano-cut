// Nur für den automatischen Oberflächen-Test (`electron . --ui-test`): macht Projekt, Engine und Import erreichbar.
import { useProject } from './store/project';
import { useUi } from './store/ui';
import { engine } from './engine/instance';
import { addMediaToTimeline, importFiles } from './actions';

export function installTestHook(): void {
  (window as unknown as { __pcTest: unknown }).__pcTest = { useProject, useUi, engine, importFiles, addMediaToTimeline };
}

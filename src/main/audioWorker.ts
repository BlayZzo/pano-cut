// Hintergrund-Thread für Ton-Analysen (Takterkennung, Hüllkurven für die Mehrkamera-Synchronisierung),
// damit der Hauptprozess (und damit die Vorschau-Wiedergabe) nicht stockt.
import { parentPort, workerData } from 'node:worker_threads';
import { runAudioTask, type AudioTask } from './audioTasks';

const task = workerData as AudioTask;
try {
  const result = runAudioTask(task);
  parentPort?.postMessage({ ok: true, result });
} catch (e) {
  parentPort?.postMessage({ ok: false, error: (e as Error).message });
}

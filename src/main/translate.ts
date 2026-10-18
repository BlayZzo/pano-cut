// Übersetzung von Untertiteln über einen eigenen LibreTranslate-Server (freie Software, selbst betreibbar).
// Ohne Server kann PanoCut lokal mit whisper ins Englische übersetzen (siehe whisper.ts).
import { net } from 'electron';

export async function translateTexts(texts: string[], source: string, target: string, url: string, apiKey?: string): Promise<string[]> {
  const base = url.replace(/\/+$/, '');
  const out: string[] = [];
  // In Paketen übersetzen, damit der Server nicht überlastet wird
  for (let i = 0; i < texts.length; i += 25) {
    const chunk = texts.slice(i, i + 25);
    const res = await net.fetch(`${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: chunk, source: source || 'auto', target, format: 'text', api_key: apiKey || undefined }),
    });
    if (!res.ok) throw new Error(`Übersetzungs-Server antwortet mit ${res.status}`);
    const data = await res.json() as { translatedText: string | string[] };
    const arr = Array.isArray(data.translatedText) ? data.translatedText : [data.translatedText];
    out.push(...arr);
  }
  return out;
}

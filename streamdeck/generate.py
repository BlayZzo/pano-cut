#!/usr/bin/env python3
"""Erzeugt manifest.json und die Symbole des Stream-Deck-Plugins (einmalig, Ergebnis liegt im Repo).
Aufruf: python3 streamdeck/generate.py  (braucht Pillow und die Schrift DejaVu Sans)."""
import json, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, 'de.blayzzo.panocut.sdPlugin')
UUID = 'de.blayzzo.panocut'
ACCENT = (61, 214, 193, 255)
BG = (22, 26, 34, 255)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

# (Aktion = Pfad in PanoCut /action/<id>, Name, kurzer Tastentext, Symbol, Tooltip)
ACTIONS = [
    ('playpause', 'Abspielen / Pause', 'Play', '@playpause', 'Wiedergabe starten oder anhalten'),
    ('split', 'Schneiden', 'Schnitt', '✂', 'Clip an der Abspielposition schneiden'),
    ('delete', 'Löschen', 'Löschen', '⌫', 'Ausgewählte Clips löschen'),
    ('undo', 'Rückgängig', 'Zurück', '↶', 'Letzten Schritt rückgängig machen'),
    ('redo', 'Wiederholen', 'Vor', '↷', 'Rückgängig gemachten Schritt wiederholen'),
    ('markin', 'Anfang markieren', 'In', '⇤', 'Anfang des Bereichs setzen (wie Taste I)'),
    ('markout', 'Ende markieren', 'Out', '⇥', 'Ende des Bereichs setzen (wie Taste O)'),
    ('clearrange', 'Markierung löschen', 'Bereich ✕', '⊘', 'Bereichsmarkierung entfernen'),
    ('prevframe', 'Bild zurück', '−1 Bild', '◀', 'Ein Einzelbild zurück'),
    ('nextframe', 'Bild vor', '+1 Bild', '▶', 'Ein Einzelbild vor'),
    ('gostart', 'Zum Anfang', 'Anfang', '@gostart', 'Abspielkopf zum Anfang'),
    ('goend', 'Zum Ende', 'Ende', '@goend', 'Abspielkopf zum Ende'),
    ('loop', 'Schleife', 'Schleife', '⟳', 'Wiedergabe wiederholen an/aus'),
    ('duplicate', 'Duplizieren', 'Kopie', '@duplicate', 'Ausgewählte Clips duplizieren'),
    ('zoomin', 'Timeline vergrößern', 'Zoom +', '⊕', 'Timeline vergrößern'),
    ('zoomout', 'Timeline verkleinern', 'Zoom −', '⊖', 'Timeline verkleinern'),
    ('zoomfit', 'Timeline einpassen', 'Einpassen', '↔', 'Ganze Timeline anzeigen'),
    ('autoenhance', 'Natürlich schön', 'Auto-Bild', '✦', 'Bild des ausgewählten Clips automatisch verbessern'),
    ('ai', 'KI-Info', 'KI', '◎', 'KI-Bereich öffnen (Objekte erkennen)'),
    ('import', 'Importieren', 'Import', '⇩', 'Medien importieren'),
    ('save', 'Speichern', 'Sichern', '⬇', 'Projekt speichern'),
    ('export', 'Exportieren', 'Export', '⇪', 'Export-Fenster öffnen'),
]

def glyph_font(size):
    return ImageFont.truetype(FONT, size)

def draw_centered(d, xy, text, font, fill):
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    d.text((xy[0] - (l + r) / 2, xy[1] - (t + b) / 2), text, font=font, fill=fill)

def draw_symbol(d, sym, cx, cy, h, fill):
    """Zeichnet ein Symbol mittig; '@name' = selbst gezeichnete Form (fehlt in der Schrift)."""
    if not sym.startswith('@'):
        draw_centered(d, (cx, cy), sym, glyph_font(round(h)), fill)
        return
    r = h * 0.42
    lw = max(1, round(h * 0.08))
    if sym == '@playpause':
        d.polygon([(cx - r, cy - r * 0.8), (cx - r, cy + r * 0.8), (cx + r * 0.15, cy)], fill=fill)
        bw = r * 0.22
        for x in (cx + r * 0.35, cx + r * 0.78):
            d.rectangle([x, cy - r * 0.8, x + bw, cy + r * 0.8], fill=fill)
    elif sym in ('@gostart', '@goend'):
        sgn = -1 if sym == '@gostart' else 1
        bar_x = cx + sgn * r * 0.9
        d.rectangle([min(bar_x, bar_x - sgn * r * 0.22), cy - r * 0.8, max(bar_x, bar_x - sgn * r * 0.22), cy + r * 0.8], fill=fill)
        for off in (0, r * 0.75):
            tip = cx + sgn * (r * 0.62 - off)
            back = tip - sgn * r * 0.8
            d.polygon([(back, cy - r * 0.8), (back, cy + r * 0.8), (tip, cy)], fill=fill)
    elif sym == '@duplicate':
        w = r * 1.15
        d.rounded_rectangle([cx - r, cy - r, cx - r + w, cy - r + w], radius=r * 0.15, outline=fill, width=lw)
        d.rounded_rectangle([cx + r - w, cy + r - w, cx + r, cy + r], radius=r * 0.15, fill=fill)

def key_image(sym, label, size):
    s = size / 144
    img = Image.new('RGBA', (size, size), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([6 * s, 6 * s, size - 6 * s, size - 6 * s], radius=18 * s, outline=(42, 49, 64, 255), width=max(1, round(2 * s)))
    draw_symbol(d, sym, size / 2, 60 * s, 64 * s, ACCENT)
    f = ImageFont.truetype(FONT_BOLD, round(19 * s))
    draw_centered(d, (size / 2, 118 * s), label, f, (230, 233, 239, 255))
    return img

def list_icon(sym, size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_symbol(d, sym, size / 2, size / 2, size * 0.85, (255, 255, 255, 255))
    return img

def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)

def main():
    version = json.load(open(os.path.join(HERE, '..', 'package.json')))['version']
    actions = []
    for aid, name, label, sym, tip in ACTIONS:
        base = f'imgs/actions/{aid}'
        save(list_icon(sym, 20), os.path.join(PLUGIN, base + '.png'))
        save(list_icon(sym, 40), os.path.join(PLUGIN, base + '@2x.png'))
        save(key_image(sym, label, 72), os.path.join(PLUGIN, base + '-key.png'))
        save(key_image(sym, label, 144), os.path.join(PLUGIN, base + '-key@2x.png'))
        actions.append({
            'UUID': f'{UUID}.{aid}', 'Name': name, 'Tooltip': tip, 'Icon': base,
            'States': [{'Image': base + '-key', 'ShowTitle': False}],
            'Controllers': ['Keypad'], 'SupportedInMultiActions': True,
        })
    # Plugin- und Kategorie-Symbol aus dem App-Symbol
    logo = Image.open(os.path.join(HERE, '..', 'build', 'icon.png')).convert('RGBA')
    for n, sz in (('plugin', 28), ('plugin@2x', 56), ('category', 28), ('category@2x', 56), ('marketplace', 256)):
        save(logo.resize((sz, sz), Image.LANCZOS), os.path.join(PLUGIN, 'imgs', n + '.png'))
    manifest = {
        'Name': 'PanoCut',
        'Version': f'{version}.0',
        'Author': 'BlayZzo',
        'Description': 'Steuert den Videoeditor PanoCut: Abspielen, Schneiden, Markieren, Rückgängig, Export, KI und mehr.',
        'URL': 'https://github.com/BlayZzo/pano-cut',
        'Icon': 'imgs/marketplace',
        'Category': 'PanoCut',
        'CategoryIcon': 'imgs/category',
        'CodePath': 'bin/plugin.js',
        'Nodejs': {'Version': '20', 'Debug': 'disabled'},
        'SDKVersion': 2,
        'Software': {'MinimumVersion': '6.4'},
        'OS': [{'Platform': 'mac', 'MinimumVersion': '12'}, {'Platform': 'windows', 'MinimumVersion': '10'}],
        'UUID': UUID,
        'Actions': actions,
    }
    with open(os.path.join(PLUGIN, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write('\n')

if __name__ == '__main__':
    main()

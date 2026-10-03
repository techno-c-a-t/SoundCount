#!/usr/bin/env python3
"""
Build script to package SoundCount into a standalone, serverless deploy/ folder.
Ready for 1-click GitHub Pages deployment or any static web hosting.
"""

import os
import shutil
import json

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEPLOY_DIR = os.path.join(ROOT_DIR, "deploy")
AUDIO_DIR = os.path.join(DEPLOY_DIR, "audio")
PUBLIC_DIR = os.path.join(ROOT_DIR, "visualization", "public")
DATA_INPUT_DIR = os.path.join(ROOT_DIR, "data", "input")

def build_deploy():
    print(f"📦 Packaging SoundCount for standalone serverless deployment...")
    print(f"Target directory: {DEPLOY_DIR}")

    # 1. Ensure directories exist
    os.makedirs(AUDIO_DIR, exist_ok=True)

    # 2. Copy audio file
    src_audio = os.path.join(DATA_INPUT_DIR, "test_music.mp3")
    dst_audio = os.path.join(AUDIO_DIR, "test_music.mp3")
    if os.path.exists(src_audio):
        shutil.copy2(src_audio, dst_audio)
        print(f"  ✅ Audio copied: audio/test_music.mp3 ({os.path.getsize(dst_audio) / (1024*1024):.2f} MB)")
    else:
        print(f"  ❌ Error: {src_audio} not found!")

    # 3. Read & optimize analysis.json (reducing from 28MB to ~7MB with precision rounding)
    src_json = os.path.join(PUBLIC_DIR, "analysis.json")
    dst_json = os.path.join(DEPLOY_DIR, "analysis.json")
    if os.path.exists(src_json):
        print(f"  ⚡ Optimizing analysis.json...")
        with open(src_json, "r", encoding="utf-8") as f:
            d = json.load(f)

        def round_data(obj, dec=3):
            if isinstance(obj, float):
                return round(obj, dec)
            elif isinstance(obj, list):
                return [round_data(x, dec) for x in obj]
            elif isinstance(obj, dict):
                return {k: round_data(v, dec) for k, v in obj.items()}
            return obj

        d_opt = {}
        for k, v in d.items():
            if k == 'spectrogram_db':
                # 0.1 dB precision is plenty for visual spectrogram and saves ~10MB
                d_opt[k] = [[round(x, 1) for x in row] for row in v]
            elif k in ['times', 'spectral_flux', 'threshold', 'peaks_sec', 'complex_domain', 'cd_peaks_sec']:
                d_opt[k] = round_data(v, 3)
            elif k in ['global_track', 'multiband']:
                d_opt[k] = round_data(v, 3)
            else:
                d_opt[k] = v

        with open(dst_json, "w", encoding="utf-8") as f:
            json.dump(d_opt, f, separators=(',', ':'))

        orig_mb = os.path.getsize(src_json) / (1024 * 1024)
        opt_mb = os.path.getsize(dst_json) / (1024 * 1024)
        print(f"  ✅ analysis.json optimized: {orig_mb:.1f} MB ➔ {opt_mb:.1f} MB (fast loading)")

    # 4. Copy CSS and JS
    shutil.copy2(os.path.join(PUBLIC_DIR, "styles.css"), os.path.join(DEPLOY_DIR, "styles.css"))
    shutil.copy2(os.path.join(PUBLIC_DIR, "game_app.js"), os.path.join(DEPLOY_DIR, "game_app.js"))
    shutil.copy2(os.path.join(PUBLIC_DIR, "app.js"), os.path.join(DEPLOY_DIR, "app.js"))
    print(f"  ✅ Assets copied: styles.css, game_app.js, app.js")

    # 5. HTML files
    # game.html -> index.html (the default landing page for GitHub Pages)
    with open(os.path.join(PUBLIC_DIR, "game.html"), "r", encoding="utf-8") as f:
        game_html = f.read()
    
    with open(os.path.join(DEPLOY_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(game_html)
    
    with open(os.path.join(DEPLOY_DIR, "game.html"), "w", encoding="utf-8") as f:
        f.write(game_html)
    print(f"  ✅ HTML: deploy/index.html & deploy/game.html generated")

    # math.html -> deploy/math.html (update link to index.html)
    with open(os.path.join(PUBLIC_DIR, "math.html"), "r", encoding="utf-8") as f:
        math_html = f.read()
    math_html = math_html.replace('href="game.html"', 'href="index.html"')
    with open(os.path.join(DEPLOY_DIR, "math.html"), "w", encoding="utf-8") as f:
        f.write(math_html)
    print(f"  ✅ HTML: deploy/math.html generated")

    # 6. Deploy README.md
    readme_content = """# 🎹 SoundCount — Mobile Piano Tiles & DSP Engine (Serverless Demo)

Полностью автономная клиентская сборка игры **SoundCount**. Не требует серверного бэкенда или Python — работает на 100% в браузере (HTML5 Canvas + Web Audio API).

## 🚀 Публикация на GitHub Pages

### Вариант 1: Сделать эту папку отдельным репозиторием
1. Скопируйте всё содержимое папки `deploy/` в корень нового GitHub-репозитория (или инициализируйте git прямо в ней).
2. Запушьте в ветку `main`.
3. В GitHub перейдите в **Settings** ➔ **Pages**:
   - **Source**: `Deploy from a branch`
   - **Branch**: `main`, папка `/ (root)`
   - Нажмите **Save**.
4. Через 30 секунд игра доступна по адресу `https://<ваш-логин>.github.io/<имя-репозитория>/`!

### Вариант 2: Запуск локально
Любым статическим веб-сервером:
```bash
# Python
python3 -m http.server 8000

# Node.js
npx serve .
```
Откройте в браузере `http://localhost:8000/`.

## 🎮 Режимы игры
- **🤠 Ковбой**: множители серии по Фибоначчи до x10, штраф за промахи, перфект +3.
- **🗿 Стэтхем**: «Одна ошибка — и ты ошибся» (внезапная смерть при любой ошибке), множитель +0.5, перфект +8.
- **🧘 Дзен**: множитель = скорость × 3, штраф = половина попадания, перфект +2.
"""
    with open(os.path.join(DEPLOY_DIR, "README.md"), "w", encoding="utf-8") as f:
        f.write(readme_content)
    print(f"  ✅ Documentation: deploy/README.md generated")

    # 7. Root redirect index.html
    root_index = os.path.join(ROOT_DIR, "index.html")
    root_index_content = """<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0; url=deploy/index.html">
  <title>SoundCount Redirect</title>
  <script>window.location.replace("deploy/index.html");</script>
</head>
<body style="background:#0f172a;color:#38bdf8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <p>Запуск игры SoundCount... Если переход не произошел, <a href="deploy/index.html" style="color:#38bdf8;font-weight:bold;">нажмите сюда</a>.</p>
</body>
</html>
"""
    with open(root_index, "w", encoding="utf-8") as f:
        f.write(root_index_content)
    print(f"  ✅ Root redirect: index.html ➔ deploy/index.html generated")

    print("\n✨ Готово! Все файлы собраны в автономной папке deploy/.")

if __name__ == "__main__":
    build_deploy()

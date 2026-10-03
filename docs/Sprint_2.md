# SoundCount: Спринт 2 — Инженерная Архитектура и Генерация Ритм-Чарта

Документ описывает техническую реализацию алгоритмов разбора аудио, фазового анализа, блокировки частотных коридоров, классификации Hold-нот и Витерби-маппинга Спринта 2.

---

## 🛠️ 1. Реализованные Модули и Стек

- **`src/novelty/complex_domain.py`**: Расчет фазовой рассинхронизации $CD[m] = \sum |C - \hat{C}|$ для выявления вокальных и плавных инструментальных атак.
- **`src/pitch_detection/event_band_estimator.py`**: 4 перекрывающихся диапазона (~35% ширины) с динамической блокировкой 15–25% частотных коридоров на 200–400 мс.
- **`src/pitch_detection/hold_detector.py`**: Анализ сохранения энергии $S(m, k_{\text{peak}}) \ge \gamma A_0$ с гистерезисом для выделения длинных Hold-нот (>1.0с).
- **`src/chart_generator/viterbi_mapper.py`**: Динамическое программирование Витерби для распределения нот по 4 дорожкам с учетом штрафов высоты тона, быстрой стрельбы и перекрытия Hold-слайдеров.
- **`visualization/data_exporter.py`**: Интегрированный конвейер экспорта данных Спринта 1 и 2 в `analysis.json`.
- **`visualization/public/app.js`**: 60 FPS рендеринг Tap-плиток и Hold-слайдеров на Canvas.

---

## 🏗️ 2. Архитектура Конвейера Спринта 2

```
[src/parsing/cqt.py]
       │
       ├─────────────────────────────────┐
       ▼                                 ▼
[src/novelty/spectral_flux.py]   [src/novelty/complex_domain.py]
       │                                 │
       └────────────────┬────────────────┘
                        ▼
    [src/pitch_detection/event_band_estimator.py]
    (4 Overlapping Bands + Frequency Corridor Blocking)
                        │
                        ▼
    [src/pitch_detection/hold_detector.py]
    (Energy Sustain Tracking -> Tap vs Hold >1.0s)
                        │
                        ▼
    [src/chart_generator/viterbi_mapper.py]
    (Viterbi DP 4-Lane Chart Builder)
                        │
                        ▼
    [visualization/data_exporter.py] ──> analysis.json
                        │
                        ▼
    [visualization/public/app.js] (60 FPS Canvas UI: Tap & Hold Sliders)
```

---

## ⚡ 3. Ключевые Инженерные Особенности

1. **Фазовое отслеживание в комплексной области**:
   Экстраполированная фаза $\phi_{\text{pred}}(m,k) = 2\phi(m-1,k) - \phi(m-2,k)$ позволяет обнаруживать срывы фазы даже при низком притоке амплитуды.
2. **Частотная блокировка коридоров**:
   При появлении доминирующей ноты на коридор бинов $[k_{\text{event}}-\Delta k, k_{\text{event}}+\Delta k]$ накладывается динамическая маска на $\Delta t_{\text{block}}$, освобождая остальные 3 дорожки.
3. **Витерби-маппер**:
   Использует матрицу стоимости $C_{\text{pitch}} + \lambda C_{\text{trans}}$, исключая физически неиграбельный "дребезг" на одной дорожке и окклюзию активных Hold-нот.
4. **Рендеринг Hold-слайдеров**:
   В `app.js` длинные Hold-ноты отрисовываются полупрозрачными протяженными прямоугольными блоками с головной и хвостовой каппой, поддерживая анимацию удержания при совпадении с линией таргета.

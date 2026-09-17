# TASKS: Текущий статус и Активные задачи

## 📌 Текущий статус
- **Текущий этап**: Этап 1 (DSP Onset Baseline & Web Visualization) — **ЗАВЕРШЕН**.
- **Фокус MVP**: Модули препроцессинга, CQT-спектрограммы, многополосного ReLU Spectral Flux (4 полосы) с 3s скользящей нормализацией, генерации JSON и 60 FPS просмотрщика ритм-игры Piano Tiles (движение атак справа налево с эффектом вспышек).
- **Будущие фичи**: Вынесены в [IDEAS.md](file:///home/technocat/Документы/Projects/SoundCount/IDEAS.md).

---

## 📋 Спринт 1: Ингестия (.mp3/.m4a), Детекция атак и Визуализатор

### Выполнено
- [x] Настройка структуры проекта и окружения Python (`scipy`, `numpy`, `librosa`, `soundfile`).
- [x] **Task 1.1**: Модуль `src/preprocessing/ingest.py` — декодирование аудио в моно PCM 22050 Гц.
- [x] **Task 1.2**: Модуль `src/parsing/cqt.py` — вычисление 84-биновой CQT-спектрограммы (C1–C8).
- [x] **Task 1.3**: Модуль `src/novelty/spectral_flux.py` — расчёт 4-полосной функции новизны с 3s скользящей нормализацией.
- [x] **Task 1.4**: Модуль `src/novelty/spectral_flux.py` (peak_picker) — адаптивный порог $\delta[m] = \mu[m] + \alpha\sigma[m] + \beta$ и временные метки атак $T_{\text{attacks}}$.
- [x] **Task 1.5**: Модуль `visualization/data_exporter.py` и Веб-визуализатор (`visualization/server.py` + `visualization/public/`):
  - 2D CQT Спектрограмма (Canvas).
  - 4 параллельные кривые новизны $SF_b[m]$ (Bass, Tenor, Alto, Soprano).
  - 🎮 **Piano Tiles Demo Visualizer (60 FPS)**: 4 горизонтальные дорожки, вертикальные линии атак спавнятся справа за 3 секунды до ноты, движутся справа налево и вспыхивают ярким ореолом на линии нажатия ровно в момент звучания звука!
  - Динамический гистограммный срез кадра $m(t)$ в реальном времени.

---

## 📈 Бэклог следующих этапов

- [ ] **Pitch Extractor (YIN / NMF / Basic-Pitch)**
- [ ] **Viterbi Lane Mapper (4-lane DP)**
- [ ] **Экспорт готового уровня в `chart.json`**
